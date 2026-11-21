---
name: clean
description: Lower the CRAP score of a milestone's changed functions by refactoring complex code, without changing behaviour or tests. Run in a fresh context after execute.
argument-hint: "[M<n>]"
model: sonnet
disable-model-invocation: true
disallowed-tools: Agent, NotebookEdit
---

# /flow:clean

Input: $ARGUMENTS

You simplify code that is too complex. You don't add features, change behaviour or touch tests. CRAP (Change Risk Anti-Patterns) per function is `complexity² × (1 − coverage)³ + complexity`. With full coverage it equals the complexity.

If this conversation already contains implementation work, stop and tell the user to run `/clear` first.

## 0. Load
- Open the task record `.workflow/<task>.md` (task records are `.workflow/*.md` except `roadmap.md` and `*.log.md`; ask if several match). Read the Spec: Mode and lanes, Constraints, Checks, the milestone and its contract files. You don't need execute's notes in `.workflow/<task>.log.md`; judge the code by what it does.
- **Stack check.** Clean supports TS/JS and Python. If the changed code is in another language, stop and say: "Clean (CRAP score) doesn't support <language> yet. It would use <JaCoCo, or `go test -coverprofile`, or cargo-llvm-cov> plus lizard. Recommended: skip this gate with the user's OK and run the next one." Then name the next command.
- The `coverage` and `crap` rows in Spec → Checks give the commands and the limit (default 8). If one is missing, or lizard isn't installed, stop and say what is missing. Suggest `/flow:plan M<n>` to add it. Don't install tools yourself.

## 1. Measure
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" start clean --task .workflow/<task>.md`
- Run the `coverage` command, then the `crap` command. Keep its table.

## 2. Refactor
- Work only on rows with Action **refactor**: complexity alone is over the limit, so the function fails even with full coverage.
- Keep behaviour exactly the same: extract helpers, use early returns, replace nested conditionals with lookups, remove duplication. Keep names and signatures that the contract files or other modules use.
- Rows with Action **test-gap** (complexity is fine, coverage too low): don't refactor them. Harden writes their tests next. Low coverage never justifies splitting code into tiny functions.
- **Your lane:** application code only. Never edit tests, QA scripts, contract files or the task record. A hook refuses those edits.
- After each refactor, run the unit tests. All tests that passed before must still pass, and the static contract check must pass: `node "${CLAUDE_PLUGIN_ROOT}/scripts/contract.js" --task .workflow/<task>.md --static`. If a refactor can't be done without changing behaviour or a test, undo your change to that function and list it instead.
- A bug you notice is outside your lane: don't fix it. List it as a suspected bug, with file:line and why.

## 3. Check and record
- Run `coverage` and `crap` again.
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" check clean --task .workflow/<task>.md`. If it lists files outside the lane, stop and tell the user to inspect them. Don't revert them yourself.
- Append to `.workflow/<task>.log.md` under `### M<n> clean`, with Bash (`cat >> .workflow/<task>.log.md <<'EOF'`), so you don't need to open the rest of the log:
  - CRAP before → after for each refactored function
  - **For harden:** the test-gap functions (name, file:line, complexity, coverage) and the suspected bugs
  - functions you couldn't refactor safely, and why
- Report the same briefly. End with `/clear` then the next command: `/flow:harden M<n>` if harden applies (full mode, or `Gates:` lists it), else `/flow:qa M<n>` if qa applies, else the milestone's judge (`Judge:` line; `/flow:verify M<n>` or `/flow:verify-codex M<n>`).
