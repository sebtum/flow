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
1. Find the task record `.workflow/<task>.md` (ask if several match) and the milestone id from the input. An optional second word is the Codex reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`); default `high`. If the input says `no-env`, add `--no-env`.
2. Run this with Bash and `run_in_background: true` (Codex can take longer than the foreground limit, and starting the services adds time), then wait for it to finish:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-verify.js" --task .workflow/<task>.md --milestone M<n> [--effort <effort>] [--no-env]
   ```
   If the repo has `.workflow/verify-env.json`, the script first starts a private copy of the services in a throwaway worktree, runs Codex there, and tears everything down afterwards. `--no-env` skips that.
3. Read its output. Lines starting with `NOTE:` are messages for you; the last line starts with `STATUS:` once Codex ran.
   - **Exit 0:** append everything except the `NOTE:` and `STATUS:` lines, verbatim, to the end of the record's **Findings** section. That is your only edit. Then summarize the Defects and Open questions for the user.
   - **Exit 4:** append it the same way as exit 0. Then tell the user the verify is **incomplete**, not clean, and list the Blocked items. Usually the fix is the environment (e.g. start Docker, fix `verify-env.json`), then verify again.
   - **Exit 1:** setup problem; Codex didn't run. Show the message (e.g. install Codex, run `codex login`, start Docker, or the services' log tail). Append nothing.
   - **Exit 2:** Codex changed files in the repository or in its worktree, so its findings are rejected. Append nothing. List the changed paths. For changes in the repository, tell the user to inspect them (`git status`, `git diff`) before anything else. Don't revert them yourself.
   - **Exit 3:** Codex failed or returned no Findings block. Append nothing. Show the error and the log location.
   Pass on any `NOTE:` about a kept environment or a failed teardown, with its tear-down command.
4. Always end your report with the `STATUS:` line exactly as printed (if there is one), then the next step:
   - Defects → `/clear` then `/flow:execute fix M<n>`
   - Blocked → fix the environment, then `/clear` and `/flow:verify-codex M<n>` again
   - Clean → the milestone is done if the done rule holds (this block was taken at the current `HEAD`, without uncommitted changes, and lists no Defects and no Blocked checks).
