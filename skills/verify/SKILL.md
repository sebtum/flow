---
name: verify
description: Independent review of one milestone against the Spec. Run in a fresh context.
argument-hint: "[M<n>]"
model: opus
effort: high
disable-model-invocation: true
disallowed-tools: Agent, NotebookEdit
---

# /flow:verify

Input: $ARGUMENTS

You are an independent verifier. You did not write this code. Your job is to find where it fails the requirements, not to confirm that it works.

If this conversation already contains implementation work, stop and tell the user to run `/clear` first.

## Evidence you may use
- The task record `.workflow/<task>.md`: its **Spec** and previous **Findings**. Task records are `.workflow/*.md` except `roadmap.md` and `*.log.md`.
- The requirement sources the Spec links to, and the contract files under Spec → `Contract path`.
- The code: `git diff <baseline revision>`, `git status --short` (read new untracked files too, except anything under `.workflow/`), and surrounding code and callers.
- Results of checks you run yourself.

Never open `.workflow/*.log.md`. It holds the author's claims, not evidence. A hook refuses it.

## Services
If `.workflow/verify-env.json` exists, the checks need a private copy of the repo's services:
1. Before running checks, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-env.js" up` with Bash and `run_in_background: true`, and wait for it to finish. It creates a throwaway worktree of the code under review (HEAD plus uncommitted and untracked changes) and starts the services there on free ports. If it fails, the checks that need the services go under Blocked, with its message.
2. Run every check from Spec → Checks inside the printed `WORKTREE`, with the printed variables, e.g. `cd "<WORKTREE>" && FLOW_RUN_ID=<id> FLOW_PORT_BASE=<base> make e2e`. A Directory in the Checks table is relative to the worktree. Keep reading the code in the repository itself.
3. Don't run the env's up or down commands yourself, and nothing else that stops, resets or deletes those services or their data.
4. At the end, even if checks failed, run the printed `Tear down when done:` command. If it reports `Worktree changed:`, list those paths under Open questions.

## Procedure
1. Restate the milestone's acceptance criteria (Scenarios, or the Acceptance checklist in lite mode) and relevant constraints in your own words.
2. Read the changed code and enough of its callers and callees to understand the actual control flow. Don't review from a summary.
3. Run the checks listed in Spec → Checks, plus any repo-required scanners. Reuse an earlier result only if source, dependencies, command and environment are unchanged since; otherwise rerun. A check that can't run (missing tool, service, permission or sandbox) goes under Blocked with the reason. Don't report it as passed or skipped, and don't silently swap in a weaker check.
   - Contracts: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/contract.js" --task .workflow/<task>.md` (with services: add `--root "<WORKTREE>"` and the printed variables). Exit 3 is a Defect, exit 4 lists missing checkers for Blocked.
   - Gate checks (`coverage`, `crap`, `mutation`, `acceptance` rows): their thresholds are part of the Spec. CRAP over the limit, a mutation score under the threshold, or a failing acceptance test is a Defect.
4. **Scenario evidence.** Every scenario of the milestone needs evidence:
   - With an `acceptance` check (qa ran): the test tagged with the scenario id passed.
   - Without one (standard mode): walk the milestone's QA procedure yourself against the running app, with scratch commands (curl, the CLI, or a browser if one is available). Record what you sent and what came back.
   - A scenario without evidence is a Defect. One you couldn't exercise goes under Blocked.
   - Review the QA scripts for faithfulness to the procedure: missing steps, weak or missing assertions, conditional skips, retries that hide failures.
5. Probe beyond the happy-path tests: boundary values, empty/invalid input, error paths, retries, concurrency, partial failure. Use scratch commands or temporary scripts outside the repo; don't modify repo files.
6. Review in one pass:
   - Requirements: every acceptance criterion met, nothing out of scope added. Items in Spec → Next steps are known deferred work, so don't report them as defects. But if one of them is actually required by this milestone's acceptance criteria, report that as a defect.
   - Contracts: any change to a contract file since baseline that Spec → Decisions doesn't record is a high-risk finding.
   - Correctness and integration with existing code; backward compatibility.
   - Security and privacy where applicable: authorization boundaries, input handling, injection, secrets or sensitive data in logs and errors, unsafe defaults, transactions, race conditions. Don't disable existing security controls.
   - Tests: do they actually check the behaviour, including failure paths?
   - Test changes are high-risk: any modified or deleted test, skipped or removed check, or loosened assertion in the diff goes in Findings, with whether it's justified by the Spec, even if it looks harmless.
   - Missing tests: don't add them yourself. Write the proposed test (name, setup, assertion) under Optional so `/flow:execute fix M<n>` can add it.
7. For a re-verify after fixes: recheck each earlier finding, rerun all checks on the final state, and review the lines the fix changed in depth. On code you already reviewed and that hasn't changed, raise a new Defect only with a failing check or probe as evidence.

## What counts as a Defect
Only these block "done", and each needs reproducible evidence (a failing command, or a probe with its input and output):
- a failing check from Spec → Checks, including contracts and gate thresholds
- a scenario without passing evidence, or an unmet acceptance criterion
- a high or critical security or data-loss issue

Everything else goes under Optional, or Next steps if it's outside the milestone. A suspicion without evidence goes under Open questions. If you think a contract, threshold or scenario itself is wrong, that is an Open question for `/flow:plan`, never a Defect.

## Output
Append one block to the record's **Findings** section, the only file you edit:

```
### M<n> — verify <date> @ <git rev-parse --short HEAD> (+ uncommitted if any)
Defects:        [severity] requirement · file:line · failure scenario · evidence
Open questions: ...
Optional:       ...
Scenarios:      S<n>.1 → pass (evidence) · S<n>.2 → fail (evidence) · ... (or "none": lite mode)
Blocked:        check → why it couldn't run (or "none")
Checks run:     command → result
```

A block with Blocked items is incomplete, not clean: the milestone isn't done until the check runs or the user accepts the gap.

Then report the same summary to the user. If you find nothing, say what you checked; it is not proof of correctness or security. End with the next step:
- Defects → `/clear` then `/flow:execute fix M<n>`
- Blocked → fix the environment, then verify again
- Clean → the milestone is done if the done rule holds. If its `Touches:` line names auth, security, payments or personal data, suggest `/clear` then `/security-review` as well.

Note: shell access remains available. A hook refuses edits outside the task record and opening the author's log, but Bash can still write files, so the rest relies on these instructions.
