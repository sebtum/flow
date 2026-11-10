# Improvements

Ideas for `flow`, collected from a design review on 2026-11-10. Items marked Done are implemented; the rest are not. Ordered roughly by
value for effort within each group.

## Verify

1. **Done 2026-11-10.** **Flag test changes as high-risk.** Add a rule to `skills/verify/SKILL.md`: any modified or deleted test, skipped
   check or loosened assertion in the diff is reviewed as high-risk and listed in Findings, even if it looks harmless.
   This targets the most likely way an implementer gets to green, which is weakening the tests.
2. **Say how each acceptance criterion is verified.** Plan writes, per criterion, whether it's checked by a test, a
   probe, or an inspection checklist (for security, docs and compliance criteria that can't be a test). Verify records
   the method it used.
3. **Done 2026-11-10.** **Require a complete Checks list.** Verify only runs what Spec → Checks lists, plus its own probes. Plan should list
   the unit, integration and E2E commands when the repo has them, and say explicitly when one doesn't exist.
4. **Done 2026-11-10.** **Let verify propose missing tests.** Verify doesn't add tests itself (the checker shouldn't write the evidence it
   judges). It can put the proposed test as text in Findings for `execute fix` to add.
5. **Partly done 2026-11-10** (verify now uses `opus`, and `/flow:verify-codex` adds Codex as a second verifier; choosing by risk automatically is still open). **Choose the verify model by risk.** Today verify uses `model: sonnet`, the same as execute, so they can share blind
   spots. For milestones marked high-risk, use a stronger or different model, or a second-opinion pass
   (`/security-review`, Codex, CodeRabbit on the PR). Diversity matters more than the number of reviewers.
6. **Risk tags and focused checklists.** Plan tags each milestone with what it touches (`Touches: auth, db-migration,
   security, ...`). Verify adds a focused checklist per tag, or a focused read-only reviewer per tag, each writing its
   own Findings block. Worth it for auth/IAM, migrations and security; usually not for frontend or routing.
7. **Measure verify itself.** Seed known defects in a test milestone and check the catch rate. Track defects found by CI
   or in production after verify passed.

## Enforcing read-only verify

Today the read-only rule is an instruction: `disallowed-tools` blocks only `Agent` and `NotebookEdit`, and `Edit`,
`Write` and `Bash` stay available.

8. **Level 2, restrict tools:** remove `Edit` / `Write` from verify and have it return Findings as text to be appended
   by something else, or add a PreToolUse hook that blocks writes outside the task record's Findings. Bash can still
   write files, so this alone isn't enough.
9. **Level 3, isolate the environment:** run verify in a separate read-only checkout or worktree, or use Claude Code's
   sandbox to limit where Bash can write.
10. **Partly done 2026-11-10** (enforced for `/flow:verify-codex` by `scripts/codex-verify.js`; not yet for `/flow:verify`). **Detect changes:** after verify, check that `git status` / `git diff` are unchanged apart from the Findings block,
    and fail loudly otherwise.

## Fixes and the end of the loop

11. **Done 2026-11-10.** **A milestone is done only when the latest verify is at HEAD.** Every `execute fix` must be followed by a verify
    before the milestone counts as done. Check that the newest Findings header's revision matches `HEAD` (and that
    there are no uncommitted changes) before execute or plan treats the milestone as closed.
12. **Freeze acceptance tests.** Optionally write the acceptance tests in Plan or a first milestone and mark them as
    not editable by execute. Enforce outside the agent (CODEOWNERS or a CI check that fails if those files change).

## Parallel execution

13. **Interface contracts for parallel tasks.** Disjoint files don't mean independent work (shared interfaces, schema,
    config keys). Plan defines the interfaces between parallel tasks up front.
14. **Integration check after each wave.** Execute already integrates and runs the checks after parallel tasks. Make it
    an explicit gate before the next wave starts.
15. **Pipelined review only when safe.** Reviewing wave N while wave N+1 is being built only works if the review is
    read-only and N+1 doesn't build on unreviewed N. Otherwise keep review after the wave.

## Traceability and permissions

16. **Git as the record of who did what.** One commit per agent run or sub-agent task, with trailers:
    ```
    Flow-Task: <task>
    Flow-Run: M1-execute-2
    Flow-Agent: execute/sonnet (sub-agent: task T2)
    ```
    `git blame` then maps each line to a run, and Findings already record the commit that was checked.
17. **Link runs to transcripts.** A hook writes the Claude Code session ID into the log, so a change can be traced back
    to the conversation that produced it. (Hooks receive the session ID; check whether anything else exposes it.)
18. **Enforce per-agent permissions.** Owned files for sub-agents are an instruction today (`skills/execute/SKILL.md`,
    parallel tasks). A hook can block writes outside an agent's owned files. Strongest version: separate git identities
    or tokens per role (execute commits but can't push; verify can't commit).

## Around the plugin

19. **Chain with a delivery gate.** flow covers requirements → verified code. A pre-push gate such as
    [no-mistakes](https://github.com/kunchenguid/no-mistakes) (isolated worktree, review → test → docs → lint → push →
    PR → CI, CI repairs re-reviewed) or CodeRabbit on the PR covers verified code → merged PR. Document how to use them
    together.
20. **Review the plugin itself.** Run `/security-review` and `/code-review` on the skills and record the results.
21. **Plugin supply chain (not yet designed).** Pinning plugin versions when installing from the marketplace, and who
    reviews changes to skill files.
22. **Team rollout (not yet designed).** How a team adopts flow, how rules / "common sense" files stay current, and
    which outcome metrics show it works.

## Learning from findings without bloating context

23. **Turn recurring findings into rules, with progressive disclosure.** When verify reports the same kind of defect
    twice, propose a rule. Put it where it loads only when relevant: a folder-level `CLAUDE.md`, a skill, or a topic
    file the root `CLAUDE.md` points to. Keep the root file a short index. (`@file` imports load immediately, so they
    don't save context.)
24. **Graduate rules into checks.** If a rule is mechanical, turn it into a lint rule, test or hook and delete the
    prose rule. Automated checks cost no context and can't be ignored.
25. **Regular cleanup.** A command (e.g. `/flow:tidy`) that proposes a diff: merge duplicates, resolve contradictions,
    move detail out of the root file, delete rules that tooling now enforces or that haven't been needed. Each rule
    records its origin (date and verify finding) so cleanup can judge relevance. A human approves the diff in a PR.
26. **Watch for context damage.** If verify findings per milestone rise while the rules grow, the extra context is
    hurting rather than helping.

## Done outside the original list

27. **Done 2026-11-10.** **Name sessions after the stage.** A `UserPromptSubmit` hook (`hooks/session-title.js`) sets
    the session name from the flow command, e.g. `items-pagination · execute M2`, the same as `/rename`.
