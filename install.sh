#!/usr/bin/env bash
# Install the Slack mention watcher as a launchd LaunchAgent (runs at login, auto-restarts).
set -euo pipefail

WATCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.slack-watcher"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ ! -f "$WATCHER_DIR/.env" ]]; then
  echo "ERROR: $WATCHER_DIR/.env not found. Copy .env.example to .env and set SLACK_USER_TOKEN first." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found on PATH." >&2
  exit 1
fi

CLAUDE_BIN="$(command -v claude || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "WARNING: claude CLI not found on PATH — the watcher needs it at runtime." >&2
fi

# launchd does not inherit your shell PATH; bake in the dirs node/claude/gh/git live in.
AGENT_PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$HOME/Library/LaunchAgents" "$WATCHER_DIR/logs"

sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__WATCHER_DIR__|$WATCHER_DIR|g" \
  -e "s|__PATH__|$AGENT_PATH|g" \
  -e "s|__HOME__|$HOME|g" \
  "$WATCHER_DIR/launchd/$LABEL.plist.template" > "$PLIST_DEST"

# Reload if already installed
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed. Status:"
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|pid" | head -3
echo "Logs: tail -f $WATCHER_DIR/logs/watcher.log"
