#!/usr/bin/env node

const { Command } = require("commander");
const { execSync } = require("child_process");
const path = require("path");
const chalk = require("chalk");

const DIFF_MODES = ["standard", "patience", "histogram", "word", "semantic", "all"];

const program = new Command();

program
  .name("differ")
  .description("Show what was removed and replaced in a single git commit")
  .version("1.0.0")
  .argument("<commit>", "Commit hash to analyze")
  .argument("[directory]", "Git repository directory", ".")
  .option("-f, --file <path>", "Only show changes for a specific file")
  .option("--stat", "Show summary statistics only")
  .option("--json", "Output as JSON (for piping to LLMs or other tools)")
  .option("--plain", "Plain text output with no colors or box drawing (LLM-friendly)")
  .option("-m, --mode <type>", `Diff mode: ${DIFF_MODES.join(", ")}`, "standard")
  .action(run);

// ── File exclusions ──────────────────────────────────────────────────

const EXCLUDED_EXTENSIONS = [".svg"];

function isExcluded(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return EXCLUDED_EXTENSIONS.includes(ext);
}

// ── Helpers ──────────────────────────────────────────────────────────

function git(cmd, cwd) {
  try {
    return execSync(`git --no-pager ${cmd}`, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    }).trim();
  } catch (err) {
    if (err.stderr && err.stderr.includes("not a git repository")) {
      console.error(chalk.red("Error: Not a git repository."));
      process.exit(1);
    }
    return "";
  }
}

// ── Commit data ──────────────────────────────────────────────────────

function getCommit(cwd, hash) {
  const SEP = "\x1f";
  const fmt = ["%H", "%an", "%ae", "%ai", "%s", "%b", "%P", "%cn", "%ce", "%ci", "%D"].join(SEP);
  const raw = git(`log -1 --format=${fmt} ${hash}`, cwd);
  if (!raw) return null;
  const parts = raw.split(SEP);
  return {
    hash: parts[0],
    author: parts[1],
    email: parts[2],
    date: parts[3],
    message: parts[4],
    body: (parts[5] || "").trim(),
    parents: parts[6] ? parts[6].split(" ") : [],
    committer: { name: parts[7], email: parts[8], date: parts[9] },
    refs: parts[10] || "",
  };
}

// ── Commit context (rich metadata for LLMs) ──────────────────────────

function getCommitContext(cwd, commit) {
  const parentMessages = commit.parents.map((p) => {
    const msg = git(`log -1 --format=%s ${p}`, cwd);
    return msg || null;
  }).filter(Boolean);

  const numstatRaw = git(`diff --numstat ${commit.hash}^! 2>/dev/null`, cwd);
  const diffStats = numstatRaw
    ? numstatRaw.split("\n").map((line) => {
        const [ins, del, file] = line.split("\t");
        return { path: file, insertions: parseInt(ins, 10) || 0, deletions: parseInt(del, 10) || 0 };
      })
    : [];

  const nameStatusRaw = git(`diff --name-status ${commit.hash}^! 2>/dev/null`, cwd);
  const fileStatuses = {};
  if (nameStatusRaw) {
    for (const line of nameStatusRaw.split("\n")) {
      const [status, ...fileParts] = line.split("\t");
      const file = fileParts.join("\t");
      if (file) fileStatuses[file] = status;
    }
  }
  for (const ds of diffStats) {
    ds.status = fileStatuses[ds.path] || "M";
  }

  const trailersRaw = git(`log -1 --format="%(trailers:unfold)" ${commit.hash}`, cwd);
  const trailers = {};
  if (trailersRaw) {
    for (const line of trailersRaw.split("\n")) {
      const match = line.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        const key = match[1].trim();
        if (!trailers[key]) trailers[key] = [];
        trailers[key].push(match[2].trim());
      }
    }
  }

  const references = parseReferences(commit.message + " " + commit.body);

  const tagsRaw = git(`tag --points-at ${commit.hash} 2>/dev/null`, cwd);
  const tags = tagsRaw ? tagsRaw.split("\n").filter(Boolean) : [];

  const branchRaw = git(`branch --contains ${commit.hash} --format="%(refname:short)" 2>/dev/null`, cwd);
  const branches = branchRaw ? branchRaw.split("\n").filter(Boolean) : [];

  const posRaw = git(`rev-list --count ${commit.hash}`, cwd);
  const commitPosition = parseInt(posRaw, 10) || 0;

  return {
    parent_messages: parentMessages,
    is_merge: commit.parents.length > 1,
    branches,
    tags,
    references,
    trailers,
    committer: commit.committer,
    commit_position: commitPosition,
    diff_stats: {
      files: diffStats,
      total_insertions: diffStats.reduce((s, f) => s + f.insertions, 0),
      total_deletions: diffStats.reduce((s, f) => s + f.deletions, 0),
    },
  };
}

// ── Reference parser ─────────────────────────────────────────────────

function parseReferences(text) {
  const refs = [];
  const patterns = [
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi,
    /(?:^|\s)#(\d+)\b/gm,
    /([A-Z][A-Z0-9]+-\d+)/g,
    /github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)/g,
  ];

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const ref = match[0].trim();
      if (!seen.has(ref)) {
        seen.add(ref);
        refs.push(ref);
      }
    }
  }
  return refs;
}

// ── Diff modes ───────────────────────────────────────────────────────

function buildDiffCmd(commitHash, mode, filePath) {
  const fileArg = filePath ? ` -- ${filePath}` : "";
  const base = `${commitHash}^!${fileArg}`;

  switch (mode) {
    case "patience":
      return `diff --diff-algorithm=patience ${base}`;
    case "histogram":
      return `diff --diff-algorithm=histogram ${base}`;
    case "word":
      return `diff --word-diff=porcelain ${base}`;
    case "semantic":
      return `diff -W ${base}`;
    case "standard":
    default:
      return `diff ${base}`;
  }
}

function parseDiff(rawDiff) {
  const substitutions = [];
  let currentFile = null;
  let hunkContext = null;
  let pendingRemoved = [];
  let pendingAdded = [];
  let oldLine = 0;
  let newLine = 0;
  let removeStart = 0;
  let addStart = 0;

  function flushPending() {
    if (pendingRemoved.length > 0 && pendingAdded.length > 0) {
      substitutions.push({
        file: currentFile,
        context: hunkContext,
        removedStart: removeStart,
        addedStart: addStart,
        removed: [...pendingRemoved],
        added: [...pendingAdded],
      });
    }
    pendingRemoved = [];
    pendingAdded = [];
  }

  for (const line of rawDiff.split("\n")) {
    if (line.startsWith("diff --git")) {
      flushPending();
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : "unknown";
      hunkContext = null;
    } else if (isExcluded(currentFile)) {
      continue;
    } else if (line.startsWith("@@")) {
      flushPending();
      const nums = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = nums ? parseInt(nums[1], 10) : 0;
      newLine = nums ? parseInt(nums[2], 10) : 0;
      const ctxMatch = line.match(/@@ .+? @@\s*(.+)/);
      hunkContext = ctxMatch ? ctxMatch[1].trim() : null;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (pendingAdded.length > 0) flushPending();
      if (pendingRemoved.length === 0) removeStart = oldLine;
      pendingRemoved.push(line.slice(1));
      oldLine++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (pendingAdded.length === 0) addStart = newLine;
      pendingAdded.push(line.slice(1));
      newLine++;
    } else {
      flushPending();
      if (!line.startsWith("\\")) { oldLine++; newLine++; }
    }
  }
  flushPending();

  return substitutions;
}

function parseWordDiff(rawDiff) {
  const substitutions = [];
  let currentFile = null;
  let hunkContext = null;
  let pendingRemoved = [];
  let pendingAdded = [];

  function flushPending() {
    if (pendingRemoved.length > 0 && pendingAdded.length > 0) {
      substitutions.push({
        file: currentFile,
        context: hunkContext,
        removedStart: 0,
        addedStart: 0,
        removed: [...pendingRemoved],
        added: [...pendingAdded],
        type: "word",
      });
    }
    pendingRemoved = [];
    pendingAdded = [];
  }

  for (const line of rawDiff.split("\n")) {
    if (line.startsWith("diff --git")) {
      flushPending();
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : "unknown";
      hunkContext = null;
    } else if (isExcluded(currentFile)) {
      continue;
    } else if (line.startsWith("@@")) {
      flushPending();
      const ctxMatch = line.match(/@@ .+? @@\s*(.+)/);
      hunkContext = ctxMatch ? ctxMatch[1].trim() : null;
    } else if (line.startsWith("-")) {
      if (pendingAdded.length > 0) flushPending();
      pendingRemoved.push(line.slice(1));
    } else if (line.startsWith("+")) {
      pendingAdded.push(line.slice(1));
    } else if (line === "~") {
      flushPending();
    }
  }
  flushPending();

  return substitutions;
}

function runMode(cwd, commit, mode, opts) {
  const cmd = buildDiffCmd(commit.hash, mode, opts.file);
  const rawDiff = git(cmd, cwd);
  if (!rawDiff) return [];
  return mode === "word" ? parseWordDiff(rawDiff) : parseDiff(rawDiff);
}

function runAllModes(cwd, commit, opts) {
  const singleModes = ["standard", "patience", "histogram", "word", "semantic"];
  const results = {};
  for (const m of singleModes) {
    results[m] = runMode(cwd, commit, m, opts);
  }
  return results;
}

// ── TUI output ───────────────────────────────────────────────────────

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

function fileIcon(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const icons = {
    js: "◆", ts: "◇", py: "◈", rb: "◉", go: "●", rs: "◎",
    java: "◐", css: "◑", html: "◒", json: "◓", md: "◔",
    yml: "◕", yaml: "◕", sh: "◖", bash: "◖",
  };
  return icons[ext] || "◦";
}

function boxLine(text, width) {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, width - stripped.length - 4);
  return `  ${BOX.v} ${text}${" ".repeat(pad)} ${BOX.v}`;
}

function printSubstitutionsTUI(substitutions, inner, startNum, total) {
  const byFile = {};
  for (const sub of substitutions) {
    if (!byFile[sub.file]) byFile[sub.file] = [];
    byFile[sub.file].push(sub);
  }

  let changeNum = startNum;
  for (const [file, subs] of Object.entries(byFile)) {
    const icon = fileIcon(file);
    console.log(`\n  ${chalk.bold(`${icon} ${file}`)} ${chalk.dim(`(${subs.length} change${subs.length > 1 ? "s" : ""})`)}`);
    console.log(chalk.dim(`  ${"┄".repeat(inner)}`));

    for (const sub of subs) {
      changeNum++;
      const label = chalk.dim(`  ┌─ change ${changeNum}/${total}`);
      const ctxInfo = sub.context ? ` ${chalk.dim.italic(`in ${sub.context}`)}` : "";
      const typeInfo = sub.type === "word" ? chalk.yellow(" [word]") : "";
      console.log(`${label}${ctxInfo}${typeInfo}`);

      const gutterW = sub.type === "word" ? 0 : Math.max(
        String((sub.removedStart || 0) + sub.removed.length - 1).length,
        String((sub.addedStart || 0) + sub.added.length - 1).length
      );

      for (let i = 0; i < sub.removed.length; i++) {
        const ln = gutterW ? String(sub.removedStart + i).padStart(gutterW) + " " : "";
        console.log(chalk.red(`  │ ${chalk.dim(ln)}− ${sub.removed[i]}`));
      }
      for (let i = 0; i < sub.added.length; i++) {
        const ln = gutterW ? String(sub.addedStart + i).padStart(gutterW) + " " : "";
        console.log(chalk.green(`  │ ${chalk.dim(ln)}+ ${sub.added[i]}`));
      }
      console.log(chalk.dim("  └" + "┄".repeat(20)));
    }
  }
  return changeNum;
}

function printTUI(commit, context, substitutions, opts, mode) {
  const W = Math.min(process.stdout.columns || 80, 90);
  const inner = W - 4;
  const shortHash = commit.hash.slice(0, 8);
  const dateStr = commit.date.split(" ").slice(0, 2).join(" ");

  console.log("");
  console.log(`  ${BOX.tl}${BOX.h.repeat(inner + 2)}${BOX.tr}`);
  console.log(boxLine(`${chalk.cyan.bold(shortHash)}  ${chalk.white.bold(commit.message)}`, W));
  console.log(boxLine(chalk.dim(`${commit.author} • ${dateStr}`), W));
  if (context.parent_messages.length > 0) {
    console.log(boxLine(chalk.dim(`parent: ${context.parent_messages[0]}`), W));
  }
  if (context.branches.length > 0) {
    console.log(boxLine(chalk.dim(`branch: ${context.branches.join(", ")}`), W));
  }
  if (context.tags.length > 0) {
    console.log(boxLine(chalk.dim(`tags: ${context.tags.join(", ")}`), W));
  }
  if (context.references.length > 0) {
    console.log(boxLine(chalk.dim(`refs: ${context.references.join(", ")}`), W));
  }
  if (context.is_merge) {
    console.log(boxLine(chalk.yellow("⚑ merge commit"), W));
  }
  console.log(boxLine(chalk.dim(`mode: ${mode}`), W));
  console.log(`  ${BOX.bl}${BOX.h.repeat(inner + 2)}${BOX.br}`);

  if (mode === "all" && typeof substitutions === "object" && !Array.isArray(substitutions)) {
    const singleModes = ["standard", "patience", "histogram", "word", "semantic"];
    for (const m of singleModes) {
      const subs = substitutions[m] || [];
      console.log(`\n  ${chalk.bgCyan.black.bold(` ${m.toUpperCase()} `)} ${chalk.dim(`(${subs.length} substitution${subs.length !== 1 ? "s" : ""})`)}`);

      if (subs.length === 0) {
        console.log(chalk.dim("  No substitutions in this mode."));
        continue;
      }

      if (opts.stat) {
        const totalR = subs.reduce((s, b) => s + b.removed.length, 0);
        const totalA = subs.reduce((s, b) => s + b.added.length, 0);
        const files = [...new Set(subs.map((s) => s.file))];
        console.log(`  ${chalk.bold(subs.length)} substitution(s) across ${chalk.bold(files.length)} file(s)`);
        console.log(`  ${chalk.red(`− ${totalR} removed`)}  ${chalk.dim("→")}  ${chalk.green(`+ ${totalA} added`)}`);
      } else {
        printSubstitutionsTUI(subs, inner, 0, subs.length);
      }
    }
    console.log("");
    return;
  }

  if (!Array.isArray(substitutions) || substitutions.length === 0) {
    console.log(chalk.dim("\n  No substitutions — only pure additions or deletions.\n"));
    return;
  }

  if (opts.stat) {
    const totalR = substitutions.reduce((s, b) => s + b.removed.length, 0);
    const totalA = substitutions.reduce((s, b) => s + b.added.length, 0);
    const files = [...new Set(substitutions.map((s) => s.file))];
    console.log("");
    console.log(`  ${chalk.bold(substitutions.length)} substitution(s) across ${chalk.bold(files.length)} file(s)`);
    console.log(`  ${chalk.red(`− ${totalR} lines removed`)}  ${chalk.dim("→")}  ${chalk.green(`+ ${totalA} lines added`)}`);
    console.log("");
    return;
  }

  printSubstitutionsTUI(substitutions, inner, 0, substitutions.length);

  const totalR = substitutions.reduce((s, b) => s + b.removed.length, 0);
  const totalA = substitutions.reduce((s, b) => s + b.added.length, 0);
  const fileCount = [...new Set(substitutions.map((s) => s.file))].length;
  console.log("");
  console.log(chalk.dim("  ─".repeat(Math.floor(inner / 2))));
  console.log(
    `  ${chalk.bold(substitutions.length)} substitution${substitutions.length > 1 ? "s" : ""} in ` +
    `${chalk.bold(fileCount)} file${fileCount > 1 ? "s" : ""}:  ` +
    `${chalk.red(`−${totalR}`)} removed  ${chalk.green(`+${totalA}`)} added`
  );
  console.log("");
}

// ── Plain text output ────────────────────────────────────────────────

function printContextPlain(context) {
  if (context.parent_messages.length > 0) {
    console.log(`parent: ${context.parent_messages.join("; ")}`);
  }
  if (context.branches.length > 0) console.log(`branch: ${context.branches.join(", ")}`);
  if (context.tags.length > 0) console.log(`tags: ${context.tags.join(", ")}`);
  if (context.references.length > 0) console.log(`refs: ${context.references.join(", ")}`);
  if (context.is_merge) console.log("merge: yes");
  console.log(`position: commit #${context.commit_position}`);

  const trailerKeys = Object.keys(context.trailers);
  if (trailerKeys.length > 0) {
    for (const key of trailerKeys) {
      for (const val of context.trailers[key]) {
        console.log(`${key}: ${val}`);
      }
    }
  }

  const ds = context.diff_stats;
  if (ds.files.length > 0) {
    console.log(`diff-stats: +${ds.total_insertions}/-${ds.total_deletions} across ${ds.files.length} file(s)`);
    for (const f of ds.files) {
      console.log(`  ${f.status} ${f.path} (+${f.insertions}/-${f.deletions})`);
    }
  }
}

function printSubstitutionsPlain(substitutions, startNum, total) {
  const byFile = {};
  for (const sub of substitutions) {
    if (!byFile[sub.file]) byFile[sub.file] = [];
    byFile[sub.file].push(sub);
  }

  let changeNum = startNum;
  for (const [file, subs] of Object.entries(byFile)) {
    console.log(`\nfile: ${file}`);
    for (const sub of subs) {
      changeNum++;
      const typeTag = sub.type === "word" ? " [word]" : "";
      const header = `[change ${changeNum}/${total}]${typeTag}` +
        (sub.context ? ` in ${sub.context}` : "");
      console.log(header);

      for (let i = 0; i < sub.removed.length; i++) {
        const ln = sub.type === "word" ? "" : `${(sub.removedStart || 0) + i} `;
        console.log(`  ${ln}- ${sub.removed[i]}`);
      }
      for (let i = 0; i < sub.added.length; i++) {
        const ln = sub.type === "word" ? "" : `${(sub.addedStart || 0) + i} `;
        console.log(`  ${ln}+ ${sub.added[i]}`);
      }
    }
  }
  return changeNum;
}

function printPlain(commit, context, substitutions, opts, mode) {
  const shortHash = commit.hash.slice(0, 8);
  const dateStr = commit.date.split(" ").slice(0, 2).join(" ");

  console.log(`commit ${shortHash}`);
  console.log(`message: ${commit.message}`);
  if (commit.body) console.log(`body: ${commit.body}`);
  console.log(`author: ${commit.author} <${commit.email}>`);
  console.log(`date: ${dateStr}`);
  console.log(`mode: ${mode}`);
  printContextPlain(context);

  if (mode === "all" && typeof substitutions === "object" && !Array.isArray(substitutions)) {
    const singleModes = ["standard", "patience", "histogram", "word", "semantic"];
    for (const m of singleModes) {
      const subs = substitutions[m] || [];
      console.log(`\n=== ${m.toUpperCase()} MODE (${subs.length} substitutions) ===`);
      if (subs.length === 0) {
        console.log("No substitutions.");
        continue;
      }
      printSubstitutionsPlain(subs, 0, subs.length);
    }
    return;
  }

  if (!Array.isArray(substitutions) || substitutions.length === 0) {
    console.log("\nNo substitutions (only pure additions or deletions).");
    return;
  }

  printSubstitutionsPlain(substitutions, 0, substitutions.length);

  const totalR = substitutions.reduce((s, b) => s + b.removed.length, 0);
  const totalA = substitutions.reduce((s, b) => s + b.added.length, 0);
  console.log(`\n${substitutions.length} substitution(s), ${totalR} lines removed, ${totalA} lines added`);
}

// ── JSON output ──────────────────────────────────────────────────────

function subsToJSON(substitutions) {
  const byFile = {};
  for (const sub of substitutions) {
    if (!byFile[sub.file]) byFile[sub.file] = [];
    byFile[sub.file].push(sub);
  }

  return {
    total_substitutions: substitutions.length,
    total_removed_lines: substitutions.reduce((s, b) => s + b.removed.length, 0),
    total_added_lines: substitutions.reduce((s, b) => s + b.added.length, 0),
    files_changed: Object.keys(byFile).length,
    files: Object.entries(byFile).map(([file, subs]) => ({
      path: file,
      substitutions: subs.map((s) => ({
        context: s.context || null,
        type: s.type || "line",
        removed: { start_line: s.removedStart || 0, lines: s.removed },
        added: { start_line: s.addedStart || 0, lines: s.added },
      })),
    })),
  };
}

function printJSON(commit, context, substitutions, mode) {
  const output = {
    commit: {
      hash: commit.hash,
      short: commit.hash.slice(0, 8),
      message: commit.message,
      body: commit.body || null,
      author: { name: commit.author, email: commit.email },
      date: commit.date,
    },
    context,
    mode,
  };

  if (mode === "all" && typeof substitutions === "object" && !Array.isArray(substitutions)) {
    output.modes = {};
    for (const [m, subs] of Object.entries(substitutions)) {
      output.modes[m] = subsToJSON(subs);
    }
  } else {
    const arr = Array.isArray(substitutions) ? substitutions : [];
    Object.assign(output, subsToJSON(arr));
  }

  console.log(JSON.stringify(output, null, 2));
}

// ── Main ─────────────────────────────────────────────────────────────

function run(commitHash, directory, opts) {
  const cwd = path.resolve(directory);
  git("rev-parse --git-dir", cwd);

  const mode = opts.mode || "standard";
  if (!DIFF_MODES.includes(mode)) {
    console.error(chalk.red(`Error: unknown mode "${mode}". Use: ${DIFF_MODES.join(", ")}`));
    process.exit(1);
  }

  const commit = getCommit(cwd, commitHash);
  if (!commit) {
    if (opts.json) {
      console.log(JSON.stringify({ error: `commit ${commitHash} not found` }));
    } else {
      console.error(chalk.red(`Error: commit ${commitHash} not found.`));
    }
    process.exit(1);
  }

  const context = getCommitContext(cwd, commit);
  const substitutions = mode === "all"
    ? runAllModes(cwd, commit, opts)
    : runMode(cwd, commit, mode, opts);

  if (opts.json) {
    printJSON(commit, context, substitutions, mode);
  } else if (opts.plain) {
    printPlain(commit, context, substitutions, opts, mode);
  } else {
    printTUI(commit, context, substitutions, opts, mode);
  }
}

program.parse();
