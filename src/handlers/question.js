import { runClaude } from "../claude.js";
import { log } from "../log.js";
import { trim } from "./shared.js";

function answerPrompt({ mention, contextBlock }) {
  return `A teammate mentioned me on Slack with a question. Draft a reply I can send them.

Slack message (from @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}):
"""
${mention.text}
"""
${contextBlock}
You are in the workspace root containing the team's repositories — consult their code and docs if the question is about this platform.
Write ONLY the reply text, in the same language as the question, concise and Slack-friendly (no markdown headers).
If you cannot answer confidently, say what you'd need to find out instead of guessing.`;
}

export async function handleQuestion(ctx) {
  const { mention, classification, config, slack, selfId } = ctx;
  log(`[question] drafting answer for ${mention.permalink ?? "?"}`);
  const answer = await runClaude({
    bin: config.claudeBin,
    prompt: answerPrompt(ctx),
    cwd: config.reposRoot,
    timeoutMs: config.answerTimeoutMs,
    label: "question",
  });

  await slack.postToSelf(
    selfId,
    trim(
      `:speech_balloon: Question for you: ${mention.permalink ?? "n/a"}\n> ${classification.summary}\n\nDraft answer (review before sending):\n${answer}`,
    ),
  );
  return { status: "answer_drafted" };
}
