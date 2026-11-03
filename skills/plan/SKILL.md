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
  - **Milestone id** (e.g. `M3`) → detail only that milestone using the existing Spec: step 3.
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
- Record actual check commands with working directory and prerequisites. Don't invent commands; note missing tools instead of installing them.

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

### Checks
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
Defects / Open questions / Optional, each: severity, requirement, file:line, scenario, evidence. -->
````
