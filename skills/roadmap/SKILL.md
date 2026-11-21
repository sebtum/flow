---
name: roadmap
description: Discuss a product's vision and order its features into a short roadmap. Each feature later becomes one task record via /flow:plan.
argument-hint: "[vision | change | (empty: review status)]"
model: opus
effort: high
disable-model-invocation: true
---

# /flow:roadmap

Input: $ARGUMENTS

You own the list of features and their order. You never plan milestones, write task records or edit code. `/flow:plan <feature>` turns one feature into a task record.

## 0. Mode
- If you are not in plan mode, call EnterPlanMode first. You write `.workflow/roadmap.md` only after the user approves.
- Decide what the input is:
  - **A vision or goal**, and no roadmap yet → new roadmap: steps 1–3.
  - **A change** (new feature, reorder, drop, new constraint) → update the existing roadmap: steps 2–3 for what changed.
  - **Empty** → review: step 4.

## 1. Understand
- Read the repo's README, CLAUDE.md and any product or requirement docs the user names. Bounded reads, no helper agents.
- List existing task records (`.workflow/*.md` except `roadmap.md` and `*.log.md`) by name only, so features already planned aren't duplicated.

## 2. Discuss
- Restate the vision in two or three sentences: who it's for, which problem it solves, what outcome counts as success. Ask the user to confirm the wording.
- Agree on users, hard constraints (deadline, platform, budget, compliance) and what is explicitly not now.
- Split the work into features. A feature is a deliverable a user can notice, needs its own scope discussion, and fits one task record of about 2 to 5 milestones. Too big → split it; too small → merge it into a neighbour.
- Order the features by dependency first, then value and risk. Say why the first one is first.
- Suggest a mode per feature (lite / standard / full; see `/flow:plan`), from its risk and how long the code will live.
- Ask only questions whose answers change the list or the order.

## 3. Approve and record
- Present the roadmap via ExitPlanMode. After approval, write `.workflow/roadmap.md` with the template below.
- **Keep it to about one screen.** Every command that opens it pays for it in context. One row per feature, one line per cell. Details belong in the task records, never here. Done features keep a one-line row with a link to their record.
- End with: `/clear` then `/flow:plan <first feature>`.

## 4. Review (no input)
- For each row with a Record, read only that record's Milestones headings and Findings headers. A feature is **done** when every milestone meets the done rule: the newest Findings block for it was taken at the current `HEAD`, without "+ uncommitted", with no open Defects and no Blocked checks. **In progress** when any milestone has a Findings block, **planned** when the record exists.
- Update the Status column (after the user approves in plan mode). Suggest reordering, or new features, only when the records show a reason, e.g. a feature's Next steps that deserve their own feature.
- End with the next feature to plan or continue.

## Template

````markdown
# Roadmap: <product>

<!-- Written by /flow:roadmap. /flow:plan fills in Record and Status for a feature it plans.
     Keep it to about one screen: details live in the task records. -->

## Vision
<two or three sentences: who, which problem, what outcome counts as success>

## Users and constraints
- <user group / hard constraint>

## Features
| # | Feature | Outcome | Depends on | Size | Risk | Mode | Record | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | <name> | <what a user notices> | — | S/M/L | low/med/high | standard | — | not planned |

## Not now
- <idea — why not now>

## Decisions
- <decision — reason>
````
