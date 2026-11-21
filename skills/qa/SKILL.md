---
name: qa
description: Turn a milestone's QA procedure into black-box acceptance scripts and run them against the running app, without reading the implementation. Run in a fresh context.
argument-hint: "[M<n>]"
model: sonnet
disable-model-invocation: true
disallowed-tools: Agent, NotebookEdit
---

# /flow:qa

Input: $ARGUMENTS

You test the app from the outside, as a user or API client would. You know what it should do from the Spec, not how it's built. That keeps the acceptance tests independent of the code's author.

If this conversation already contains implementation work, stop and tell the user to run `/clear` first.

## What you may read
- The task record `.workflow/<task>.md`: the milestone's Scenarios and QA procedure, Spec → Mode and lanes, Checks, and the contract files it names. Task records are `.workflow/*.md` except `roadmap.md` and `*.log.md`.
- Public documentation of the interface: README, API docs, the OpenAPI file, `--help` output, the running app itself.
- The repo's existing E2E/QA setup: its config, helpers and earlier QA scripts under Spec → `QA path`.

Never read the application's source code, `git diff`, or `.workflow/*.log.md`. A hook refuses the log. If the procedure leaves out something you need (a URL, a field name, a label), don't look it up in the source. List it as a procedure gap and write the other scenarios.

## 1. Write the scripts
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" start qa --task .workflow/<task>.md`
- Use the repo's own E2E framework if it has one. Otherwise: Playwright Test for web UIs and HTTP APIs (its `request` client covers backends), or a plain test file that runs the built CLI. If the framework isn't installed, stop and say so. Suggest `/flow:plan M<n>` to add a setup milestone. Don't install it yourself.
- **Your lane:** files under Spec → `QA path`, and in the task record only the `acceptance` row of Spec → Checks and procedure gaps under Assumptions and open questions. Nothing else. A hook refuses other edits.
- One test per scenario. Its title starts with the scenario id and carries it as a tag, e.g. `test('S1.2 a limit above the maximum is rejected @S1.2', ...)`.
- Follow the QA procedure step by step and assert every expected result. No conditional skips, no retries that hide failures, no assertions weaker than the procedure. Create test data through the public interface, with fixed values, so runs are repeatable.
- Read the app's address from an environment variable, e.g. `QA_BASE_URL`, never a hard-coded port.

## 2. Run against a private stack
- If `.workflow/verify-env.json` exists: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-env.js" up` with Bash and `run_in_background: true`, and wait for it. It starts a private copy of the services on free ports. Run your scripts **from the repository** (not the worktree) as an outside client, with the printed `FLOW_PORT_BASE`, e.g. `QA_BASE_URL=http://localhost:$FLOW_PORT_BASE npx playwright test qa/`. At the end, even if tests failed, run the printed `Tear down when done:` command.
- Without it: if Spec → Checks says how to reach a running app, use that. Otherwise the scenarios are Blocked: say so and suggest `/flow:plan M<n>` to add a `verify-env.json`.
- For each failing test, reread its procedure step. If your script doesn't match the procedure, fix the script. If the app behaves differently from the procedure, leave the test failing: that is a finding for the judge, not something you fix or soften.

## 3. Record
- Add or update the `acceptance` row in Spec → Checks: Kind `acceptance`, the exact command (with the base URL variable), Directory, Prerequisites (the services). Later milestones rerun it as a regression suite.
- Add each procedure gap to Spec → Assumptions and open questions, as `M<n> QA procedure: <what's missing> — /flow:plan`.
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" check qa --task .workflow/<task>.md`. If it lists files outside the lane, stop and tell the user. Don't revert them yourself.
- Report each scenario → pass / fail (expected vs observed) / Blocked, the procedure gaps, and the files written. You keep no log: the judge reruns the acceptance command itself. From now on the QA scripts are frozen: execute may not edit them. End with `/clear` then the milestone's judge (`Judge:` line; `/flow:verify M<n>` or `/flow:verify-codex M<n>`).
