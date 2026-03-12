# differ

> See what was _replaced_ in a git commit — not just what changed.

```
  ╭──────────────────────────────────────────────────────────────────╮
  │ 2a5ce8c8  Refactor: rename hello to greet, add subtract         │
  │ Vipul Gupta • 2026-03-13                                        │
  ╰──────────────────────────────────────────────────────────────────╯

  ◈ sample.py (2 changes)
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  ┌─ change 1/2
  │ − def hello():
  │ −     print("Hello World")
  │ ▼▼▼
  │ + def greet(name):
  │ +     print(f"Hello {name}!")
  └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  ┌─ change 2/2
  │ −     return a + b
  │ ▼▼▼
  │ +     result = a + b
  │ +     return result
  └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

  2 substitutions in 1 file:  −3 removed  +7 added
```

Most diff tools show you everything — additions, deletions, context. **differ** focuses on **substitutions**: lines that were removed and immediately replaced with something new. It answers the question _"what did this commit actually change?"_ without the noise.

---

## ✦ Features

```
  ╭───────────────────────────────────────────────╮
  │  ◆  TUI output with box-drawing characters    │
  │  ◈  File-type icons for quick scanning        │
  │  ◓  JSON output for piping to LLMs/scripts    │
  │  ◔  Stat summaries for quick overviews        │
  │  ◖  Filter to a single file with --file       │
  ╰───────────────────────────────────────────────╯
```

## ⚡ Install

```bash
git clone https://github.com/vipulgupta2048/differ.git
cd differ
npm install
npm link      # makes `differ` available globally
```

## 🔧 Usage

```
differ <commit> [directory] [options]
```

| Argument    | Description                          | Default |
|-------------|--------------------------------------|---------|
| `commit`    | Commit hash (or short hash) to analyze | —       |
| `directory` | Path to git repository               | `.`     |

### Options

```
  -f, --file <path>   Only show changes for a specific file
      --stat          Show summary statistics only
      --json          Output as JSON
  -V, --version       Show version number
  -h, --help          Show help
```

### Examples

Analyze the latest commit:

```bash
differ HEAD
```

Inspect a specific commit with the TUI:

```bash
differ a1b2c3d
```

Get a quick stat summary:

```bash
differ a1b2c3d --stat
```
```
  ╭──────────────────────────────────────────────────────────────╮
  │ a1b2c3d4  Refactor auth middleware                           │
  │ dev • 2026-03-10                                             │
  ╰──────────────────────────────────────────────────────────────╯

  5 substitution(s) across 2 file(s)
  − 12 lines removed  →  + 18 lines added
```

Filter to a single file:

```bash
differ HEAD --file src/auth.js
```

Pipe structured JSON to another tool:

```bash
differ HEAD --json | jq '.files[].substitutions'
```

## 🧠 How it works

```
  git log ──▶ commit metadata
                 │
  git diff ──▶ raw unified diff
                 │
            ┌────┴────┐
            │  parser  │   Extracts contiguous −/+ blocks
            └────┬────┘
                 │
         ┌───────┴───────┐
         │ substitutions │   Pairs of (removed → added) lines
         └───────┬───────┘
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
     TUI       JSON      stat
```

differ parses the unified diff output and finds **substitutions** — contiguous blocks where removed lines (`-`) are immediately followed by added lines (`+`). Pure additions and pure deletions are intentionally ignored.

## 📄 License

ISC
