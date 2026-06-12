import { log } from "../log.js";

// Every handler receives a ctx object:
//   { mention, classification, contextBlock, config, slack, selfId }

const SLACK_TEXT_LIMIT = 3500;
const STOP_REPLY = /^(stop|cancel|skip|huỷ|hủy|dừng|thôi)\b/i;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const minutes = (ms) => Math.round(ms / 60_000);
export const trim = (text) =>
  text.length > SLACK_TEXT_LIMIT ? `${text.slice(0, SLACK_TEXT_LIMIT)}\n… (truncated)` : text;

/** Thread timestamp for replying to a mention: its own thread if it is a reply, else the message itself. */
export function threadTsOf(mention) {
  return mention.permalink?.match(/thread_ts=(\d+\.\d+)/)?.[1] ?? mention.ts;
}

/**
 * While a worker runs, poll the self-DM for a "stop" reply and abort the
 * controller when one arrives — lets the user kill a running Claude session.
 * Returns a cleanup function; always call it when the worker settles.
 */
export function watchForStop(ctx, dmChannel, label, controller, intervalMs = 20_000) {
  const since = Date.now() / 1000;
  const timer = setInterval(async () => {
    try {
      const replies = await ctx.slack.fetchMessagesSince(dmChannel, since);
      if (replies.some((m) => STOP_REPLY.test((m.text ?? "").trim()))) {
        log(`[${label}] stop received — killing the running worker`);
        clearInterval(timer);
        controller.abort();
      }
    } catch {
      // transient Slack error — try again next tick
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Wait out the grace window; true = user replied "stop" in the self-DM and the task must be dropped. */
export async function cancelledDuringGrace(ctx, dmChannel, label) {
  const { config, slack, selfId, mention } = ctx;
  if (config.workerGraceMs <= 0) return false;
  const graceStart = Date.now() / 1000;
  log(`[${label}] grace window ${minutes(config.workerGraceMs)} min — reply "stop" in self-DM to cancel`);
  await sleep(config.workerGraceMs);
  const replies = await slack.fetchMessagesSince(dmChannel, graceStart);
  if (!replies.some((m) => STOP_REPLY.test((m.text ?? "").trim()))) return false;
  log(`[${label}] cancelled by user during grace window`);
  await slack.postToSelf(selfId, `:no_entry: Cancelled — I won't touch this request. ${mention.permalink ?? ""}`);
  return true;
}
