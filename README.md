# flow

A small Claude Code plugin for spec-driven work in an existing repository. Three commands, one task record.

| Command | Model | Does | Writes |
|---|---|---|---|
| `/flow:plan` | Opus (plan mode) | Discuss scope, plan milestones | **Spec** section of the task record |
| `/flow:execute` | Sonnet | Implement one milestone, or fix its findings | Code, tests, `<task>.log.md` |
| `/flow:verify` | Opus | Independent review against the Spec | **Findings** section |
| `/flow:verify-codex` | Codex `gpt-6-astra` | Same review, done by OpenAI's Codex as a second opinion | **Findings** section |

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

`opusplan` uses Opus in plan mode and Sonnet otherwise. The plan skill also requests Opus for its first turn, execute requests Sonnet and verify requests Opus, so routing works without switching models by hand. Verify uses a different model from execute on purpose, so the two are less likely to share blind spots.

**Updating:** `plugin.json` sets no `version`, so Claude Code uses the commit as the version and every push to `main` is an update. In a session: `/plugin` → **Installed** → flow → **Update now**, then `/reload-plugins`. From the shell: `claude plugin update flow@flow`. To get updates automatically, turn on **Enable auto-update** for the flow marketplace in `/plugin` → **Marketplaces**.

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
- **When a milestone is done:** only when its newest verify ran at the current `HEAD`, with no uncommitted changes, no open defects and no Blocked checks. Every `execute fix` needs another verify.

## Session names

Running a flow command renames the session, the same as `/rename`: `/flow:execute M2` becomes `items-pagination · execute M2` (the task name is added when `.workflow/` holds exactly one task record, otherwise it's `flow execute M2`). The name stays across `/clear` until the next flow command, so `/resume` shows which stage each session was. This is a `UserPromptSubmit` hook (`hooks/session-title.js`, needs `node` on `PATH`). It ignores other prompts and never blocks one. To turn it off, disable hooks for the plugin or delete `hooks/hooks.json` in your installed copy.

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
- It runs the checks itself and probes cases beyond the author's tests. A check it couldn't run goes under **Blocked**, and a block with Blocked items is incomplete, never clean.
- Its only edit is appending to **Findings**. It still has shell access, so this is an instruction, not enforced read-only access. When the repo has a `verify-env.json`, the checks run in a throwaway worktree, and changes there are reported.

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

- No hooks besides the session-name hook. Codex is used only by `/flow:verify-codex`, never automatically. The target repo's own hooks and CI are left untouched. A changed-file formatter hook is a possible future extension.
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
