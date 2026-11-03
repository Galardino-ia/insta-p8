import { type NextRequest, NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase-server"
import { sendTextDM, sendCardDM, sendMediaDM, replyToComment } from "@/lib/instagram-api"

const GRAPH = "https://graph.instagram.com/v24.0"
const POLL_SECRET = process.env.POLL_SECRET || process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN

function keywordMatches(triggerValue: string, text: string): boolean {
  const lower = text.toLowerCase()
  const keywords = triggerValue.split(",")
  for (let i = 0; i < keywords.length; i++) {
    const k = keywords[i].trim().toLowerCase()
    if (k && lower.indexOf(k) !== -1) return true
  }
  return false
}

function parseContent(raw: any): any {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw)
    } catch (e) {
      return { message: raw }
    }
  }
  return raw
}

function getPublicReply(content: any): string {
  const defaults = ["Check your DMs!", "Sent! Check inbox!"]
  if (content.public_replies && content.public_replies.length > 0) {
    const valid = content.public_replies.filter(function (r: any) { return r })
    if (valid.length > 0) return valid[Math.floor(Math.random() * valid.length)]
  }
  return defaults[Math.floor(Math.random() * defaults.length)]
}

async function igGet(path: string, token: string): Promise<any> {
  const sep = path.indexOf("?") !== -1 ? "&" : "?"
  const res = await fetch(GRAPH + "/" + path + sep + "access_token=" + token, {
    signal: AbortSignal.timeout(15000),
  })
  return res.json()
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  const manualSecret = request.nextUrl.searchParams.get("secret")
  const isCron = cronSecret && authHeader === "Bearer " + cronSecret
  const isManual = POLL_SECRET && manualSecret && manualSecret === POLL_SECRET
  if (!isCron && !isManual) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = await getSupabaseServerClient()
  const results: any[] = []

  try {
    const usersRes = await supabase.from("users").select("id, username, access_token")
    const users = usersRes.data || []

    for (let u = 0; u < users.length; u++) {
      const user = users[u]
      if (!user.access_token) continue

      const autoRes = await supabase
        .from("automations")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .eq("trigger_source", "comment")
      const automations = autoRes.data || []
      if (automations.length === 0) continue

      const mediaData = await igGet("me/media?fields=id,timestamp&limit=10", user.access_token)
      if (mediaData.error) {
        results.push({ user: user.username, error: "media fetch failed" })
        continue
      }
      const mediaList = mediaData.data || []

      for (let m = 0; m < mediaList.length; m++) {
        const media = mediaList[m]
        const commentsData = await igGet(
          media.id + "/comments?fields=id,text,username,timestamp&limit=50",
          user.access_token
        )
        if (commentsData.error) continue
        const commentList = commentsData.data || []

        for (let c = 0; c < commentList.length; c++) {
          const comment = commentList[c]
          const commentText = (comment.text || "").toLowerCase().trim()
          if (!commentText) continue
          if (comment.username && comment.username.toLowerCase() === user.username.toLowerCase()) continue

          let alreadyProcessed = false
          try {
            const existRes = await supabase
              .from("poll_processed_comments")
              .select("comment_id")
              .eq("comment_id", comment.id)
              .single()
            alreadyProcessed = !!existRes.data
          } catch (e) {}
          if (alreadyProcessed) continue

          try {
            await supabase.from("poll_processed_comments").insert({
              comment_id: comment.id,
              user_id: user.id,
              media_id: media.id,
            })
          } catch (e) {}

          let match = null
          for (let a = 0; a < automations.length; a++) {
            const auto = automations[a]
            if (auto.specific_media_id === media.id && auto.trigger_type === "reply_all") {
              match = auto
              break
            }
          }
          if (!match) {
            for (let a = 0; a < automations.length; a++) {
              const auto = automations[a]
              if (
                auto.specific_media_id === media.id &&
                auto.trigger_type === "keyword" &&
                keywordMatches(auto.trigger_value || "", commentText)
              ) {
                match = auto
                break
              }
            }
          }
          if (!match) {
            for (let a = 0; a < automations.length; a++) {
              const auto = automations[a]
              if (
                !auto.specific_media_id &&
                auto.trigger_type === "keyword" &&
                keywordMatches(auto.trigger_value || "", commentText)
              ) {
                match = auto
                break
              }
            }
          }
          if (!match) continue

          const content = parseContent(match.response_content)
          const replyMode = content.reply_mode || "both"

          if (replyMode !== "dm_only") {
            await replyToComment(user.access_token, comment.id, getPublicReply(content))
          }

          if (replyMode !== "public_only") {
            const recipient = { comment_id: comment.id }
            if (content.media && content.media.url) {
              await sendMediaDM(user.access_token, recipient, content.media.type || "image", content.media.url)
              if (content.message) {
                await sendTextDM(user.access_token, recipient, content.message)
              }
            } else if (content.card) {
              await sendCardDM(user.access_token, recipient, content.card)
            } else if (content.message) {
              await sendTextDM(user.access_token, recipient, content.message)
            }
          }

          results.push({ user: user.username, from: comment.username, automation: match.name, status: "sent" })
        }
      }
    }

    return NextResponse.json({ success: true, results: results })
  } catch (error: any) {
    return NextResponse.json({ error: "poll failed" }, { status: 500 })
  }
}
