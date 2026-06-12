#!/usr/bin/env node
// Push a message to Slack as you — to a channel by name, a user DM by username, or a raw ID.
//
// CLI:
//   node src/send.js "#dev-channel" "deployed, please verify"
//   node src/send.js "@teammate" "PR is up: <link>"
//   echo "multiline message" | node src/send.js "#dev-channel" -
//
// Targets: "#channel-name" | "@username" (also matches display/real name; needs users:read
// scope) | raw C…/D…/U… ID. Messages are sent from YOUR account — review before sending.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createSlackClient } from "./slack.js";

export async function sendSlackMessage(slack, to, text) {
  if (!to || !text) throw new Error("both target and message are required");
  const channel = to.startsWith("@") ? await slack.resolveUserId(to) : to;
  return slack.post(channel, text);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const [to, ...rest] = process.argv.slice(2);
  let text = rest.join(" ");
  if (text === "-" || (!text && !process.stdin.isTTY)) text = fs.readFileSync(0, "utf8").trim();
  if (!to || !text) {
    console.error(
      'usage: send.js <"#channel" | "@username" | ID> <message... | ->   (- reads stdin)',
    );
    process.exit(1);
  }
  const config = loadConfig();
  const slack = createSlackClient(config.slackToken);
  sendSlackMessage(slack, to, text)
    .then((channel) => console.log(`sent to ${to} (${channel})`))
    .catch((err) => {
      console.error(`failed: ${err.message}`);
      process.exit(1);
    });
}
