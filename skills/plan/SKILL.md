---
name: plan
description: Discuss scope, write the specification, contracts and a milestone plan into the task record. No application code changes.
argument-hint: "[goal | roadmap feature | milestone id | question]"
model: opus
effort: high
disable-model-invocation: true
---

# /flow:plan

Input: $ARGUMENTS

You own scope, specification, interface contracts and planning. You never edit application code. Contract files and `.workflow/verify-env.json` aren't application code.

## 0. Mode
- If you are not in plan mode, call EnterPlanMode first. Discussion and planning happen in plan mode; you write the task record and contract files only after the user approves.
- Task records are `.workflow/*.md` except `roadmap.md` and `*.log.md`. Reuse the one that matches the input. If none matches, this is a new task; pick a short kebab-case name.
- Decide what the input is:
  - **Goal or requirement link** → new task or re-scope: steps 1–4.
  - **Feature from `.workflow/roadmap.md`** (the input names a row of its Features table) → new task for that feature. Read only the Vision and that row. Then steps 1–4. After approval, put the record's path in the row's Record column and set Status to `planned`. Those are your only edits to the roadmap. Otherwise don't open the roadmap.
  - **Milestone id** (e.g. `M3`) → detail only that milestone using the existing Spec: steps 2b–4. Before relying on earlier milestones as done, apply the done rule below; if one isn't done, say so and suggest verifying it first.
  - **Milestone id after the fix limit** (execute stopped because `Fix rounds` ran out) → read the newest Findings for it. With the user, choose: accept the remaining gaps (record under Decisions, with who accepted), cut scope (move it to Next steps), or re-plan the milestone.
  - **Narrow question** raised during execution → answer it from the Spec, the cited code and requirements. Record the decision under Decisions. Do not replan anything else. If the answer changes a contract, edit the contract file and record the change under Decisions, including whether it breaks existing callers.

## 1. Understand (targeted, not exhaustive)
- Read requirement sources fully. Read repo instructions (CLAUDE.md, CONTRIBUTING, README), the architecture around the change, and how checks run (CI config, package scripts, Makefile, docs).
- Use Grep/Glob and bounded reads. Do it yourself; don't spawn helper agents.
- Record baseline: `git rev-parse HEAD` and `git status --short`.
- Detect the stack: `package.json` → TS/JS; `pyproject.toml`, `setup.cfg`, `requirements*.txt` → Python; `pom.xml`, `build.gradle*` → Java; `go.mod` → Go; `Cargo.toml` → Rust.
- Establish what already works, what is missing, compatibility constraints, and real risks.

## 2. Agree scope and mode
- Recommend scope, non-goals and assumptions.
- Ask only questions whose answers change the implementation. Ask for a time budget if none is given.
- Proceed with sensible defaults for routine choices; list them as assumptions.
- Recommend a mode and let the user confirm it:

  | Mode | Steps per milestone | When |
  |---|---|---|
  | lite | plan → execute → verify | small or low-risk work |
  | standard | specification (2b) and contracts → execute → verify; verify walks the QA procedure | most features |
  | full | standard, plus execute → clean → harden → qa → verify-codex | risky or long-lived code |

  A milestone in lite or standard mode can add gates with `Gates: clean, harden, qa`.
- **Stack notice.** The clean and harden gates support TS/JS and Python only. If the stack is anything else and the mode is full, or a milestone lists clean or harden, tell the user plainly before planning further:
  > Clean (CRAP score) and harden (mutation testing) don't support <language> yet. They would use <tools>. Recommended: standard mode, with `Gates: qa` where a black-box test helps.

  Tools: Java → JaCoCo + PIT; Go → `go test -coverprofile` + gremlins; Rust → cargo-llvm-cov + cargo-mutants. Record the notice under Constraints.

## 2b. Specify (standard and full mode)
Turn the user's words into criteria a machine and a person can check.
- **Example mapping** per milestone: list the rules, at least one concrete example per rule (include failure cases and boundaries), and open questions. Show this to the user and ask whether the wording says what they mean. Resolve the questions or record them under Assumptions and open questions.
- **Scenarios:** rewrite the examples as Gherkin with ids `S<milestone>.<n>`:
  ```gherkin
  Scenario: S1.2 A limit above the maximum is rejected
    Given 30 items exist
    When a client calls GET /items?limit=500
    Then the response status is 400
    And the error names the parameter "limit"
  ```
  One behaviour per scenario. Only observable outcomes: responses, output, files, stored data, visible UI text. No internals.
- **QA procedure:** numbered steps a person could follow against the running app. Each step has its preconditions and test data, the action, the expected result, and the scenario ids it covers. Name the public interface each step uses: endpoint, CLI command and flags, or the visible label or role of a UI element. `/flow:qa` turns it into scripts without reading the source code, so it must be complete on its own.

## 3. Plan
- Small, dependency-ordered milestones of deliverable behaviour. No separate "verify" milestone; the judge runs after each one. Each: observable acceptance (Scenarios in standard/full, checkboxes in lite), expected changes, tests including important failure cases.
- Detail the next milestone fully; later ones can stay at one or two lines until `/flow:plan <id>`.
- Prefer existing architecture and conventions. Note decisions briefly (one line + reason), not ADRs.
- **Tasks and waves (optional).** By default a milestone has no tasks: execute codes it alone. Split it into tasks only when all of these hold:
  - the mode is standard or full;
  - the milestone is big: more than about 5 files or 400 changed lines, too much for one agent to keep in view;
  - the parts are independent: separate files, and the interfaces between them are pinned by the contract or exist already.

  Small, exploratory or tightly coupled work stays one piece, even when it has many scenarios. Each task is one line, `- T<n> [W<n>] <what>. Owns: \`<globs>\`. Scenarios: <ids>. After: <tasks>.`:
  - **Owns:** the source and test files it may edit, as paths with a directory (`src/cart/**`, `tests/cart/**`). Tasks in the same wave own disjoint files. Contract and QA files are never owned.
  - **Scenarios:** every task delivers at least one scenario, and a scenario belongs to one task. So there are never more tasks than scenarios. Shared scaffolding (types, setup) belongs to the first task that needs it, not to a task of its own.
  - **W<n> and After:** tasks in one wave run as parallel agents. A task that needs another's code goes in a later wave and names it in `After:`.
  - Limits: at least 2 tasks, at most 4 per wave and 6 per milestone. More than that means the milestone is too big: split the milestone instead.
  - Check the split before the approval step: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" tasks --task .workflow/<task>.md --milestone M<n>`. It enforces the rules above; fix every problem it lists. A hook holds each execute agent to its task's files.
- Reserve budget for integration, verification, docs, and the user's review of the code.
- Fit the plan to the budget. Anything valuable that doesn't fit, or needs resources not available, goes to **Next steps** with the reason. Don't plan it as a milestone.
- **Done rule:** a milestone is done only when its newest Findings block (from `/flow:verify` or `/flow:verify-codex`) was taken at the current `git rev-parse --short HEAD`, has no "+ uncommitted", and lists no open Defects and no Blocked checks (or the user explicitly accepted them). Every `execute fix` needs a new verify. After `Fix rounds` fixes (default 2), execute stops and the user decides with `/flow:plan M<n>`.
- Several milestones is normal. Don't add another planning level. If the work clearly splits into independent deliverables that each need their own scope discussion, propose separate task records or `/flow:roadmap`.
- **Lanes.** Fill `Test paths`, `QA path` and `Contract path` with globs that match this repo's layout, e.g. `tests/**, **/*.test.ts`. A pattern without `/` matches file names anywhere. Hooks and scripts use these to keep each step inside its own files, so be precise. Tool output (coverage, Stryker, mutmut, cosmic-ray's `cr.sqlite`) must be gitignored; add that to a setup milestone if they aren't.
- **Contracts (standard and full).** When a milestone adds or changes a public interface, write its contract under `Contract path` (default `contracts/`) as part of the approved plan. It pins the shape (names, inputs, outputs, errors), not the behaviour.

  | Interface | Contract file | Check, Kind |
  |---|---|---|
  | HTTP API | OpenAPI `openapi.yaml` | Export the app's OpenAPI (e.g. FastAPI's `app.openapi()`) and compare: `oasdiff changelog <contract> <exported> --fail-on INFO` fails on any difference (`contract`); Schemathesis against the running app with a fixed seed, `st run <file> --url <base> --hypothesis-seed=1` (`contract-live`) |
  | TS module | `*.contract.ts`: the interface types plus `const _check: Api = impl;` lines | `tsc --noEmit -p <contract tsconfig>` (`contract`) |
  | Python module | `.pyi` stub files | `python -m mypy.stubtest <package>` (`contract`); `griffe check <package> -a <baseline>` for breaking changes (`contract`) |
  | Events, files, CLI JSON output | JSON Schema | `check-jsonschema --schemafile <schema> <sample>` or `ajv validate` (`contract`) |

  `contract` rows run without the app (the execute Stop hook runs them). `contract-live` rows need the services. After approval only `/flow:plan` changes contract files; record every change under Decisions.
- **Gate checks** (full mode, or milestones with clean/harden gates), as Checks rows:
  - `coverage`: a command that writes LCOV. Vitest `vitest run --coverage --coverage.reporter=lcov`; Jest `jest --coverage --coverageReporters=lcov`; c8 `c8 --reporter=lcov <test command>`; Python `coverage run -m pytest && coverage lcov -o coverage/lcov.info`.
  - `crap`: `node "${CLAUDE_PLUGIN_ROOT}/scripts/crap.js" --lcov <lcov file> --base <baseline revision> --task .workflow/<task>.md`. Needs lizard (`pip install lizard`). Limit 8 per changed function unless the Spec says otherwise (`--max`).
  - `mutation`: scoped to changed source files. Threshold: mutation score of at least 80% on changed files unless the Spec says otherwise. Equivalent mutants are listed with a reason.
    - TS/JS: Stryker `npx stryker run --mutate <files>`.
    - Python on Linux, macOS or WSL: mutmut `mutmut run` with `paths_to_mutate` (then `mutmut results`). mutmut needs `fork`, so it doesn't run on native Windows.
    - Python on native Windows (`uname -s` starts with `MINGW` or `MSYS`): cosmic-ray, not mutmut in WSL. WSL means a second environment and a Linux VM that takes memory. A `cosmic-ray.toml` with `module-path` set to the changed files and `test-command` set to the unit test command, then `cosmic-ray init cosmic-ray.toml cr.sqlite && cosmic-ray exec cosmic-ray.toml cr.sqlite && cr-rate --fail-over 20 cr.sqlite` (survival of at most 20% = score of at least 80%; `cr-report cr.sqlite` lists survivors). Confirm the flags with `--help` on the installed version before recording the row. cosmic-ray edits source files in place while it runs and restores them after each mutant.
  - `acceptance`: added by `/flow:qa`.
- **Judge and risk tags** per milestone: `Judge: verify` (lite, standard) or `Judge: verify-codex` (full), and `Touches:` for what it changes (auth, security, payments, data, migration, ...). If it touches auth, security, payments or personal data, recommend `/security-review` after the judge.
- Record actual check commands with Kind, working directory and prerequisites. Don't invent commands; note missing tools instead of installing them. Cover unit, integration and E2E tests, lint/type checks and any repo-required scanners. Verify runs only what is listed here. Write a pipe inside a command as `\|`.
- E2E means the running app tested as a user or client would, not in-process tests. If the repo has no real E2E command, add a Checks row saying it's missing, plus a milestone that adds one, or a Next steps entry if it doesn't fit the budget. Do the same for any other missing level, including the gate tools (lizard, Stryker, mutmut or cosmic-ray, Playwright, the contract checkers).
- **Services for checks:** if checks need running services (database, API, browser against the web app), verify and qa start a private copy from `.workflow/verify-env.json`. Write that file when the repo has the commands for it. Its format:
  ```json
  { "requires": ["docker"], "network": true,
    "up": "make verify-up", "health": "make verify-health", "down": "make verify-down",
    "timeoutSeconds": 900 }
  ```
  The commands run in a throwaway worktree with `FLOW_RUN_ID` and `FLOW_PORT_BASE` set. They must use those for an isolated project name, data and ports, so verify never touches the dev stack. Optional fields: `"copy": [".env"]` for ignored files the stack needs, and `"ports"` (default 4). If the repo lacks commands like these, add a milestone that creates them, with the file, before the milestones whose checks need them. Say in Checks how a client reaches the app, e.g. `QA_BASE_URL=http://localhost:$FLOW_PORT_BASE`.

## 4. Approve and record
- Present the plan via ExitPlanMode. After approval, create or update `.workflow/<task>.md` using the template below, and write the contract files. Write only the **Spec** section (plus an empty Findings section for a new record). Never create or read `.workflow/<task>.log.md`; that is execute's file. Link sources rather than copying them.
- End with: `/clear` then `/flow:execute M<n>`.

Tip for the user: keep replying in plan mode to stay on Opus (with `opusplan`), or re-run `/flow:plan <answer>`.

## Task record template

````markdown
# Task: <name>

<!-- Spec: written by /flow:plan. Findings: appended by /flow:verify or /flow:verify-codex.
     The author's notes live in <task>.log.md (execute, clean, harden, qa), never opened by the verifier.
     Keep it compact: link sources, don't copy them. -->

## Spec

### Sources
- <links/paths to requirements, issues, docs, roadmap row>

### Goal
<one or two sentences>

- Scope:
- Non-goals:
- Time budget:

### Mode and lanes
- Mode: <lite | standard | full>
- Fix rounds: 2
- Test paths: <globs, e.g. `tests/**`, `**/*.test.ts`>
- QA path: <glob, e.g. `qa/**`, or none>
- Contract path: <glob, e.g. `contracts/**`, or none>

### Baseline
- Revision: <git rev-parse HEAD>
- Pre-existing working-tree changes: <git status --short, or "clean">

### Constraints
- <compatibility, APIs/contracts that must not change, platform limits, stack notice>

### Decisions
- <decision — reason>

### Assumptions and open questions
- <assumption / question — who resolves it>

### Next steps (not in this budget)
- <item — why deferred: time / resources / out of scope — rough size>

### Checks
<!-- Kind: unit, integration, e2e, lint, type, contract, contract-live, coverage, crap, mutation, acceptance.
     Services for integration/E2E/live checks: .workflow/verify-env.json (or "none needed"). Pipes in commands: \| -->
| Kind | Command | Directory | Prerequisites | Source (CI/script/docs) |
|---|---|---|---|---|

### Milestones
#### M1: <title>
- Depends on: —
- Judge: <verify | verify-codex> · Touches: <auth, data, ... or —>
- Gates: <clean, harden, qa — only to add gates in lite/standard mode; or —>
- Contract: <contract files, or —>
- Scenarios (standard/full):
  ```gherkin
  Scenario: S1.1 <behaviour>
    Given ...
    When ...
    Then ...
  ```
- Acceptance (lite only):
  - [ ] <criterion>
- QA procedure (standard/full):
  1. <precondition and data> → <action via named interface> → <expected result> (S1.1)
- Expected changes: <files/modules>
- Tests: <new/changed tests, failure cases>
- Tasks (optional; standard/full, big milestones only; check with `lane.js tasks`):
  - T1 [W1] <what>. Owns: `<globs>`. Scenarios: S1.1.
  - T2 [W1] <what>. Owns: `<globs>`. Scenarios: S1.2.
  - T3 [W2] <what>. Owns: `<globs>`. Scenarios: S1.3. After: T1.

## Findings

<!-- The verifier appends one block per run:
### M1 — verify <date> @ <revision>
Defects / Open questions / Optional, each: severity, requirement, file:line, scenario, evidence.
Scenarios: S1.1 → pass / fail / Blocked, with the evidence.
Blocked: checks that couldn't run, and why. Checks run: command → result. -->
````
