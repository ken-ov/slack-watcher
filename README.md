# slack-watcher

A personal Slack → Claude Code automation daemon. It watches Slack for messages that need you and turns them into work.

## Features

| Incoming message | What the watcher does |
|---|---|
| "@you fix the price filter on the listing page" | Spawns a headless [Claude Code](https://claude.com/claude-code) worker in a **disposable git worktree** → implements the fix → runs tests/lint → opens a **draft PR** targeting your integration branch |
| "Please review this PR: github.com/…/pull/123" (mention optional) | Reviews the PR → posts **inline comments on the exact changed lines** with ```suggestion``` blocks (real bugs only, minor nits skipped, plain English) → replies in the Slack thread |
| "@you when do we deploy?" | Drafts an answer using your repos/docs as context → DMs it to you privately — you review and paste |
| "@you fix the bug" (too vague) | DMs you 1-3 ready-to-send clarifying questions instead of guessing |
| "thanks @you!" / FYI / status update | Ignored — nothing happens |

Built-in guardrails and quality-of-life:

- **Near real-time without a server or admin rights** — polls Slack search with your own user token (default 45 s); no Slack app install to the workspace, runs on your machine via launchd (starts at login, auto-restarts).
- **Reads the whole conversation** — pulls the thread or nearby messages, so requests split across several short messages are understood as one.
- **Grace window** — DMs you "starting in N min, reply `stop` to cancel" before doing anything, so you and the bot never do the same task twice.
- **Duplicate-work check** — scans open PRs, recent commits, and thread replies before writing code; never reviews its own or already-reviewed PRs.
- **Your working copy is sacred** — workers only ever touch throwaway worktrees; drafts only; nothing public without the grace gate.
- **Full visibility** — stage-by-stage DMs, streamed worker progress in the console log, and a `history.jsonl` audit trail.
- **Manual send CLI** — fire off the drafted replies (or anything) to a channel or DM in one command.

## Requirements

- macOS (launchd; the watcher itself is portable Node, `install.sh` is Mac-specific)
- Node ≥ 18 (no npm dependencies)
- [Claude Code CLI](https://claude.com/claude-code) (`claude`) logged in
- [GitHub CLI](https://cli.github.com) (`gh`) logged in
- A Slack **user token** (`xoxp-…`) — see below

## Setup

1. **Slack token**: create an app at api.slack.com/apps → OAuth & Permissions → **User Token Scopes**: `search:read`, `chat:write` (required) + `channels:history`, `groups:history`, `im:history`, `mpim:history` (conversation context) + `users:read` (DM by username via `send.js`) → Install to Workspace → copy the **User OAuth Token**.
2. ```bash
   cp .env.example .env   # set SLACK_USER_TOKEN, BASE_BRANCH, PR_SEARCH_QUERY, ...
   ```
3. Test without side effects:
   ```bash
   DRY_RUN=1 node src/index.js --once
   ```
   The first run sets the baseline to "now" — old mentions are never processed. Dry runs don't consume mentions.
4. Install as a login daemon:
   ```bash
   ./install.sh
   tail -f logs/watcher.log
   ```

Uninstall: `./uninstall.sh`

## How it works

```
poll (45s) ──► search.messages: mentions of you  ──┐
          ──► search.messages: PR links (your org) ─┤─► dedupe (state.json)
                                                    ▼
                              fetch thread / nearby messages as context
                                                    ▼
                       classify (claude haiku): code_request │ pr_review │
                            question │ needs_clarification │ ignore
                                                    ▼
            DM "picked up — starting in N min, reply stop to cancel"
                                                    ▼
              disposable git worktree from origin/<BASE_BRANCH>
                                                    ▼
        claude -p worker (streamed progress in console log) ──► draft PR /
            inline review comments / drafted answer ──► result DM
```

Safety properties:

- **Your working copy is never touched** — workers run in throwaway `git worktree`s under `worktrees/`, removed in the background afterwards.
- **Nothing public without a gate** — PRs are drafts; answers are private DMs; the only public actions (review comments + the "added comments" thread reply) sit behind the grace window ("reply `stop` to cancel").
- **Duplicate-work protection** — grace window for "I'm already on it", plus the worker checks open PRs / recent commits / thread replies before writing code, and never reviews its own or already-reviewed PRs.
- **Audit trail** — every processed message is appended to `history.jsonl`; live worker progress streams to `logs/watcher.log`.

⚠️ **Understand the risk**: workers run `claude -p --dangerously-skip-permissions` with write access to your repos, triggered by incoming Slack messages. Anyone who can mention you can start a worker (it only ever opens draft PRs, but still). Run it only in workspaces you trust, or set `WORKER_CLAUDE_ARGS=--permission-mode acceptEdits` for a read-mostly mode that stops at push/PR steps.

## Manual sending (`src/send.js`)

```bash
node src/send.js "#dev-channel" "deployed, please verify"
node src/send.js "@teammate" "PR is up: <link>"      # needs users:read
echo "multiline..." | node src/send.js "#channel" -
```

## Structure

One file = one concern; handlers split per mention kind, routed by a plain map.

| File | Purpose |
|---|---|
| `src/index.js` | Poll loop, mention filtering/dedupe, route `kind → handler` |
| `src/config.js` | `.env` loading + validation (fail fast) |
| `src/classify.js` | Mention classification via a cheap model |
| `src/handlers/` | One file per kind; `shared.js` = grace window, thread-ts, trim; `index.js` = route map |
| `src/slack.js` | Slack Web API client (search, post, context fetch, 429 retry) |
| `src/claude.js` | `claude -p` runner with streamed progress |
| `src/git.js` | git exec + disposable worktree create/remove |
| `src/repos.js` | Repo discovery + doc-sourced repo hints |
| `src/github.js` | PR URL parsing |
| `src/send.js` | Manual send CLI |

Handlers share one signature: `handle(ctx)` with `ctx = { mention, classification, contextBlock, config, slack, selfId }`. Adding a new mention kind = one new handler file + one entry in the `HANDLERS` map + one line in the classifier prompt.

## Operational notes

- Slack search renders mentions as `<@U123|Display Name>` — the watcher matches both forms. If mention search returns nothing in your workspace, set `SLACK_SEARCH_QUERY=@YourName`.
- Re-run a processed message: remove its `channel:ts` key from `state.json`'s `processed`, set `lastTs` just below its ts, restart the agent (`launchctl kickstart -k gui/$(id -u)/com.slack-watcher`).
- Leftover worktrees after a crash: `git -C <repo> worktree list`, then `git worktree remove --force <path>`.
- Log timestamps are UTC+7 by default — change `UTC_OFFSET_HOURS` in `src/log.js`.

## Disclaimer

This tool automates real actions under your identity — draft PRs, review comments, and drafted replies. However, we still recommend that users review and take ownership of the messages before sending them, rather than relying entirely on the AI-generated response.

## License

MIT
