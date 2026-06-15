import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .reduce((acc, line) => {
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      acc[key] = value;
      return acc;
    }, {});
}

function intOption(raw, fallback, { min } = {}) {
  const value = raw === undefined || raw === "" ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) return fallback;
  return min !== undefined ? Math.max(min, value) : value;
}

export function loadConfig() {
  const fileEnv = parseEnvFile(path.join(BASE_DIR, ".env"));
  const env = { ...fileEnv, ...process.env };

  const config = {
    slackToken: env.SLACK_USER_TOKEN || "",
    pollIntervalSeconds: intOption(env.POLL_INTERVAL_SECONDS, 45, { min: 30 }),
    reposRoot: path.resolve(env.REPOS_ROOT || path.join(BASE_DIR, "..", "..")),
    searchQueryOverride: env.SLACK_SEARCH_QUERY || "",
    prSearchQuery: env.PR_SEARCH_QUERY || "",
    baseBranch: env.BASE_BRANCH || "main",
    docsContextDir: env.DOCS_CONTEXT_DIR || "",
    claudeBin: env.CLAUDE_BIN || "claude",
    classifierModel: env.CLASSIFIER_MODEL || "haiku",
    workerModel: env.WORKER_MODEL || "sonnet",
    reviewModel: env.REVIEW_MODEL || "opus",
    workerClaudeArgs: (env.WORKER_CLAUDE_ARGS ?? "--dangerously-skip-permissions")
      .split(" ")
      .filter(Boolean),
    contextWindowSeconds: intOption(env.CONTEXT_WINDOW_SECONDS, 900, { min: 0 }),
    workerTimeoutMs: intOption(env.WORKER_TIMEOUT_MINUTES, 45, { min: 1 }) * 60_000,
    workerGraceMs: intOption(env.WORKER_GRACE_MINUTES, 3, { min: 0 }) * 60_000,
    reviewTimeoutMs: intOption(env.REVIEW_TIMEOUT_MINUTES, 30, { min: 1 }) * 60_000,
    answerTimeoutMs: intOption(env.ANSWER_TIMEOUT_MINUTES, 10, { min: 1 }) * 60_000,
    dryRun: env.DRY_RUN === "1" || env.DRY_RUN === "true",
    worktreesDir: path.join(BASE_DIR, "worktrees"),
    attachmentsDir: path.join(BASE_DIR, "attachments"),
    stateFile: path.join(BASE_DIR, "state.json"),
    historyFile: path.join(BASE_DIR, "history.jsonl"),
    logDir: path.join(BASE_DIR, "logs"),
  };

  const errors = [];
  if (!config.slackToken) {
    errors.push("SLACK_USER_TOKEN is required (set it in slack-watcher/.env)");
  } else if (!config.slackToken.startsWith("xoxp-")) {
    errors.push("SLACK_USER_TOKEN must be a user token (xoxp-...) — bot tokens cannot use search.messages");
  }
  if (!fs.existsSync(config.reposRoot)) {
    errors.push(`REPOS_ROOT does not exist: ${config.reposRoot}`);
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n - ${errors.join("\n - ")}`);
  }

  return config;
}
