const SLACK_API = "https://slack.com/api";
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(token, method, params, { httpMethod = "POST" } = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    if (httpMethod === "GET") {
      const qs = new URLSearchParams(params).toString();
      response = await fetch(`${SLACK_API}/${method}?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } else {
      response = await fetch(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(params),
      });
    }

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") || "5", 10);
      await sleep((retryAfter + 1) * 1000);
      continue;
    }

    const body = await response.json();
    if (!body.ok) {
      throw new Error(`Slack ${method} failed: ${body.error}`);
    }
    return body;
  }
  throw new Error(`Slack ${method} failed: rate limited after ${MAX_RETRIES} retries`);
}

/** Render fetched context as a prompt block. Empty string when there is nothing useful. */
export function formatConversationContext(context, mention, selfId) {
  if (!context || !context.messages.length || (context.messages.length === 1 && context.messages[0].ts === mention.ts)) {
    return "";
  }
  const lines = context.messages.map((m) => {
    const who =
      m.ts === mention.ts
        ? ">>> [the mention] "
        : m.user === selfId
          ? "[me] "
          : m.user === mention.user
            ? "[requester] "
            : `[<@${m.user}>] `;
    return who + m.text;
  });
  return `
Conversation context around the mention (oldest first; the requester often splits one request across several short messages — read them as a whole):
"""
${lines.join("\n").slice(0, 4000)}
"""
`;
}

export function createSlackClient(token) {
  return {
    async whoAmI() {
      const { user_id, user, team } = await call(token, "auth.test", {});
      return { userId: user_id, userName: user, team };
    },

    async searchMentions(query, count = 50) {
      const body = await call(
        token,
        "search.messages",
        { query, sort: "timestamp", sort_dir: "desc", count: String(count) },
        { httpMethod: "GET" },
      );
      return body.messages?.matches ?? [];
    },

    /**
     * Pull conversation context around a mention: the full thread if the mention
     * is a thread reply, otherwise nearby channel messages (±windowSeconds).
     * Requires history scopes (channels/groups/im/mpim:history); degrades to
     * {messages: [], error} when the token lacks them.
     */
    async fetchContext(match, windowSeconds = 900) {
      const channelId = match.channel?.id;
      if (!channelId) return { messages: [], error: "no channel id", kind: "none" };
      try {
        const threadTs = match.permalink?.match(/thread_ts=(\d+\.\d+)/)?.[1];
        const kind = threadTs ? "thread" : "channel";
        let messages;
        if (threadTs) {
          const body = await call(
            token,
            "conversations.replies",
            { channel: channelId, ts: threadTs, limit: "50" },
            { httpMethod: "GET" },
          );
          messages = body.messages ?? [];
        } else {
          const ts = Number.parseFloat(match.ts);
          const body = await call(
            token,
            "conversations.history",
            {
              channel: channelId,
              oldest: String(ts - windowSeconds),
              latest: String(ts + windowSeconds),
              inclusive: "true",
              limit: "30",
            },
            { httpMethod: "GET" },
          );
          messages = (body.messages ?? []).reverse(); // history returns newest first
        }
        return {
          messages: messages
            .filter((m) => (m.type === "message" || !m.type) && m.text)
            .map((m) => ({ user: m.user, ts: m.ts, text: m.text.slice(0, 500) })),
          error: null,
          kind,
        };
      } catch (err) {
        return { messages: [], error: err.message, kind: "none" };
      }
    },

    /** Post to any conversation: channel ID, #channel-name, user ID (DM), or group ID. */
    async post(channel, text) {
      const body = await call(token, "chat.postMessage", {
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      return body.channel;
    },

    /** Resolve @username / display name / real name → user ID. Requires users:read scope. */
    async resolveUserId(handle) {
      const name = handle.replace(/^@/, "").toLowerCase();
      let cursor;
      do {
        const body = await call(
          token,
          "users.list",
          { limit: "200", ...(cursor ? { cursor } : {}) },
          { httpMethod: "GET" },
        );
        const hit = (body.members ?? []).find(
          (u) =>
            !u.deleted &&
            (u.name?.toLowerCase() === name ||
              u.profile?.display_name?.toLowerCase() === name ||
              u.profile?.real_name?.toLowerCase() === name),
        );
        if (hit) return hit.id;
        cursor = body.response_metadata?.next_cursor || null;
      } while (cursor);
      throw new Error(`user not found: ${handle}`);
    },

    async postToSelf(userId, text) {
      // chat.postMessage accepts a user ID directly for the self-DM — avoids
      // conversations.open, which would require the extra im:write scope.
      const body = await call(token, "chat.postMessage", {
        channel: userId,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      return body.channel;
    },

    /** Public thread reply AS THE USER — only used after an explicit per-feature opt-in (e.g. PR review confirmations). */
    async replyInThread(channel, threadTs, text) {
      await call(token, "chat.postMessage", {
        channel,
        text,
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      });
    },

    /** Messages in a conversation since oldestTs — used to catch a manual "stop" reply in the self-DM. */
    async fetchMessagesSince(channelId, oldestTs) {
      const body = await call(
        token,
        "conversations.history",
        { channel: channelId, oldest: String(oldestTs), limit: "20" },
        { httpMethod: "GET" },
      );
      return body.messages ?? [];
    },
  };
}
