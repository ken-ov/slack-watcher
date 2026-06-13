import path from "node:path";
import fs from "node:fs";
import { runClaude, CancelledError } from "../claude.js";
import { createWorktree, removeWorktree } from "../git.js";
import { prepareAttachments } from "../attachments.js";
import { log } from "../log.js";
import { cancelledDuringGrace, minutes, trim, watchForStop } from "./shared.js";

const HEARTBEAT_MS = 5 * 60_000;

function workerPrompt({ mention, classification, contextBlock, config }, branchName, attachmentsBlock) {
  const base = config.baseBranch;
  return `A teammate asked for a code change on Slack. Implement it and open a draft PR.

Slack message (from @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}):
"""
${mention.text}
"""
Link: ${mention.permalink ?? "n/a"}
${contextBlock}${attachmentsBlock}
Task summary: ${classification.summary}

Mandatory workflow for this repository:
1. You are already in an ISOLATED git worktree checked out at the latest \`origin/${base}\` (detached). The user's main working copy lives elsewhere — never cd into it or touch it. All work branches from here.
2. Create a branch named \`${branchName}\` (prefix \`fix/\` or \`feat/\` plus a short slug is also fine).
3. DUPLICATE-WORK CHECK before writing any code — a teammate (or the user) may already be on it:
   - Run \`gh pr list --state all --limit 20\` and \`git log origin/${base} --oneline -20\`; search both for the ticket ID (e.g. PROJ-123), keywords from the request, and the files you expect to touch.
   - Re-read the conversation context above for replies saying it's already done or claimed.
   - If existing work covers this request (open/merged PR, recent commit), STOP, make no changes, and put the existing PR/commit link in SLACK_DRAFT.
4. Investigate the ROOT CAUSE before changing anything — do not ship a symptom patch. If at any point the request turns out to be too ambiguous to implement safely (unclear expected behavior, multiple plausible interpretations, can't reproduce), STOP and make no changes. In that case put the clarifying questions for the requester into SLACK_DRAFT (same language as the request) so I can send them back as-is.
5. Implement the smallest correct change. Follow existing code style and the repository's own contribution rules (CLAUDE.md / CONTRIBUTING.md if present).
6. Run the project's tests and lint; fix failures you introduced. A fresh worktree has no node_modules — install dependencies first (pnpm/npm per the repo's lockfile).
7. Commit with a plain message describing the change. NEVER add AI attribution (no Co-Authored-By, no "Generated with" lines).
8. Push the branch and open a DRAFT pull request targeting \`${base}\` using \`gh pr create --draft --base ${base}\`. The PR description should explain the change, reference the Slack request, and note anything unverified.

End your final message with exactly these lines:
PR_URL: <the pull request URL, or "none" if you stopped>
SLACK_DRAFT: <a short Slack reply (same language as the request) I can send to the requester>`;
}

export async function handleCodeRequest(ctx) {
  const { mention, classification, config, slack, selfId } = ctx;
  const repoPath = classification.repo ? path.join(config.reposRoot, classification.repo) : null;

  if (!repoPath || !fs.existsSync(repoPath)) {
    await slack.postToSelf(
      selfId,
      `:warning: Code request detected but I couldn't map it to a repo.\n> ${classification.summary}\n${mention.permalink ?? ""}\nHandle it manually.`,
    );
    return { status: "needs_repo" };
  }

  const branchName = `auto/slack-${mention.ts.replace(".", "-")}`;
  const graceNote =
    config.workerGraceMs > 0
      ? `• *Starting in ${minutes(config.workerGraceMs)} min* — reply \`stop\` here to cancel, before OR while it runs (e.g. if you're already on it)\n`
      : "";

  const dmChannel = await slack.postToSelf(
    selfId,
    `:rocket: *Code request picked up* — from @${mention.username ?? mention.user}\n` +
      `> ${classification.summary}\n` +
      graceNote +
      `• Repo: *${classification.repo}* (branch \`${branchName}\`, isolated worktree)\n` +
      `• Base: fresh \`origin/${config.baseBranch}\` — your working copy is untouched\n` +
      `• Timeout: ${minutes(config.workerTimeoutMs)} min — I'll DM the result (draft PR or stop reason)\n` +
      `Original: ${mention.permalink ?? "n/a"}`,
  );

  if (await cancelledDuringGrace(ctx, dmChannel, classification.repo)) {
    return { status: "cancelled_by_user" };
  }

  let worktreePath;
  try {
    log(`[${classification.repo}] preparing isolated worktree from origin/${config.baseBranch}...`);
    worktreePath = createWorktree(repoPath, classification.repo, mention.ts, config.worktreesDir, config.baseBranch);
    log(`[${classification.repo}] worktree ready: ${worktreePath}`);
  } catch (err) {
    await slack.postToSelf(
      selfId,
      `:x: Could not prepare an isolated worktree for *${classification.repo}*: ${err.message}\n> ${classification.summary}\n${mention.permalink ?? ""}\nHandle it manually.`,
    );
    return { status: "worktree_failed", error: err.message };
  }

  const startedAt = Date.now();
  log(`[${classification.repo}] worker started (branch ${branchName}, timeout ${minutes(config.workerTimeoutMs)} min)`);
  await slack.postToSelf(
    selfId,
    `:hammer_and_wrench: *Coding now* — *${classification.repo}* / \`${branchName}\`\n` +
      `> ${classification.summary}\n` +
      `Worktree ready from fresh \`origin/${config.baseBranch}\`. Next update: result DM (draft PR, stop reason, or timeout after ${minutes(config.workerTimeoutMs)} min). Progress heartbeat every 5 min in \`logs/watcher.log\`.`,
  );
  const heartbeat = setInterval(
    () => log(`[${classification.repo}] worker still running (${minutes(Date.now() - startedAt)} min elapsed)`),
    HEARTBEAT_MS,
  );

  const { block: attachmentsBlock } = await prepareAttachments({
    files: mention.files,
    token: config.slackToken,
    destDir: worktreePath,
    label: classification.repo,
  });

  const controller = new AbortController();
  const stopWatching = watchForStop(ctx, dmChannel, classification.repo, controller);

  let result;
  try {
    result = await runClaude({
      bin: config.claudeBin,
      prompt: workerPrompt(ctx, branchName, attachmentsBlock),
      cwd: worktreePath,
      timeoutMs: config.workerTimeoutMs,
      extraArgs: config.workerClaudeArgs,
      label: classification.repo,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      await slack.postToSelf(
        selfId,
        `:no_entry: *Stopped* — killed the running worker for *${classification.repo}* after ${minutes(Date.now() - startedAt)} min. The worktree was discarded; if a branch/PR was already pushed, close it manually. ${mention.permalink ?? ""}`,
      );
      return { status: "cancelled_mid_task" };
    }
    throw err;
  } finally {
    stopWatching();
    clearInterval(heartbeat);
    removeWorktree(repoPath, worktreePath);
    log(`[${classification.repo}] worker finished after ${minutes(Date.now() - startedAt)} min, worktree removed`);
  }
  const elapsedMin = minutes(Date.now() - startedAt);

  const prUrl = result.match(/^PR_URL:\s*(\S+)/m)?.[1] ?? "none";
  const slackDraft = result.match(/SLACK_DRAFT:\s*([\s\S]+)$/m)?.[1]?.trim() ?? "";
  log(`[${classification.repo}] result: ${prUrl !== "none" ? `draft PR ${prUrl}` : "stopped without PR"}`);

  const header =
    prUrl !== "none"
      ? `:white_check_mark: *Draft PR opened* for *${classification.repo}* in ${elapsedMin} min: ${prUrl}`
      : `:warning: Code request in *${classification.repo}* — worker stopped without a PR after ${elapsedMin} min (likely needs clarification, see draft below):`;

  await slack.postToSelf(
    selfId,
    trim(
      `${header}\n> ${classification.summary}\nOriginal: ${mention.permalink ?? "n/a"}` +
        (slackDraft ? `\n\nDraft reply for the requester:\n${slackDraft}` : "") +
        (prUrl === "none" ? `\n\nWorker output:\n${result}` : ""),
    ),
  );
  return { status: prUrl !== "none" ? "pr_opened" : "no_pr", prUrl };
}
