#!/usr/bin/env bash
# Stop and remove the Slack mention watcher LaunchAgent.
set -euo pipefail

LABEL="com.slack-watcher"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DEST"
echo "Uninstalled $LABEL."
