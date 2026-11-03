# flow

A small Claude Code plugin for spec-driven work in an existing repository. Three commands, one task record.

| Command | Model | Does | Writes |
|---|---|---|---|
| `/flow:plan` | Opus (plan mode) | Discuss scope, plan milestones | **Spec** section of the task record |
| `/flow:execute` | Sonnet | Implement one milestone, or fix its findings | Code, tests, `<task>.log.md` |
| `/flow:verify` | Sonnet | Independent review against the Spec | **Findings** section |

The handoff between phases is the task record in the target repo: `.workflow/<task>.md` (Spec + Findings). Execute keeps its progress notes in a separate `.workflow/<task>.log.md` so the verifier never sees them. The record's template is embedded at the end of `skills/plan/SKILL.md`, so no plugin file has to be read from outside your project.

## One-time setup

```bash
# Install for all your projects (user scope)
claude plugin install flow --marketplace sebtum/flow
# ...or only for the current repo (writes .claude/settings.local.json, not committed)
claude plugin install flow --marketplace sebtum/flow --scope local
```

Then, inside Claude Code, choose the model once (saved as your default):

```
/model opusplan
```

`opusplan` uses Opus in plan mode and Sonnet otherwise. The plan skill also requests Opus for its first turn, and execute/verify request Sonnet, so routing works without switching models by hand.

The repo is private, so installing uses your existing GitHub credentials (e.g. `gh auth login`). From a local clone you can also run `claude plugin install flow --marketplace /absolute/path/to/flow`.

## Daily loop

```
claude
> /flow:plan <goal, or link to the issue/spec>
    ... discuss in plan mode, approve the plan → Spec is written
> /clear
> /flow:execute M1
> /clear
> /flow:verify M1
    ... if there are defects:
> /clear
> /flow:execute fix M1
> /clear
> /flow:verify M1
```

- **Always `/clear` between phases.** A slash command runs in the current conversation and cannot clear it or open a new window. `/clear` gives each phase a fresh context; the task record carries everything forward. A new terminal window works just as well.
- **Small tasks:** one milestone. Same loop.
- **Ambiguity during execution:** execute stops and suggests `/flow:plan <question>`. That is the single, narrow Opus escalation; the answer is recorded under Decisions.

## Several milestones

```
/flow:plan <goal>        → M1 detailed, M2..Mn as one-liners, cut items in Next steps
loop for each milestone k:
  (optional) /clear → /flow:plan Mk     only if Mk is still thin or earlier work changed its assumptions
  /clear → /flow:execute Mk
  /clear → /flow:verify Mk              → fix and re-verify until it's clean, or you accept the gaps
```

- **Planning the bigger picture** happens once, in the first `/flow:plan`. It fixes the goal, the milestone order and dependencies, and what doesn't fit the budget. Later `/flow:plan Mk` runs only add detail to one milestone. If execute or verify shows the goal or scope itself is wrong, run `/flow:plan <what changed>` to re-plan.
- **Next steps:** whatever doesn't fit the time budget or available resources goes into Spec → *Next steps*, with the reason it was deferred. Plan writes it up front, and execute adds what it couldn't finish. At the end, the record shows what was done (verified milestones) and what comes next.
- **Another level of hierarchy?** Not inside one record. When the work splits into independent deliverables that each need their own scope discussion (e.g. separate features or releases over weeks), use one task record per deliverable in `.workflow/`. For a project of a few hours, a single record with 2 to 5 milestones is enough.

## Why verify is unbiased

- It runs after `/clear`, so it never sees the implementation conversation.
- It reads only the **Spec**, the linked requirements, the diff from the baseline revision, and the surrounding code. It never opens `<task>.log.md`, which holds the author's claims. That's why the log is a separate file rather than a section a reader would scroll past.
- It runs the checks itself and probes cases beyond the author's tests.
- Its only edit is appending to **Findings**. It still has shell access, so this is an instruction, not enforced read-only access.

Security reasoning is part of `/flow:verify`. For security-sensitive milestones you can additionally run Claude Code's built-in `/security-review` (after `/clear`) as a second opinion. It reviews your branch against `origin`'s default branch, so it needs an `origin` remote. Neither replaces CI.

## Not included

- No hooks. The target repo's own hooks and CI are left untouched. A changed-file formatter hook is a possible future extension.
- No automatic model router, caching, or extra reviewer agents.

## Limitations

- Plan mode and its approval step are interactive. In headless runs (`claude -p`) plan mode isn't available, and `/flow:plan` writes the record directly.
- Parallel execution depends on the plan marking tasks with disjoint files. Without that, execute works alone.

## Example: adopting an existing repository

```
cd ~/code/some-service
claude
> /flow:plan Add pagination to GET /items, see docs/api.md#items
    (plan reads the README, CI config and the items handler, asks about the
     default page size and the time budget, proposes M1 API + tests and M2 docs;
     you approve → .workflow/items-pagination.md)
> /clear
> /flow:execute M1
> /clear
> /flow:verify M1
```

## Plugin development

Load a working copy for one session without installing it:

```bash
claude --plugin-dir /absolute/path/to/flow
claude plugin validate /absolute/path/to/flow
```

Requires a Claude Code version that supports skill frontmatter `model`, `effort` and `disallowed-tools`, and `claude plugin install --marketplace` (v2.1.292+). Built and validated on 2.1.317.
