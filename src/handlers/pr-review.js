import path from "node:path";
import fs from "node:fs";
import { runClaude } from "../claude.js";
import { createWorktree, removeWorktree } from "../git.js";
import { parsePrUrl } from "../github.js";
import { log } from "../log.js";
import { cancelledDuringGrace, minutes, threadTsOf, trim } from "./shared.js";

function reviewPrompt({ mention, contextBlock }, pr) {
  return `A teammate asked me to review a pull request. Review it and post inline comments under MY GitHub account.

PR: ${pr.url} (repo ${pr.owner}/${pr.repo}, PR #${pr.number})

Slack message (from @${mention.username ?? mention.user} in #${mention.channel?.name ?? "?"}):
"""
${mention.text}
"""
${contextBlock}
Workflow:
1. PRE-CHECK first: run \`gh api user --jq .login\` and \`gh pr view ${pr.number} --json author,state,isDraft,reviews,comments\`. STOP immediately and post nothing (REVIEW_COMMENTS: 0, explain in SLACK_REPLY) if ANY of these holds:
   - the PR author is me (never review my own PR),
   - I already submitted a review or comments on this PR (never double-review),
   - the PR is closed or merged.
2. You are in an isolated git worktree of this repository. Run \`gh pr checkout ${pr.number}\`, then \`gh pr diff ${pr.number}\` and \`gh pr view ${pr.number}\`. Read surrounding source files for full context — do not judge from the diff alone.
3. Review ONLY for real problems: bugs, regressions, lost data/functionality, broken API contracts, security issues, backward-compatibility breaks. SKIP minor issues entirely — style nits, naming, dead code, duplication notes, formatting, log wording. If unsure whether an issue is real, skip it.
4. Post findings as INLINE comments on the exact changed line (RIGHT side of the diff), all in ONE review call:
   \`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews -f event=COMMENT --input <json>\` where the JSON has a "comments" array of {path, line, side: "RIGHT", body}. Never post a single big summary comment instead of inline comments.
5. Every comment MUST include the fix as code: a \`\`\`suggestion block when the fix fits within the commented line(s); otherwise a short code snippet showing the fix.
6. Comment style: English with basic vocabulary, short clear sentences. State the problem, the impact, then the fix. No long paragraphs.
7. Comment-only review: do NOT approve, do NOT request changes.
8. If the PR has no real issues, post nothing at all.

End your final message with exactly these lines:
REVIEW_COMMENTS: <number of inline comments you posted, 0 if none>
SLACK_REPLY: <one short sentence in the requester's language: if comments were posted, say you added review comments on the PR; if zero, say the PR looks good to you>`;
}

export async function handlePrReview(ctx) {
  const { mention, classification, contextBlock, config, slack, selfId } = ctx;
  const pr = parsePrUrl(classification.prUrl) ?? parsePrUrl(mention.text + contextBlock);
  if (!pr) {
    await slack.postToSelf(
      selfId,
      `:warning: Review request detected but no GitHub PR link found.\n> ${classification.summary}\n${mention.permalink ?? ""}\nHandle it manually.`,
    );
    return { status: "no_pr_url" };
  }
  const repoPath = path.join(config.reposRoot, pr.repo);
  if (!fs.existsSync(repoPath)) {
    await slack.postToSelf(selfId, `:warning: PR review requested for *${pr.repo}* but that repo is not cloned locally.\n${pr.url}`);
    return { status: "repo_missing" };
  }

  const dmChannel = await slack.postToSelf(
    selfId,
    `:mag: *PR review picked up* — from @${mention.username ?? mention.user}\n` +
      `> ${pr.url}\n` +
      (config.workerGraceMs > 0
        ? `• *Starting in ${minutes(config.workerGraceMs)} min* — reply \`stop\` here to cancel (review comments will be posted under YOUR GitHub account, and I'll reply in the Slack thread when done)\n`
        : "") +
      `Original: ${mention.permalink ?? "n/a"}`,
  );

  if (await cancelledDuringGrace(ctx, dmChannel, `review:${pr.repo}`)) {
    return { status: "cancelled_by_user" };
  }

  let worktreePath;
  try {
    log(`[review:${pr.repo}] preparing isolated worktree...`);
    worktreePath = createWorktree(repoPath, pr.repo, mention.ts, config.worktreesDir, config.baseBranch);
  } catch (err) {
    await slack.postToSelf(selfId, `:x: Could not prepare a worktree for reviewing ${pr.url}: ${err.message}`);
    return { status: "worktree_failed", error: err.message };
  }

  const startedAt = Date.now();
  log(`[review:${pr.repo}] reviewing PR #${pr.number} (timeout ${minutes(config.reviewTimeoutMs)} min)`);
  await slack.postToSelf(selfId, `:mag: *Reviewing now* — ${pr.url} (timeout ${minutes(config.reviewTimeoutMs)} min)`);

  let result;
  try {
    result = await runClaude({
      bin: config.claudeBin,
      prompt: reviewPrompt(ctx, pr),
      cwd: worktreePath,
      timeoutMs: config.reviewTimeoutMs,
      extraArgs: config.workerClaudeArgs,
      label: `review:${pr.repo}`,
    });
  } finally {
    removeWorktree(repoPath, worktreePath);
    log(`[review:${pr.repo}] finished after ${minutes(Date.now() - startedAt)} min, worktree removed`);
  }

  const commentCount = Number.parseInt(result.match(/^REVIEW_COMMENTS:\s*(\d+)/m)?.[1] ?? "NaN", 10);
  const slackReply = result.match(/SLACK_REPLY:\s*([\s\S]+)$/m)?.[1]?.trim() ?? "";
  log(`[review:${pr.repo}] result: ${Number.isNaN(commentCount) ? "unparseable" : `${commentCount} comment(s)`}`);

  let repliedInThread = false;
  if (commentCount > 0 && slackReply && mention.channel?.id) {
    await slack.replyInThread(mention.channel.id, threadTsOf(mention), slackReply);
    repliedInThread = true;
  }

  await slack.postToSelf(
    selfId,
    trim(
      Number.isNaN(commentCount)
        ? `:warning: PR review finished but I couldn't parse the result for ${pr.url} — check the PR manually.\n\nWorker output:\n${result}`
        : commentCount > 0
          ? `:white_check_mark: *PR review done* — posted ${commentCount} inline comment(s) on ${pr.url}` +
            (repliedInThread ? `\nReplied in the Slack thread: "${slackReply}"` : "\n:warning: Could not reply in the Slack thread — do it manually.")
          : `:white_check_mark: *PR review done* — no real issues found on ${pr.url}. Nothing posted; reply to the thread yourself if you want (draft: "${slackReply}")`,
    ),
  );
  return { status: "reviewed", comments: Number.isNaN(commentCount) ? null : commentCount, repliedInThread };
}
