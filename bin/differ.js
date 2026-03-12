#!/usr/bin/env node

const { Command } = require("commander");
const { execSync } = require("child_process");
const path = require("path");
const chalk = require("chalk");

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
  .action(run);

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

function getCommit(cwd, hash) {
  const SEP = "\x1f";
  const raw = git(`log -1 --format=%H${SEP}%an${SEP}%ae${SEP}%ai${SEP}%s${SEP}%b ${hash}`, cwd);
  if (!raw) return null;
  const [fullHash, author, email, date, subject, ...bodyParts] = raw.split(SEP);
  return {
    hash: fullHash,
    author,
    email,
    date,
    message: subject,
    body: bodyParts.join("").trim(),
  };
}

// ── Diff parser ──────────────────────────────────────────────────────
// Extracts only substitutions: contiguous removed lines immediately
// followed by contiguous added lines. Pure additions and pure
// deletions are skipped — we only care about code that was *replaced*.

function parseDiff(rawDiff) {
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
    } else if (line.startsWith("@@")) {
      flushPending();
      const ctxMatch = line.match(/@@ .+? @@\s*(.+)/);
      hunkContext = ctxMatch ? ctxMatch[1].trim() : null;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (pendingAdded.length > 0) flushPending();
      pendingRemoved.push(line.slice(1));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      pendingAdded.push(line.slice(1));
    } else {
      flushPending();
    }
  }
  flushPending();

  return substitutions;
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

function printTUI(commit, substitutions, opts) {
  const W = Math.min(process.stdout.columns || 80, 90);
  const inner = W - 4;
  const shortHash = commit.hash.slice(0, 8);
  const dateStr = commit.date.split(" ").slice(0, 2).join(" ");

  // Header box
  console.log("");
  console.log(`  ${BOX.tl}${BOX.h.repeat(inner + 2)}${BOX.tr}`);
  console.log(boxLine(
    `${chalk.cyan.bold(shortHash)}  ${chalk.white.bold(commit.message)}`, W
  ));
  console.log(boxLine(
    chalk.dim(`${commit.author} • ${dateStr}`), W
  ));
  console.log(`  ${BOX.bl}${BOX.h.repeat(inner + 2)}${BOX.br}`);

  if (substitutions.length === 0) {
    console.log(chalk.dim("\n  No substitutions — only pure additions or deletions.\n"));
    return;
  }

  // Stat mode
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

  // Group by file
  const byFile = {};
  for (const sub of substitutions) {
    if (!byFile[sub.file]) byFile[sub.file] = [];
    byFile[sub.file].push(sub);
  }

  let changeNum = 0;
  const totalChanges = substitutions.length;

  for (const [file, subs] of Object.entries(byFile)) {
    const icon = fileIcon(file);
    console.log(`\n  ${chalk.bold(`${icon} ${file}`)} ${chalk.dim(`(${subs.length} change${subs.length > 1 ? "s" : ""})`)}`);
    console.log(chalk.dim(`  ${"┄".repeat(inner)}`));

    for (const sub of subs) {
      changeNum++;
      const label = chalk.dim(`  ┌─ change ${changeNum}/${totalChanges}`);
      if (sub.context) {
        console.log(`${label} ${chalk.dim.italic(`in ${sub.context}`)}`);
      } else {
        console.log(label);
      }

      for (const l of sub.removed) {
        console.log(chalk.red(`  │ − ${l}`));
      }
      console.log(chalk.yellow(`  │ ${"▼".repeat(3)}`));
      for (const l of sub.added) {
        console.log(chalk.green(`  │ + ${l}`));
      }
      console.log(chalk.dim("  └" + "┄".repeat(20)));
    }
  }

  // Footer summary
  const totalR = substitutions.reduce((s, b) => s + b.removed.length, 0);
  const totalA = substitutions.reduce((s, b) => s + b.added.length, 0);
  const files = Object.keys(byFile);
  console.log("");
  console.log(chalk.dim("  ─".repeat(Math.floor(inner / 2))));
  console.log(
    `  ${chalk.bold(totalChanges)} substitution${totalChanges > 1 ? "s" : ""} in ` +
    `${chalk.bold(files.length)} file${files.length > 1 ? "s" : ""}:  ` +
    `${chalk.red(`−${totalR}`)} removed  ${chalk.green(`+${totalA}`)} added`
  );
  console.log("");
}

// ── JSON output ──────────────────────────────────────────────────────

function printJSON(commit, substitutions) {
  const byFile = {};
  for (const sub of substitutions) {
    if (!byFile[sub.file]) byFile[sub.file] = [];
    byFile[sub.file].push(sub);
  }

  const output = {
    commit: {
      hash: commit.hash,
      short: commit.hash.slice(0, 8),
      message: commit.message,
      body: commit.body || null,
      author: { name: commit.author, email: commit.email },
      date: commit.date,
    },
    summary: {
      total_substitutions: substitutions.length,
      total_removed_lines: substitutions.reduce((s, b) => s + b.removed.length, 0),
      total_added_lines: substitutions.reduce((s, b) => s + b.added.length, 0),
      files_changed: Object.keys(byFile).length,
    },
    files: Object.entries(byFile).map(([file, subs]) => ({
      path: file,
      substitutions: subs.map((s) => ({
        context: s.context || null,
        removed: s.removed,
        added: s.added,
      })),
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

// ── Main ─────────────────────────────────────────────────────────────

function run(commitHash, directory, opts) {
  const cwd = path.resolve(directory);
  git("rev-parse --git-dir", cwd);

  const commit = getCommit(cwd, commitHash);
  if (!commit) {
    if (opts.json) {
      console.log(JSON.stringify({ error: `commit ${commitHash} not found` }));
    } else {
      console.error(chalk.red(`Error: commit ${commitHash} not found.`));
    }
    process.exit(1);
  }

  const diffArgs = commit.hash + "^!" + (opts.file ? ` -- ${opts.file}` : "");
  const rawDiff = git(`diff ${diffArgs}`, cwd);

  const substitutions = rawDiff ? parseDiff(rawDiff) : [];

  if (opts.json) {
    printJSON(commit, substitutions);
  } else {
    printTUI(commit, substitutions, opts);
  }
}

program.parse();
