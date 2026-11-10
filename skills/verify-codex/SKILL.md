---
name: verify-codex
description: Independent review of one milestone by Codex (OpenAI), as a second verifier from another model family. Report only.
argument-hint: "[M<n>] [effort]"
model: sonnet
disable-model-invocation: true
disallowed-tools: Agent, NotebookEdit
---

# /flow:verify-codex

Input: $ARGUMENTS

Codex is the verifier here. You only run it and record its result. Don't review the code yourself, don't add or change findings, and never open `.workflow/*.log.md`.

## Steps
1. Find the task record `.workflow/<task>.md` (ask if several match) and the milestone id from the input. An optional second word is the Codex reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`); default `high`.
2. Run this with Bash and `run_in_background: true` (Codex can take longer than the foreground limit), then wait for it to finish:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-verify.js" --task .workflow/<task>.md --milestone M<n> [--effort <effort>]
   ```
3. Read its output. The last line starts with `STATUS:`.
   - **Exit 0:** append everything except the `STATUS:` line, verbatim, to the end of the record's **Findings** section. That is your only edit. Then summarize the Defects and Open questions for the user.
   - **Exit 1:** setup problem. Show the message (e.g. install Codex or run `codex login`). Append nothing.
   - **Exit 2:** Codex changed files in the repository, so its findings are rejected. Append nothing. List the changed paths and tell the user to inspect them (`git status`, `git diff`) before anything else. Don't revert them yourself.
   - **Exit 3:** Codex failed or returned no Findings block. Append nothing. Show the error and the log location.
4. Always end your report with the `STATUS:` line exactly as printed, then the next step:
   - Defects → `/clear` then `/flow:execute fix M<n>`
   - Clean → the milestone is done if the done rule holds (this block was taken at the current `HEAD`, without uncommitted changes).
