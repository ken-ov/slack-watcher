import fs from "node:fs";
import path from "node:path";

export function listRepos(reposRoot) {
  return fs
    .readdirSync(reposRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(reposRoot, name, ".git")));
}

function firstParagraph(filePath, maxChars = 220) {
  if (!fs.existsSync(filePath)) return "";
  const lines = fs.readFileSync(filePath, "utf8").split("\n").slice(0, 60);
  let inFrontmatter = false;
  const picked = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    const isProse = line && !/^(#|!\[|\[!\[|<|```|\||>|-{3,})/.test(line);
    if (isProse) picked.push(line);
    else if (picked.length) break;
  }
  const text = picked.join(" ").slice(0, maxChars);
  // Pointer-only docs ("See ../other-docs") carry no signal — fall through to the next source.
  return /^see\s/i.test(text) || text.length < 20 ? "" : text;
}

/**
 * Build per-repo descriptions for the classifier, sourced from docs instead of
 * hardcoded hints so newly cloned repos are covered by updating the docs.
 * Priority: <docsContextDir>/<repo>.md (if configured) → <repo>/CLAUDE.md → <repo>/README.md.
 */
export function buildRepoHints(reposRoot, repos, docsContextDir = "") {
  return repos
    .map((repo) => {
      const description =
        (docsContextDir && firstParagraph(path.join(reposRoot, docsContextDir, `${repo}.md`))) ||
        firstParagraph(path.join(reposRoot, repo, "CLAUDE.md")) ||
        firstParagraph(path.join(reposRoot, repo, "README.md"));
      return description ? `- ${repo}: ${description}` : `- ${repo}`;
    })
    .join("\n");
}
