#!/usr/bin/env node

const { Command } = require("commander");
const { execSync } = require("child_process");
const path = require("path");
const chalk = require("chalk");

const program = new Command();

program
  .name("differ")
  .description("Analyze git commits to see what was removed and added")
  .version("1.0.0")
  .argument("[directory]", "Git repository directory to analyze", ".")
  .option("-n, --count <number>", "Number of commits to show", "10")
  .option("-a, --author <name>", "Filter commits by author")
  .option("--since <date>", "Show commits after date (e.g. 2024-01-01)")
  .option("--until <date>", "Show commits before date")
  .option("-f, --file <path>", "Only show changes for a specific file")
  .option("--stat", "Show summary statistics only (no line details)")
  .action(run);

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

function getCommits(cwd, opts) {
  const args = ["log", `--max-count=${opts.count}`, "--format=%H||%an||%ai||%s"];
  if (opts.author) args.push(`--author=${opts.author}`);
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.until) args.push(`--until=${opts.until}`);
  if (opts.file) args.push("--", opts.file);

  const raw = git(args.join(" "), cwd);
  if (!raw) return [];

  return raw.split("\n").map((line) => {
    const [hash, author, date, ...msgParts] = line.split("||");
    return { hash, author, date, message: msgParts.join("||") };
  });
}

function parseDiff(rawDiff) {
  const removed = [];
  const added = [];
  let currentFile = null;

  for (const line of rawDiff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : "unknown";
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed.push({ file: currentFile, content: line.slice(1) });
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push({ file: currentFile, content: line.slice(1) });
    }
  }

  return { removed, added };
}

function printSection(label, items, colorFn, symbol) {
  if (items.length === 0) return;

  console.log(colorFn(`\n  ${label} (${items.length} lines):`));

  // Group by file
  const byFile = {};
  for (const item of items) {
    const f = item.file || "unknown";
    if (!byFile[f]) byFile[f] = [];
    byFile[f].push(item.content);
  }

  for (const [file, lines] of Object.entries(byFile)) {
    console.log(colorFn.bold(`    ${file}`));
    for (const l of lines) {
      console.log(colorFn(`      ${symbol} ${l}`));
    }
  }
}

function run(directory, opts) {
  const cwd = path.resolve(directory);

  // Verify it's a git repo
  git("rev-parse --git-dir", cwd);

  const commits = getCommits(cwd, opts);

  if (commits.length === 0) {
    console.log(chalk.yellow("No commits found matching your criteria."));
    return;
  }

  console.log(
    chalk.bold(`\n📋 Showing ${commits.length} commit(s) in ${cwd}\n`)
  );
  console.log(chalk.dim("─".repeat(70)));

  for (const commit of commits) {
    const shortHash = commit.hash.slice(0, 8);
    const dateStr = commit.date.split(" ").slice(0, 2).join(" ");

    console.log(
      `\n${chalk.cyan.bold(shortHash)} ${chalk.white.bold(commit.message)}`
    );
    console.log(
      chalk.dim(`  ${commit.author} • ${dateStr}`)
    );

    // Get diff for this commit
    const diffArgs = commit.hash + "^!" + (opts.file ? ` -- ${opts.file}` : "");
    const rawDiff = git(`diff ${diffArgs}`, cwd);

    if (!rawDiff) {
      console.log(chalk.dim("  (no diff available — initial or merge commit)"));
      console.log(chalk.dim("─".repeat(70)));
      continue;
    }

    const { removed, added } = parseDiff(rawDiff);

    if (opts.stat) {
      console.log(
        `  ${chalk.red(`− ${removed.length} removed`)}  ${chalk.green(`+ ${added.length} added`)}`
      );
    } else {
      printSection("REMOVED", removed, chalk.red, "−");
      printSection("ADDED", added, chalk.green, "+");

      if (removed.length === 0 && added.length === 0) {
        console.log(chalk.dim("  (no line-level changes)"));
      }
    }

    console.log(chalk.dim("\n" + "─".repeat(70)));
  }

  // Summary
  console.log("");
}

program.parse();
