---
name: plan
description: Discuss scope and write a milestone plan into the task record. No application code changes.
argument-hint: "[goal | milestone id | question]"
model: opus
effort: high
disable-model-invocation: true
---

# /flow:plan

Input: $ARGUMENTS

You own scope and planning. You never edit application code.

## 0. Mode
- If you are not in plan mode, call EnterPlanMode first. Discussion and planning happen in plan mode; you write the task record only after the user approves.
- Find the task record: list `.workflow/*.md` in the repo root. Reuse the one that matches the input. If none matches, this is a new task; pick a short kebab-case name.
- Decide what the input is:
  - **Goal or requirement link** → new task or re-scope: steps 1–3.
  - **Milestone id** (e.g. `M3`) → detail only that milestone using the existing Spec: step 3. Before relying on earlier milestones as done, apply the done rule below; if one isn't done, say so and suggest verifying it first.
  - **Narrow question** raised during execution → answer it from the Spec, the cited code and requirements. Record the decision under Decisions. Do not replan anything else.

## 1. Understand (targeted, not exhaustive)
- Read requirement sources fully. Read repo instructions (CLAUDE.md, CONTRIBUTING, README), the architecture around the change, and how checks run (CI config, package scripts, Makefile, docs).
- Use Grep/Glob and bounded reads. Do it yourself; don't spawn helper agents.
- Record baseline: `git rev-parse HEAD` and `git status --short`.
- Establish what already works, what is missing, compatibility constraints, and real risks.

## 2. Agree scope
- Recommend scope, non-goals and assumptions.
- Ask only questions whose answers change the implementation. Ask for a time budget if none is given.
- Proceed with sensible defaults for routine choices; list them as assumptions.

## 3. Plan
- Small, dependency-ordered milestones of deliverable behaviour. No separate "verify" milestone; `/flow:verify` runs after each one. Each: observable acceptance criteria, expected changes, tests including important failure cases.
- Detail the next milestone fully; later ones can stay at one or two lines until `/flow:plan <id>`.
- Prefer existing architecture and conventions. Note decisions briefly (one line + reason), not ADRs.
- Mark parallel tasks only when files are disjoint and interfaces are stable; name the files each task owns.
- Reserve budget for integration, verification, docs, and the user's review of the code.
- Fit the plan to the budget. Anything valuable that doesn't fit, or needs resources not available, goes to **Next steps** with the reason. Don't plan it as a milestone.
- **Done rule:** a milestone is done only when its newest Findings block (from `/flow:verify` or `/flow:verify-codex`) was taken at the current `git rev-parse --short HEAD`, has no "+ uncommitted", and lists no open Defects and no Blocked checks (or the user explicitly accepted them). Every `execute fix` needs a new verify.
- Several milestones is normal. Don't add another planning level. If the work clearly splits into independent deliverables that each need their own scope discussion, propose separate task records (one per deliverable) instead.
- Record actual check commands with working directory and prerequisites. Don't invent commands; note missing tools instead of installing them. Cover unit, integration and E2E tests, lint/type checks and any repo-required scanners. Verify runs only what is listed here.
- E2E means the running app tested as a user or client would, not in-process tests. If the repo has no real E2E command, add a Checks row saying it's missing, plus a milestone that adds one, or a Next steps entry if it doesn't fit the budget. Do the same for any other missing level.
- **Services for checks:** if checks need running services (database, API, browser against the web app), verify starts a private copy from `.workflow/verify-env.json`. Write that file when the repo has the commands for it. It isn't application code. Its format:
  ```json
  { "requires": ["docker"], "network": true,
    "up": "make verify-up", "health": "make verify-health", "down": "make verify-down",
    "timeoutSeconds": 900 }
  ```
  The commands run in a throwaway worktree with `FLOW_RUN_ID` and `FLOW_PORT_BASE` set. They must use those for an isolated project name, data and ports, so verify never touches the dev stack. Optional fields: `"copy": [".env"]` for ignored files the stack needs, and `"ports"` (default 4). If the repo lacks commands like these, add a milestone that creates them, with the file, before the milestones whose checks need them.

## 4. Approve and record
- Present the plan via ExitPlanMode. After approval, create or update `.workflow/<task>.md` using the template below. Write only the **Spec** section (plus an empty Findings section for a new record). Never create or read `.workflow/<task>.log.md`; that is execute's file. Link sources rather than copying them.
- End with: `/clear` then `/flow:execute M<n>`.

Tip for the user: keep replying in plan mode to stay on Opus (with `opusplan`), or re-run `/flow:plan <answer>`.

## Task record template

````markdown
# Task: <name>

<!-- Spec: written by /flow:plan. Findings: appended by /flow:verify.
     The author's progress notes live in <task>.log.md (written by /flow:execute,
     never opened by /flow:verify). Keep it compact: link sources, don't copy them. -->

## Spec

### Sources
- <links/paths to requirements, issues, docs>

### Goal
<one or two sentences>

- Scope:
- Non-goals:
- Time budget:

### Baseline
- Revision: <git rev-parse HEAD>
- Pre-existing working-tree changes: <git status --short, or "clean">

### Constraints
- <compatibility, APIs/contracts that must not change, platform limits>

### Decisions
- <decision — reason>

### Assumptions and open questions
- <assumption / question — who resolves it>

### Next steps (not in this budget)
- <item — why deferred: time / resources / out of scope — rough size>

### Checks
<!-- Services for integration/E2E checks: .workflow/verify-env.json (or "none needed"). -->
| Command | Directory | Prerequisites | Source (CI/script/docs) |
|---|---|---|---|

### Milestones
#### M1: <title>
- Depends on: —
- Acceptance (observable):
  - [ ] <criterion>
- Expected changes: <files/modules>
- Tests: <new/changed tests, failure cases>
- Parallel tasks (optional; only with disjoint files):
  - T1: <task> — owns <files>

## Findings

<!-- /flow:verify appends one block per run:
### M1 — verify <date> @ <revision>
Defects / Open questions / Optional, each: severity, requirement, file:line, scenario, evidence.
Blocked: checks that couldn't run, and why. Checks run: command → result. -->
````
