---
name: harden
description: Strengthen a milestone's tests with coverage and mutation testing. Adds tests only, never production code. Run in a fresh context.
argument-hint: "[M<n>]"
model: sonnet
disable-model-invocation: true
disallowed-tools: Agent, NotebookEdit
---

# /flow:harden

Input: $ARGUMENTS

You make the tests catch real bugs. Mutation testing plants small deliberate bugs ("mutants") in the changed code and runs the tests. A mutant that no test catches ("survived") shows a gap. You close gaps by writing tests. You never change production code.

If this conversation already contains implementation work, stop and tell the user to run `/clear` first.

## 0. Load
- Open the task record `.workflow/<task>.md` (task records are `.workflow/*.md` except `roadmap.md` and `*.log.md`; ask if several match). Read the Spec: Mode and lanes, Checks, the milestone's Scenarios, contract files and Tests line.
- From `.workflow/<task>.log.md` read only the `### M<n> clean` block, if there is one: clean's list of test-gap functions and suspected bugs. Print just that block, e.g. `awk '/^### M<n> clean/{p=1;print;next} /^### /{p=0} p' .workflow/<task>.log.md`. Don't read execute's notes.
- **Stack check.** Harden supports TS/JS (Stryker) and Python (mutmut, or cosmic-ray on native Windows). If the changed code is in another language, stop and say: "Harden (mutation testing) doesn't support <language> yet. It would use <PIT, gremlins or cargo-mutants>. Recommended: skip this gate with the user's OK and run the next one." Then name the next command.
- The `coverage`, `crap` and `mutation` rows in Spec → Checks give the commands and thresholds (defaults: mutation score of at least 80% on changed files, CRAP at most 8). If one is missing or its tool isn't installed, stop and say what is missing. Suggest `/flow:plan M<n>`. Don't install tools yourself.

## 1. Measure
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" start harden --task .workflow/<task>.md`
- Run `coverage`, `crap` and `mutation`. Note the mutation score and each surviving mutant (file:line, what was changed).
- cosmic-ray edits source files in place while it runs. After each `mutation` run, `git status` must show no production-code change you didn't expect. If one is left (an interrupted run), stop and tell the user. Don't restore it yourself.

## 2. Write tests
- **Your lane:** test files under Spec → `Test paths`, and your notes in the log. Never edit production code, QA scripts, contract files or the task record. A hook refuses those edits.
- Start with clean's test-gap functions, then the surviving mutants, most important behaviour first.
- Each test asserts behaviour the Spec defines (a scenario, the contract, an error case), not the current implementation's accidents. Follow the repo's test style. No sleeps, no order dependence, no network unless the suite already uses it.
- A test that matches the Spec but fails against the current code is evidence of a bug: keep it, failing, and name it in your report. Don't change production code to make it pass, and don't weaken it.
- **Equivalent mutants** change no observable behaviour (e.g. a different but equal loop bound). List each with a one-line reason instead of a test.
- Rerun `mutation` after each batch. Stop when the threshold is met and every survivor is killed or explained, or at the time box.

## 3. Check and record
- Run `coverage` and `crap` again; CRAP should now be within the limit for the test-gap functions.
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" check harden --task .workflow/<task>.md`. If it lists files outside the lane (tool output that isn't gitignored, or anything else), stop and tell the user. Don't revert them yourself.
- Append to `.workflow/<task>.log.md` under `### M<n> harden`, with Bash (`cat >> .workflow/<task>.log.md <<'EOF'`): mutation score before → after, CRAP for the test-gap functions, tests added, equivalent mutants with reasons, failing tests that point to bugs.
- Report the same briefly. End with `/clear` then the next command: `/flow:qa M<n>` if qa applies (full mode, or `Gates:` lists it), else the milestone's judge (`Judge:` line; `/flow:verify M<n>` or `/flow:verify-codex M<n>`).
