---
name: verify
description: Independent review of one milestone against the Spec. Run in a fresh context.
argument-hint: "[M<n>]"
model: sonnet
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

## Procedure
1. Restate the milestone's acceptance criteria and relevant constraints in your own words.
2. Read the changed code and enough of its callers and callees to understand the actual control flow. Don't review from a summary.
3. Run the checks listed in Spec → Checks, plus any repo-required scanners. Reuse an earlier result only if source, dependencies, command and environment are unchanged since; otherwise rerun.
4. Probe beyond the happy-path tests: boundary values, empty/invalid input, error paths, retries, concurrency, partial failure. Use scratch commands or temporary scripts outside the repo; don't modify repo files.
5. Review in one pass:
   - Requirements: every acceptance criterion met, nothing out of scope added.
   - Correctness and integration with existing code; backward compatibility.
   - Security and privacy where applicable: authorization boundaries, input handling, injection, secrets or sensitive data in logs and errors, unsafe defaults, transactions, race conditions. Don't disable existing security controls.
   - Tests: do they actually check the behaviour, including failure paths?
6. For a re-verify after fixes: recheck each earlier finding, then rerun the full relevant checks on the final state.

## Output
Append one block to the record's **Findings** section, the only file you edit:

```
### M<n> — verify <date> @ <git rev-parse --short HEAD> (+ uncommitted if any)
Defects:        [severity] requirement · file:line · failure scenario · evidence
Open questions: ...
Optional:       ...
Checks run:     command → result
```

Then report the same summary to the user. If you find nothing, say what you checked; it is not proof of correctness or security.

Note: shell access remains available, so this skill is not enforced read-only. It relies on these instructions.
