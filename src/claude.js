import { spawn } from "node:child_process";
import { log } from "./log.js";

function summarizeInput(input = {}) {
  const s = input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? "";
  return String(s).replace(/\n/g, " ").slice(0, 110);
}

/**
 * Run `claude -p` headless and return its final result text.
 * The prompt is passed as an argv element (no shell), so message content needs no escaping.
 * With `label` set, streams live progress (tool calls + narration) to the console log;
 * without it (e.g. the classifier) the run is silent.
 */
export class CancelledError extends Error {
  constructor() {
    super("cancelled by user");
    this.name = "CancelledError";
  }
}

export function runClaude({ bin, prompt, cwd, timeoutMs, model, extraArgs = [], label, signal }) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", ...extraArgs];
  if (model) args.push("--model", model);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let result = null;
    let stderr = "";
    let timedOut = false;
    let cancelled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    if (signal) {
      const onAbort = () => {
        cancelled = true;
        child.kill("SIGKILL");
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const handleEvent = (event) => {
      if (event.type === "result") {
        // The result event is final — settle NOW instead of waiting for process
        // close, which can lag minutes if the worker left children holding the pipe.
        clearTimeout(timer);
        child.kill();
        if (event.is_error || event.subtype !== "success") {
          // e.g. inaccessible model, auth failure — surface as a real error, not a parseable result.
          const reason = event.subtype && event.subtype !== "success" ? event.subtype : "error";
          return reject(new Error(`claude failed (${reason}): ${(event.result ?? "").slice(0, 300)}`));
        }
        result = event.result ?? "";
        resolve(result);
        return;
      }
      if (!label || event.type !== "assistant") return;
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") {
          log(`[${label}] ⏺ ${block.name}: ${summarizeInput(block.input)}`);
        } else if (block.type === "text" && block.text?.trim()) {
          log(`[${label}] 💬 ${block.text.trim().replace(/\n/g, " ").slice(0, 150)}`);
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // non-JSON noise on stdout — ignore
        }
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${bin}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (cancelled) {
        return reject(new CancelledError());
      }
      if (timedOut) {
        return reject(new Error(`claude timed out after ${Math.round(timeoutMs / 60000)} min`));
      }
      if (code !== 0 && result === null) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
      resolve(result ?? "");
    });
  });
}

/** Extract the first JSON object from model output that may contain surrounding prose/fences. */
export function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`no JSON object found in: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}
