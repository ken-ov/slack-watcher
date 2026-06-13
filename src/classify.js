import { runClaude, extractJson } from "./claude.js";
import { buildRepoHints } from "./repos.js";
import { describeAttachments } from "./attachments.js";
import { PR_URL_RE } from "./github.js";

const VALID_KINDS = new Set(["code_request", "pr_review", "question", "needs_clarification", "ignore"]);

function classificationPrompt(mention, repos, repoHints, contextBlock) {
  const pickupNote = mention.prLinkOnly
    ? `NOTE: I was NOT mentioned in this message — it was picked up only because it contains a GitHub PR link. Therefore the ONLY valid kinds are "pr_review" (the message shares a PR asking for review/feedback/checking, explicitly or implicitly — e.g. posting a fresh PR into a dev channel for the team) and "ignore" (deploy notes, CI output, discussing an already-merged/old PR, status updates). Never code_request/question/needs_clarification here.
`
    : "";
  return `You classify a Slack message ${mention.prLinkOnly ? "from my team" : "that mentions me"}, so an automation can decide what to do with it.
${pickupNote}

Available repositories (descriptions sourced from team docs and repo docs):
${repoHints}

Slack message (from @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}):
"""
${mention.text}
"""
${describeAttachments(mention.files)}${contextBlock}
Classify the REQUEST AS A WHOLE — the mention plus the requester's surrounding messages in the context block. A bare mention whose details appear in adjacent messages is a complete request, not needs_clarification.

Classify it:
- "code_request": asks me to fix a bug, build a feature, or change code/config — AND contains enough detail to act on safely (what is broken / what is wanted, and where, at least roughly).
- "pr_review": asks me to review, check, or approve a pull request, and a GitHub PR link appears in the message or the conversation context.
- "needs_clarification": looks like a request aimed at me, but is too vague or missing key information to act on (e.g. "fix the bug" with no description, no screen/feature named, no expected behavior). When in doubt between code_request and needs_clarification, pick needs_clarification.
- "question": EXPLICITLY asks me to answer something and expects a reply from me (a real question or a request for information/opinion directed at me).
- "ignore": the mention does not ask me to answer or do anything. This includes: status updates ("em đã update rồi"), FYI/sharing info, acknowledgments, thanks, agreement ("LGTM", "đc đó a"), social pings, meeting reminders, tagging me just for visibility/CC, rhetorical mentions inside a statement, and requests for personal actions only I can do myself (join a call, check DM) — I will see those in Slack anyway. A review/approve request WITHOUT any PR link anywhere in message or context is also "ignore".

Default rule: when in doubt between "question" and "ignore", pick "ignore" — only act when the message clearly expects an answer or a code change from me. (But when a CODE request is clearly intended and merely lacks detail, that is "needs_clarification", not "ignore".)

Respond with ONLY a JSON object, no prose:
{"kind": "code_request" | "pr_review" | "question" | "needs_clarification" | "ignore", "repo": "<repository name or null>", "summary": "<one sentence, same language as the message>", "pr_url": "<the GitHub PR URL or null>", "questions": ["<short clarifying question>", ...]}

"repo" must be one of the available repositories (only for code_request; null otherwise or if unclear).
"pr_url" only for pr_review: the full GitHub pull request URL found in the message or context.
"questions" only for needs_clarification: 1-3 short questions in the same language as the message, phrased so they can be sent back to the requester as-is.`;
}

export async function classifyMention(mention, repos, config, contextBlock = "") {
  const result = await runClaude({
    bin: config.claudeBin,
    prompt: classificationPrompt(mention, repos, buildRepoHints(config.reposRoot, repos, config.docsContextDir), contextBlock),
    cwd: config.reposRoot,
    timeoutMs: 120_000,
    model: config.classifierModel,
  });

  const parsed = extractJson(result);
  if (!VALID_KINDS.has(parsed.kind)) {
    throw new Error(`classifier returned invalid kind: ${parsed.kind}`);
  }
  // Hard guard: non-mention pickups may only review or ignore, whatever the model says.
  if (mention.prLinkOnly && parsed.kind !== "pr_review") {
    parsed.kind = "ignore";
  }
  return {
    kind: parsed.kind,
    repo: repos.includes(parsed.repo) ? parsed.repo : null,
    summary: parsed.summary ?? "",
    prUrl: typeof parsed.pr_url === "string" ? (parsed.pr_url.match(PR_URL_RE)?.[0] ?? null) : null,
    questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : [],
  };
}
