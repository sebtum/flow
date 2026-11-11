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
- The task record `.workflow/<task>.md`: its **Spec** and previous **Findings**.
- The requirement sources the Spec links to.
- The code: `git diff <baseline revision>`, `git status --short` (read new untracked files too, except anything under `.workflow/`), and surrounding code and callers.
- Results of checks you run yourself.

Never open `.workflow/*.log.md`. It holds the author's claims, not evidence.

## Services
If `.workflow/verify-env.json` exists, the checks need a private copy of the repo's services:
1. Before running checks, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-env.js" up` with Bash and `run_in_background: true`, and wait for it to finish. It creates a throwaway worktree of the code under review (HEAD plus uncommitted and untracked changes) and starts the services there on free ports. If it fails, the checks that need the services go under Blocked, with its message.
2. Run every check from Spec → Checks inside the printed `WORKTREE`, with the printed variables, e.g. `cd "<WORKTREE>" && FLOW_RUN_ID=<id> FLOW_PORT_BASE=<base> make e2e`. A Directory in the Checks table is relative to the worktree. Keep reading the code in the repository itself.
3. Don't run the env's up or down commands yourself, and nothing else that stops, resets or deletes those services or their data.
4. At the end, even if checks failed, run the printed `Tear down when done:` command. If it reports `Worktree changed:`, list those paths under Open questions.

## Procedure
1. Restate the milestone's acceptance criteria and relevant constraints in your own words.
2. Read the changed code and enough of its callers and callees to understand the actual control flow. Don't review from a summary.
3. Run the checks listed in Spec → Checks, plus any repo-required scanners. Reuse an earlier result only if source, dependencies, command and environment are unchanged since; otherwise rerun. A check that can't run (missing tool, service, permission or sandbox) goes under Blocked with the reason. Don't report it as passed or skipped, and don't silently swap in a weaker check.
4. Probe beyond the happy-path tests: boundary values, empty/invalid input, error paths, retries, concurrency, partial failure. Use scratch commands or temporary scripts outside the repo; don't modify repo files.
5. Review in one pass:
   - Requirements: every acceptance criterion met, nothing out of scope added. Items in Spec → Next steps are known deferred work, so don't report them as defects. But if one of them is actually required by this milestone's acceptance criteria, report that as a defect.
   - Correctness and integration with existing code; backward compatibility.
   - Security and privacy where applicable: authorization boundaries, input handling, injection, secrets or sensitive data in logs and errors, unsafe defaults, transactions, race conditions. Don't disable existing security controls.
   - Tests: do they actually check the behaviour, including failure paths?
   - Test changes are high-risk: any modified or deleted test, skipped or removed check, or loosened assertion in the diff goes in Findings, with whether it's justified by the Spec, even if it looks harmless.
   - Missing tests: don't add them yourself. Write the proposed test (name, setup, assertion) under Optional so `/flow:execute fix M<n>` can add it.
6. For a re-verify after fixes: recheck each earlier finding, then rerun the full relevant checks on the final state.

## Output
Append one block to the record's **Findings** section, the only file you edit:

```
### M<n> — verify <date> @ <git rev-parse --short HEAD> (+ uncommitted if any)
Defects:        [severity] requirement · file:line · failure scenario · evidence
Open questions: ...
Optional:       ...
Blocked:        check → why it couldn't run (or "none")
Checks run:     command → result
```

A block with Blocked items is incomplete, not clean: the milestone isn't done until the check runs or the user accepts the gap.

Then report the same summary to the user. If you find nothing, say what you checked; it is not proof of correctness or security.

Note: shell access remains available, so this skill is not enforced read-only. It relies on these instructions.
