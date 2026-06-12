export const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

/** First GitHub PR link in a text blob (Slack-wrapped <url|label> included), or null. */
export function parsePrUrl(text) {
  const m = (text ?? "").match(PR_URL_RE);
  return m ? { url: m[0], owner: m[1], repo: m[2], number: m[3] } : null;
}
