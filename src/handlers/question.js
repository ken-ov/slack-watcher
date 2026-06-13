import path from "node:path";
import fs from "node:fs";
import { runClaude } from "../claude.js";
import { prepareAttachments } from "../attachments.js";
import { log } from "../log.js";
import { trim } from "./shared.js";

function answerPrompt({ mention, contextBlock }, attachmentsBlock) {
  return `A teammate mentioned me on Slack with a question. Draft a reply I can send them.

Slack message (from @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}):
"""
${mention.text}
"""
${contextBlock}${attachmentsBlock}
You are in the workspace root containing the team's repositories — consult their code and docs if the question is about this platform.
Write ONLY the reply text, in the same language as the question, concise and Slack-friendly (no markdown headers).
If you cannot answer confidently, say what you'd need to find out instead of guessing.`;
}

export async function handleQuestion(ctx) {
  const { mention, classification, config, slack, selfId } = ctx;
  log(`[question] drafting answer for ${mention.permalink ?? "?"}`);

  const destDir = path.join(config.attachmentsDir, mention.ts.replace(".", "-"));
  const { block: attachmentsBlock, dir } = await prepareAttachments({
    files: mention.files,
    token: config.slackToken,
    destDir,
    label: "question",
  });

  let answer;
  try {
    answer = await runClaude({
      bin: config.claudeBin,
      prompt: answerPrompt(ctx, attachmentsBlock),
      cwd: config.reposRoot,
      timeoutMs: config.answerTimeoutMs,
      label: "question",
    });
  } finally {
    if (dir) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }

  await slack.postToSelf(
    selfId,
    trim(
      `:speech_balloon: Question for you: ${mention.permalink ?? "n/a"}\n> ${classification.summary}\n\nDraft answer (review before sending):\n${answer}`,
    ),
  );
  return { status: "answer_drafted" };
}
