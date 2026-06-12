import fs from "node:fs";
import { loadConfig } from "./config.js";
import { listRepos } from "./repos.js";
import { createSlackClient, formatConversationContext } from "./slack.js";
import { loadState, saveState, mentionKey, appendHistory } from "./state.js";
import { classifyMention } from "./classify.js";
import { PR_URL_RE } from "./github.js";
import { HANDLERS } from "./handlers/index.js";
import { log, stamp } from "./log.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findNewMentions(matches, state, selfId) {
  // search.messages renders mentions as <@ID> or <@ID|Display Name> — accept both.
  const mentionsMe = (m) => new RegExp(`<@${selfId}[|>]`).test(m.text ?? "");
  // PR-link messages trigger without a mention, but only the pr_review/ignore kinds downstream.
  const hasPrLink = (m) => m.prLinkOnly && PR_URL_RE.test(m.text ?? "");
  return matches
    .filter((m) => m.user !== selfId)
    .filter((m) => mentionsMe(m) || hasPrLink(m))
    .filter((m) => Number.parseFloat(m.ts) > state.lastTs)
    .filter((m) => !state.processed.includes(mentionKey(m)))
    .sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
}

/** Mention-search results win over PR-link results for the same message. */
function mergeMatches(mentionMatches, prMatches) {
  const merged = new Map(mentionMatches.map((m) => [mentionKey(m), m]));
  for (const m of prMatches) {
    if (!merged.has(mentionKey(m))) merged.set(mentionKey(m), { ...m, prLinkOnly: true });
  }
  return [...merged.values()];
}

/** True when the user already posted something in the conversation after the mention — they handled it themselves. */
function userAlreadyReplied(context, mention, selfId) {
  return context.messages.some(
    (m) => m.user === selfId && Number.parseFloat(m.ts) > Number.parseFloat(mention.ts),
  );
}

async function processMention(mention, repos, config, slack, selfId) {
  const context = await slack.fetchContext(mention, config.contextWindowSeconds);
  if (context.error) log(`context unavailable for ${mentionKey(mention)}: ${context.error}`);

  if (userAlreadyReplied(context, mention, selfId)) {
    log(`mention ${mentionKey(mention)} → skipped, you already replied in the conversation`);
    return { classification: { kind: "skipped" }, result: { status: "user_already_replied" } };
  }

  const contextBlock = formatConversationContext(context, mention, selfId);

  const classification = await classifyMention(mention, repos, config, contextBlock);
  log(
    `mention ${mentionKey(mention)} → ${classification.kind} (repo: ${classification.repo ?? "-"}, context msgs: ${context.messages.length}) ${classification.summary}`,
  );

  if (config.dryRun) return { classification, result: { status: "dry_run" } };

  const handler = HANDLERS[classification.kind];
  const result = handler
    ? await handler({ mention, classification, contextBlock, config, slack, selfId })
    : { status: "ignored" };
  return { classification, result };
}

async function pollOnce(config, slack, selfId, query, state) {
  // Re-scan every poll so newly cloned repos are picked up without a restart.
  const repos = listRepos(config.reposRoot);
  const [mentionMatches, prMatches] = await Promise.all([
    slack.searchMentions(query),
    config.prSearchQuery ? slack.searchMentions(`"${config.prSearchQuery}"`) : [],
  ]);
  const fresh = findNewMentions(mergeMatches(mentionMatches, prMatches), state, selfId);
  if (fresh.length) log(`${fresh.length} new mention(s)`);

  for (const mention of fresh) {
    const key = mentionKey(mention);
    try {
      const { classification, result } = await processMention(mention, repos, config, slack, selfId);
      appendHistory(config.historyFile, {
        key,
        channel: mention.channel?.name,
        from: mention.username ?? mention.user,
        text: mention.text?.slice(0, 300),
        permalink: mention.permalink,
        classification,
        result,
      });
    } catch (err) {
      log(`ERROR processing ${key}: ${err.message}`);
      appendHistory(config.historyFile, { key, error: err.message });
      if (!config.dryRun) {
        await slack
          .postToSelf(selfId, `:x: Watcher failed on a mention (${mention.permalink ?? key}): ${err.message}`)
          .catch((dmErr) => log(`ERROR posting failure DM: ${dmErr.message}`));
      }
    } finally {
      // Dry runs must not consume mentions — they are inspection only.
      if (!config.dryRun) {
        state.processed.push(key);
        state.lastTs = Math.max(state.lastTs, Number.parseFloat(mention.ts));
        saveState(config.stateFile, state);
      }
    }
  }
}

async function main() {
  const once = process.argv.includes("--once");
  const config = loadConfig();
  fs.mkdirSync(config.logDir, { recursive: true });

  const slack = createSlackClient(config.slackToken);
  const { userId, userName, team } = await slack.whoAmI();
  const query = config.searchQueryOverride || `<@${userId}>`;

  const state = loadState(config.stateFile);
  if (state.lastTs === 0) {
    // First run: start from "now" so we never storm through historical mentions.
    state.lastTs = Date.now() / 1000;
    saveState(config.stateFile, state);
    log("first run — baseline set to now, historical mentions skipped");
  }

  log(
    `watching mentions of @${userName} (${userId}) on ${team} | query="${query}" | every ${config.pollIntervalSeconds}s${config.dryRun ? " | DRY RUN" : ""}`,
  );
  log(`repos: ${listRepos(config.reposRoot).join(", ")}`);

  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));

  do {
    try {
      await pollOnce(config, slack, userId, query, state);
    } catch (err) {
      const cause = err.cause ? ` (${err.cause.code ?? err.cause.message ?? err.cause})` : "";
      log(`poll error: ${err.message}${cause}`);
    }
    if (!once) await sleep(config.pollIntervalSeconds * 1000);
  } while (!once && !stopping);

  log("stopped");
}

main().catch((err) => {
  console.error(`[${stamp()}] FATAL: ${err.message}`);
  process.exit(1);
});
