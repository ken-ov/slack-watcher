# Slack User Token (xoxp) — How to Create It and Use It in Node.js

This guide covers getting the `SLACK_USER_TOKEN` that slack-watcher needs, and the two ways to call the Slack Web API from Node.js.

## 1. Create the token

Official guides:

| What | Link |
|---|---|
| Quickstart: create an app, request scopes, install, get tokens | https://api.slack.com/quickstart |
| App management page | https://api.slack.com/apps |
| Token types explained (bot `xoxb` vs user `xoxp`) | https://api.slack.com/concepts/token-types |
| All available scopes | https://api.slack.com/scopes |
| OAuth flow in depth (install / reinstall mechanics) | https://api.slack.com/authentication/oauth-v2 |

Steps:

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch** → pick your workspace.
2. Open **OAuth & Permissions** → scroll to **Scopes** → add scopes under **User Token Scopes** (⚠️ not Bot Token Scopes — only user scopes produce an `xoxp-…` token):
   - `search:read` — find messages that mention you (required)
   - `chat:write` — post messages as you (required)
   - `channels:history`, `groups:history`, `im:history`, `mpim:history` — read conversation context around a mention (recommended)
   - `users:read` — resolve `@username` to a user ID for DMs via `send.js` (optional)
3. Scroll up → **Install to Workspace** → **Allow**.
   - If your workspace requires app approval, the button says **Request to Install** — ask an admin. The app only acts as *you* (user scopes), which usually makes approval easy.
4. Copy the **User OAuth Token** (`xoxp-…`) shown on the OAuth & Permissions page.
5. Adding scopes later? Add them, then click **Reinstall to Workspace** — and re-copy the token if it changed.

Keep the token in a gitignored `.env` file. It can do anything you can do on Slack — never commit it, never paste it into a channel.

## 2. Use it in Node.js

### Option A — official SDK (`@slack/web-api`)

Docs: https://tools.slack.dev/node-slack-sdk/web-api/ · GitHub: https://github.com/slackapi/node-slack-sdk

```js
import { WebClient } from "@slack/web-api";

const slack = new WebClient(process.env.SLACK_USER_TOKEN);

await slack.chat.postMessage({ channel: "#dev-channel", text: "hello" });

// search.messages only works with a user token (xoxp)
const res = await slack.search.messages({ query: "<@U123ABC>" });
```

### Option B — no dependencies, plain `fetch` (what slack-watcher does)

The Web API is just HTTPS + a Bearer token. See [`src/slack.js`](../src/slack.js) for a full client with 429 retry.

```js
const res = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.SLACK_USER_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ channel: "#dev-channel", text: "hello" }),
});
const body = await res.json();
if (!body.ok) throw new Error(body.error); // Slack returns 200 even on failure — always check body.ok
```

GET methods take query params instead:

```js
const qs = new URLSearchParams({ query: "<@U123ABC>", count: "50" });
const search = await fetch(`https://slack.com/api/search.messages?${qs}`, {
  headers: { Authorization: `Bearer ${process.env.SLACK_USER_TOKEN}` },
}).then((r) => r.json());
```

### Method reference

Every API method is documented at https://api.slack.com/methods — each page lists required scopes, params, and sample responses. The ones this project uses:

- https://api.slack.com/methods/search.messages
- https://api.slack.com/methods/chat.postMessage
- https://api.slack.com/methods/conversations.history
- https://api.slack.com/methods/conversations.replies
- https://api.slack.com/methods/auth.test

## Gotchas

- `search.messages` rejects bot tokens — you need `xoxp` with `search:read`.
- Slack search renders mentions as `<@U123|Display Name>`, not bare `<@U123>` — match both.
- Rate limits are per-method tiers (https://api.slack.com/apis/rate-limits); on HTTP 429, wait `Retry-After` seconds and retry.
- Messages posted with a user token appear **as you** — there is no bot identity.
