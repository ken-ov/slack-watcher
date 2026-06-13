import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";

const MAX_FILES = 4;
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB — keep token cost and download time bounded
const IMAGE_RE = /^image\/(png|jpe?g|gif|webp)$/;
const TEXT_RE = /^(text\/|application\/(json|xml))/;

const isEligible = (f) =>
  f.url_private && f.size <= MAX_BYTES && (IMAGE_RE.test(f.mimetype) || TEXT_RE.test(f.mimetype));

/** One-line summary of a message's attachments for the (text-only) classifier — no download. */
export function describeAttachments(files = []) {
  if (!files.length) return "";
  return `\nAttached files: ${files.map((f) => `${f.name} (${f.mimetype})`).join(", ")}\n`;
}

/**
 * Download a message's eligible attachments (images + small text files) into
 * <destDir>/slack-attachments and return a prompt fragment pointing the worker
 * at them by relative path — Claude Code reads them natively, no vision plumbing.
 * Best-effort: a failed download (e.g. missing files:read scope) is logged and
 * the file is skipped, never thrown.
 */
export async function prepareAttachments({ files = [], token, destDir, label }) {
  const usable = files.filter(isEligible).slice(0, MAX_FILES);
  if (!usable.length) return { block: "", saved: [], dir: null };

  const dir = path.join(destDir, "slack-attachments");
  fs.mkdirSync(dir, { recursive: true });

  const saved = [];
  for (const f of usable) {
    try {
      const resp = await fetch(f.url_private, { headers: { Authorization: `Bearer ${token}` } });
      const type = resp.headers.get("content-type") ?? "";
      // Slack serves an HTML page (not the file) when files:read is missing.
      if (!resp.ok || type.startsWith("text/html")) {
        throw new Error(`got ${resp.status} ${type || "?"} — is the files:read scope granted?`);
      }
      const filePath = path.join(dir, f.name);
      fs.writeFileSync(filePath, Buffer.from(await resp.arrayBuffer()));
      saved.push({ path: filePath, mimetype: f.mimetype });
    } catch (err) {
      log(`[${label}] attachment "${f.name}" skipped: ${err.message}`);
    }
  }
  if (!saved.length) return { block: "", saved, dir };

  // Absolute paths so the block works regardless of the worker's cwd.
  const lines = saved.map((f) => `- ${f.path} (${f.mimetype})`).join("\n");
  return {
    block: `\nThe requester attached these files — read them, they often hold the actual bug or context:\n${lines}\n`,
    saved,
    dir,
  };
}
