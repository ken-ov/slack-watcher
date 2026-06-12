import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

export function git(repoPath, ...args) {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new Error(`git ${args[0]} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

/**
 * Workers must NEVER run inside the user's working copy — it may hold
 * uncommitted work on another branch. Give them a disposable worktree
 * checked out at the latest origin/<baseBranch> instead.
 */
export function createWorktree(repoPath, repoName, ts, worktreesDir, baseBranch) {
  const worktreePath = path.join(worktreesDir, `${repoName}-${ts.replace(".", "-")}`);
  git(repoPath, "fetch", "origin", baseBranch);
  git(repoPath, "worktree", "add", "--detach", worktreePath, `origin/${baseBranch}`);
  return worktreePath;
}

export function removeWorktree(repoPath, worktreePath) {
  // Fire-and-forget: deleting a worktree's node_modules takes minutes and must
  // never delay result reporting. Leftovers from a crash are cleaned manually
  // (`git worktree list` + `git worktree remove --force`).
  try {
    spawn("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    // never mask the worker result
  }
}
