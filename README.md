# flow

A Claude Code plugin for spec-driven work in an existing repository. One task record per feature, a fresh context per step, and deterministic guard rails: scripts and hooks decide pass or fail wherever they can, so a long agent run can't drift from the plan unnoticed.

| Command | Model | Does | Writes |
|---|---|---|---|
| `/flow:roadmap` | Opus (plan mode) | Vision and ordered features, kept to one screen | `.workflow/roadmap.md` |
| `/flow:plan` | Opus (plan mode) | Scope, mode, Gherkin scenarios, QA procedure, interface contracts, milestones | **Spec** section, contract files |
| `/flow:execute` | Sonnet | Implement one milestone, or fix its findings | Code, tests, `<task>.log.md` |
| `/flow:clean` | Sonnet | Refactor changed functions whose complexity is too high (CRAP score) | Code only |
| `/flow:harden` | Sonnet | Add tests until mutation testing and coverage pass | Tests only |
| `/flow:qa` | Sonnet | Turn the QA procedure into black-box scripts and run them, without reading the source | QA scripts only |
| `/flow:verify` | Opus | Independent review against the Spec; reruns every check | **Findings** section |
| `/flow:verify-codex` | Codex `gpt-6-astra` | Same review, done by OpenAI's Codex as a second opinion | **Findings** section |

The handoff between steps is the task record in the target repo: `.workflow/<task>.md` (Spec + Findings). Execute, clean and harden keep notes in a separate `.workflow/<task>.log.md` that the verifier and qa never see. The templates are embedded in `skills/plan/SKILL.md` and `skills/roadmap/SKILL.md`, so no plugin file has to be read from outside your project.

## Modes

Plan recommends a mode per task and you confirm it. It's stored in Spec → Mode and lanes.

| Mode | Steps per milestone | Use for |
|---|---|---|
| **lite** | plan → execute → verify | small or low-risk work |
| **standard** | plan with a specification discussion and contracts → execute (contract guard) → verify, which walks the QA procedure itself | most features |
| **full** | standard, plus execute → clean → harden → qa → verify-codex | risky or long-lived code |

A milestone in lite or standard mode can add gates with `Gates: clean, harden, qa`. Every step ends by printing the next command, so you don't need to remember the chain.

- **Specification (standard, full):** plan turns your words into example mapping (rules, examples, open questions), then into Gherkin scenarios with ids (`S1.2`) and a QA procedure a person could follow against the running app.
- **Contract:** a file that pins the shape of a public interface before coding: OpenAPI for HTTP, `*.contract.ts` type assertions, `.pyi` stubs, JSON Schema. A command checks it (`tsc`, `mypy.stubtest`, `oasdiff`, Schemathesis). Only plan changes it.
- **CRAP score:** `complexity² × (1 − coverage)³ + complexity` per changed function. Limit 8 by default. Clean refactors only when complexity alone is over the limit; low coverage goes to harden.
- **Mutation testing:** small deliberate bugs are planted in the changed code; tests must catch at least 80% of them by default (Stryker for TS/JS; mutmut for Python, or cosmic-ray on native Windows).
- **Languages:** clean and harden support TS/JS and Python. For Java, Go or Rust, plan and both gates say so and recommend standard mode with `Gates: qa`.

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

`opusplan` uses Opus in plan mode and Sonnet otherwise. The plan skill also requests Opus for its first turn, execute requests Sonnet and verify requests Opus, so routing works without switching models by hand. Verify uses a different model from execute on purpose, so the two are less likely to share blind spots.

**Updating:** `plugin.json` sets no `version`, so Claude Code uses the commit as the version and every push to `main` is an update. In a session: `/plugin` → **Installed** → flow → **Update now**, then `/reload-plugins`. From the shell: `claude plugin update flow@flow`. To get updates automatically, turn on **Enable auto-update** for the flow marketplace in `/plugin` → **Marketplaces**.

The repo is private, so installing uses your existing GitHub credentials (e.g. `gh auth login`). From a local clone you can also run `claude plugin install flow --marketplace /absolute/path/to/flow`.

## Daily loop

```
claude
> /flow:plan <goal, or link to the issue/spec>
    ... discuss in plan mode, approve the plan → Spec (and contracts) are written
> /clear
> /flow:execute M1
> /clear
> /flow:verify M1            (full mode: /flow:clean, /flow:harden, /flow:qa first, then /flow:verify-codex)
    ... if there are defects:
> /clear
> /flow:execute fix M1
> /clear
> /flow:verify M1
```

- **Always `/clear` between phases.** A slash command runs in the current conversation and cannot clear it or open a new window. `/clear` gives each phase a fresh context; the task record carries everything forward. A new terminal window works just as well.
- **Small tasks:** one milestone. Same loop.
- **Ambiguity during execution:** execute stops and suggests `/flow:plan <question>`. That is the single, narrow Opus escalation; the answer is recorded under Decisions.
- **When a milestone is done:** only when its newest verify ran at the current `HEAD`, with no uncommitted changes, no open defects and no Blocked checks. Every `execute fix` needs another verify.
- **The fix loop ends:** only evidence-backed findings block "done" (a failing check, a scenario without evidence, a high or critical security issue). Re-verify is scoped to the earlier findings, all checks and the fixed lines. After `Fix rounds` fixes (default 2), execute stops and `/flow:plan M<n>` decides: accept the gaps, cut scope or re-plan.

## Session names

Running a flow command renames the session, the same as `/rename`: `/flow:execute M2` becomes `items-pagination · execute M2` (the task name is added when `.workflow/` holds exactly one task record, otherwise it's `flow execute M2`). The name stays across `/clear` until the next flow command, so `/resume` shows which stage each session was. This is a `UserPromptSubmit` hook (`hooks/session-title.js`, needs `node` on `PATH`). It ignores other prompts and never blocks one. To turn it off, disable hooks for the plugin or delete `hooks/hooks.json` in your installed copy.

## Roadmap

`/flow:roadmap <vision>` discusses vision, users, constraints and order in plan mode, then writes `.workflow/roadmap.md`: a short Features table, one row per feature, each later one task record. `/flow:plan <feature>` creates that feature's record and fills in its row. Only these two commands open the roadmap, so it costs no context in daily work. `/flow:roadmap` with no argument reviews each feature's status from its record.

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
- **Tasks and waves:** a big milestone can be split into tasks that run as parallel Sonnet agents, wave by wave. Execute leads: it starts one agent per task, collects a fixed report from each, and runs the file check, tests and contract check before the next wave. Plan splits only when the milestone is big (more than about 5 files or 400 lines) and its parts are independent. `lane.js tasks` enforces the rest:
  - every task delivers at least one scenario, and a scenario belongs to one task, so there are never more tasks than scenarios
  - 2 to 6 tasks per milestone, at most 4 per wave
  - tasks in one wave own disjoint files
  - no tasks in lite mode

  Small work stays one piece, which execute codes alone.
- **Another level of hierarchy?** Not inside one record. When the work splits into independent deliverables that each need their own scope discussion (e.g. separate features or releases over weeks), use `/flow:roadmap`: one task record per feature in `.workflow/`. For a project of a few hours, a single record with 2 to 5 milestones is enough.

## Why verify is unbiased

- It runs after `/clear`, so it never sees the implementation conversation.
- It reads only the **Spec**, the linked requirements, the diff from the baseline revision, and the surrounding code. It never opens `<task>.log.md`, which holds the author's claims. That's why the log is a separate file rather than a section a reader would scroll past.
- It runs the checks itself and probes cases beyond the author's tests. A check it couldn't run goes under **Blocked**, and a block with Blocked items is incomplete, never clean.
- Its only edit is appending to **Findings**. The guard hook refuses other edits and opening the log. It still has shell access, so Bash writes rely on the instructions. When the repo has a `verify-env.json`, the checks run in a throwaway worktree, and changes there are reported.
- **One judge per milestone.** `/flow:verify` in lite and standard mode, `/flow:verify-codex` in full mode, so the coder (Claude) and the judge come from different model families. `/security-review` is suggested only for milestones whose `Touches:` names auth, security, payments or personal data. `/code-review` and `/simplify` aren't part of the chain: verify and clean cover them, and they don't know the Spec.

## Lanes and hooks

A **lane** is the set of files one step may change. Spec → Mode and lanes names them with globs (`Test paths`, `QA path`, `Contract path`).

| Step | May write |
|---|---|
| execute | code and tests; in a fix, existing tests only extended. Not contracts or QA scripts. |
| clean | code only; not tests, QA scripts, contracts or the record |
| harden | tests only |
| qa | QA scripts, plus the `acceptance` Checks row and open questions in the record |
| verify, verify-codex | the Findings block only |

- **Before each edit** a `PreToolUse` hook (`hooks/guard.js`) refuses writes outside the current step's lane, with the reason. In verify, verify-codex and qa it also refuses opening `.workflow/*.log.md`.
- **Per agent, in a milestone with tasks:**
  - Each execute sub-agent first claims its task (`lane.js claim T<n>`). The hook sees the agent's id, so from then on it refuses that agent's edits outside the task's `Owns:` files.
  - A task can be claimed once. A task with `After:` can start only when those tasks' agents have finished; a `SubagentStop` hook records that.
  - The lead agent integrates within the normal execute lane.
- **When execute tries to finish** (standard and full mode), a `Stop` hook runs the static contract checks (`scripts/contract.js --static`). If they fail, it sends execute back once with the output.
- **After clean, harden and qa**, `scripts/lane.js check` lists every file changed since the step started that is outside its lane. This also catches files written through the shell, which the edit hook can't see.
- The stage comes from the flow command you typed (saved by the session-name hook) and is forgotten on `/clear`. Sessions without a flow command are never affected. If the guard can't read the task record or a needed lane is empty, it allows the edit and shows a warning once. A broken guard never locks you out; lane checks and verify still catch drift.
- The edit check takes about 0.1 s; the Stop hook runs the fast contract checks once (timeout 120 s). Your app isn't slowed: hooks only run while Claude works.

## Gate scripts

- `scripts/crap.js --lcov <file> --base <rev> [--max 8] [--task <record>]`: complexity from lizard (`pip install lizard`) plus line coverage from LCOV, for functions changed since `--base`. Exit 5 when a function is over the limit. Action per row: `refactor` (complexity alone too high) or `test-gap` (coverage too low).
- `scripts/contract.js --task <record> [--static] [--root <dir>]`: runs the `contract` rows of Spec → Checks, and without `--static` the `contract-live` rows too. Exit 3 on a failure, 4 when a checker is missing.
- `scripts/lane.js start|check <step> --task <record> [--milestone M<n> --wave W<n>]`: the lane check above; with `--wave`, every changed file must also be owned by a task of that wave. Exit 2 when files outside the lane changed.
- `scripts/lane.js tasks --task <record> --milestone M<n>`: prints the milestone's tasks and checks the split. Exit 2 on a problem. `lane.js claim T<n> ...` is the command a sub-agent runs to take its task.
- Tests: `node --test "scripts/test/*.test.js"`.

## Services for checks (`verify-env.json`)

Integration and E2E checks need running services. A repo describes how to start a private copy of them in `.workflow/verify-env.json`, and both verifiers use it:

```json
{ "requires": ["docker"], "network": true,
  "up": "make verify-up", "health": "make verify-health", "down": "make verify-down",
  "timeoutSeconds": 900 }
```

`scripts/verify-env.js` handles it:
1. It checks `requires`: `docker` with `docker info`, any other name on `PATH`.
2. It creates a throwaway worktree of `HEAD` with the uncommitted and untracked changes, without `.workflow/*.log.md`. It also copies any ignored files listed in `"copy"`, e.g. `[".env"]`.
3. It picks a free block of `"ports"` ports (default 4) from 29000 up.
4. It runs `up`, then polls `health` every 3 s until it passes or `timeoutSeconds` runs out.

All three commands run in the worktree with **`FLOW_RUN_ID`** and **`FLOW_PORT_BASE`** set. The repo must use them for its project name, data volume and ports, so a verify never touches your dev stack. On failure it exits early with the log tail, and nothing else runs.

- **`/flow:verify-codex`** does this automatically. Codex runs in the worktree, and afterwards `down` runs and the worktree is removed. That also happens on Ctrl-C and when Codex fails. `--no-env` skips it.
- **`/flow:verify`** runs `verify-env.js up`, runs the checks in the printed worktree, and finishes with `verify-env.js down <id>`.
- **By hand:** `node scripts/verify-env.js run -- make e2e` does up, the command and down in one go. `down --all` removes leftovers of the current repo.
- **`FLOW_KEEP_ENV=1`** keeps the env after a run, for debugging, and prints the tear-down command.
- **Codex sandbox:** `"network": true` keeps Codex in `workspace-write` and turns on its network access. On WSL with Docker Desktop that is enough: tested with codex-cli 0.166, Docker and `localhost` both work. Only if that isn't enough, set `"sandbox": "danger-full-access"`. It applies only inside the throwaway worktree, and the repository itself is still checked for changes. Codex's Linux sandbox fails when the workspace is your home directory (a writable symlink such as `~/.aws` breaks bubblewrap). The worktrees live under the temp directory, which avoids that.
- **WSL:** Docker Desktop needs *Settings → Resources → WSL integration* turned on for your distro, otherwise `docker info` fails and verify stops right away with that hint.

## Codex as a second verifier

`/flow:verify-codex M<n> [effort]` runs the same review with OpenAI's Codex CLI, so the code is checked by a different model family than the one that wrote it. Codex only reports; fixes still go through `/flow:execute fix M<n>`, followed by a new verify from either verifier.

- **Setup:** `npm i -g @openai/codex` and `codex login` (ChatGPT plan or API key). Runs use your Codex limits.
- **Model:** pinned to `gpt-6-astra` (Codex's frontier tier, the Opus equivalent) at effort `high`, independent of your `~/.codex/config.toml`. Pass `xhigh` as the second argument for high-risk milestones.
- **Same rules:** `scripts/codex-verify.js` sends Codex the body of `skills/verify/SKILL.md`, so both verifiers follow one set of instructions. Codex returns the Findings block and Claude appends it unchanged.
- **Enforced no-edit:** Codex runs with `-s workspace-write` so checks can build and write caches, and the script compares `git status`, the diff and untracked file contents before and after. It checks the repository and, with a `verify-env.json`, the worktree too. Any change rejects the findings (exit 2) and lists the changed files. Ignored files (build output) aren't compared.
- **Services:** with a `verify-env.json`, Codex runs in a worktree next to a running private stack (see above). Without one, Codex has no network, and checks that need services are reported as Blocked.
- **Incomplete verify:** if the Findings block lists Blocked checks, or has no `Blocked:` line, the script exits 4. The block is still recorded, but the milestone isn't done.
- **Usage line:** every run ends with a `STATUS:` line, e.g. `Codex gpt-6-astra/high · context 61k used, 197k left (258k) · tokens in 412k (380k cached) / out 9.8k · 5h 28% used · weekly 79% left, resets Tue 14:05`, read from the run's Codex session log.
- **When to use it:** for security-sensitive or otherwise high-risk milestones, or alternating with `/flow:verify`. `/code-review` adds little on top of either, since it doesn't know the Spec.

Security reasoning is part of `/flow:verify`. For security-sensitive milestones you can additionally run Claude Code's built-in `/security-review` (after `/clear`) as a second opinion. It reviews your branch against `origin`'s default branch, so it needs an `origin` remote. Neither replaces CI.

## Not included

- Hooks: the session-name hook and the lane guard (edits, finishing execute, sub-agent claims) only. Codex is used only by `/flow:verify-codex`, never automatically. The target repo's own hooks and CI are left untouched.
- No automatic model router, caching, or extra reviewer agents. No orchestrator that runs the steps as sub-agents yet (see IMPROVEMENTS).

## Limitations

- Plan mode and its approval step are interactive. In headless runs (`claude -p`) plan mode isn't available, and `/flow:plan` writes the record directly.
- Parallel execution depends on the plan writing task lines with disjoint files. Without them, execute works alone. Per-agent enforcement covers Claude's edit tools; a sub-agent's shell writes are caught afterwards by `lane.js check --wave`, which tells only that a file belongs to no task of the wave, not which agent wrote it.
- Clean and harden support TS/JS and Python only. Their tools (lizard, a coverage tool that writes LCOV, Stryker, mutmut or cosmic-ray) and qa's framework (e.g. Playwright) must be installed in the target repo; plan adds a setup milestone when they're missing.
- The lane guard sees Claude's edit tools, not files written through the shell; `lane.js` and verify catch those afterwards.
- Checks commands are written for bash. On Windows, `contract.js` runs them in Git Bash. mutmut doesn't run on native Windows, so plan picks cosmic-ray there for Python mutation testing. It is slower per mutant but needs no WSL. Neither tool has been run end to end with flow yet.

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
