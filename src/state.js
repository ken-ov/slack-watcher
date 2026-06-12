import fs from "node:fs";

const MAX_PROCESSED_KEYS = 500;

export function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return { lastTs: 0, processed: [] };
  }
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return { lastTs: state.lastTs ?? 0, processed: state.processed ?? [] };
  } catch {
    return { lastTs: 0, processed: [] };
  }
}

export function saveState(stateFile, state) {
  const trimmed = {
    lastTs: state.lastTs,
    processed: state.processed.slice(-MAX_PROCESSED_KEYS),
  };
  fs.writeFileSync(stateFile, JSON.stringify(trimmed, null, 2));
}

export function mentionKey(match) {
  return `${match.channel?.id ?? "?"}:${match.ts}`;
}

export function appendHistory(historyFile, entry) {
  fs.appendFileSync(historyFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}
