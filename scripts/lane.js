#!/usr/bin/env node
// Checks that a flow step changed only files in its lane (see record.js → lane()).
// It catches writes the edit hook can't see, e.g. files written through the shell.
//
// Usage (run inside the target repo):
//   node lane.js start <step> --task .workflow/<task>.md   remember the current state
//   node lane.js check <step> --task .workflow/<task>.md   list files changed since start outside the lane
//        [--milestone M<n> --wave W<n>]                       also require each file to be owned by a task of that wave
//   node lane.js tasks --task .workflow/<task>.md --milestone M<n>   print the milestone's tasks and check the split
//   node lane.js claim T<n> --task .workflow/<task>.md --milestone M<n>   a sub-agent takes its task (the guard hook
//        records the claim; this prints what the task owns)
// Steps: execute, clean, harden, qa (any step name from record.js works).
// Exit codes: 0 ok · 1 usage or state error · 2 files outside the lane, or a bad task split
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const record = require("./record");

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return r.stdout.toString();
}

function nulList(out) {
  return out.split("\0").filter(Boolean);
}

function hashFile(root, rel) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex");
  } catch {
    return "<missing>";
  }
}

// Files that differ from `head` in the working tree, plus untracked files.
function dirtyFiles(root, head) {
  const changed = nulList(git(["diff", "--name-only", "-z", head, "--"], root));
  const untracked = nulList(git(["ls-files", "--others", "--exclude-standard", "-z"], root));
  return [...new Set([...changed, ...untracked])].sort();
}

function statePath(root, step) {
  const rel = git(["rev-parse", "--git-path", `flow/lane-${step}.json`], root).trim();
  return path.resolve(root, rel);
}

function start(root, step) {
  const head = git(["rev-parse", "HEAD"], root).trim();
  const files = {};
  for (const f of dirtyFiles(root, head)) files[f] = hashFile(root, f);
  const file = statePath(root, step);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ step, head, files, at: new Date().toISOString() }));
  return { head, count: Object.keys(files).length };
}

// Files whose content changed since start(): edited, created or deleted, committed or not.
function changedSince(root, state) {
  const now = new Set(dirtyFiles(root, state.head));
  const out = [];
  for (const f of new Set([...Object.keys(state.files), ...now])) {
    if (f in state.files) {
      if (hashFile(root, f) !== state.files[f]) out.push(f);
    } else out.push(f);
  }
  return out.sort();
}

function check(root, step, task, { milestone, wave } = {}) {
  const file = statePath(root, step);
  if (!fs.existsSync(file)) throw new Error(`No lane start for "${step}". Run: node lane.js start ${step} --task ${task}`);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const text = fs.readFileSync(path.join(root, task), "utf8");
  const f = record.fields(text);
  const rule = record.lane(step, f);
  let owned = null;
  const waveName = wave ? `W${String(wave).replace(/^W/i, "")}` : null;
  if (wave) {
    const n = parseInt(waveName.slice(1), 10);
    const inWave = record.tasks(text, milestone).filter((t) => t.wave === n);
    if (!inWave.length) throw new Error(`${milestone} has no tasks in wave ${waveName}.`);
    owned = inWave.flatMap((t) => t.owns);
  }
  const changed = changedSince(root, state);
  const outside = [];
  for (const rel of changed) {
    const why =
      rule(rel, task.replace(/\\/g, "/")) ||
      (owned && !record.LOG.test(rel) && !record.matches(rel, owned) ? `not owned by any task of ${waveName}` : null);
    if (why) outside.push(`${rel} — ${why}`);
  }
  return { changed, outside, missing: record.laneMissing(step, f) };
}

function describe(t) {
  const after = t.after.length ? `\n    after: ${t.after.join(", ")}` : "";
  return `${t.id} [W${t.wave}] ${t.what}\n    owns: ${t.owns.join(", ") || "—"}\n    scenarios: ${t.scenarios.join(", ") || "—"}${after}`;
}

function opt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

// `tasks` and `claim`: read-only views of the milestone's task split.
function taskCli(root, cmd, id, task, milestone) {
  const text = fs.readFileSync(path.resolve(root, path.relative(root, path.resolve(task))), "utf8");
  const ts = record.tasks(text, milestone);
  if (cmd === "claim") {
    const t = ts.find((x) => x.id === id.toUpperCase());
    if (!t) {
      console.error(`${milestone} has no task ${id}.`);
      return 1;
    }
    console.log(`Claimed ${describe(t)}\nEdit only the files it owns. Anything else goes under Problems in your report.`);
    return 0;
  }
  if (!ts.length) {
    console.log(`${milestone} has no tasks: execute works alone.`);
    return 0;
  }
  for (const t of ts) console.log(describe(t));
  const problems = record.taskProblems(text, milestone);
  if (problems.length) {
    console.log("Problems with the task split:");
    for (const p of problems) console.log(`  - ${p}`);
    return 2;
  }
  console.log(`Split OK: ${ts.length} tasks in ${new Set(ts.map((t) => t.wave)).size} wave(s).`);
  return 0;
}

function cli(argv) {
  const [cmd, step] = argv;
  const task = opt(argv, "--task");
  const milestone = (opt(argv, "--milestone") || "").toUpperCase() || null;
  const wave = opt(argv, "--wave");
  const needsStep = cmd !== "tasks";
  const needsMilestone = cmd === "tasks" || cmd === "claim" || Boolean(wave);
  if (!["start", "check", "tasks", "claim"].includes(cmd) || !task || (needsStep && !step) || (needsMilestone && !milestone)) {
    console.error(
      "Usage: lane.js start|check <step> --task .workflow/<task>.md [--milestone M<n> --wave W<n>]\n" +
        "       lane.js tasks --task .workflow/<task>.md --milestone M<n>\n" +
        "       lane.js claim T<n> --task .workflow/<task>.md --milestone M<n>"
    );
    return 1;
  }
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  if (cmd === "tasks" || cmd === "claim") return taskCli(root, cmd, step, task, milestone);
  if (cmd === "start") {
    const r = start(root, step);
    console.log(`Lane start for ${step} at ${r.head.slice(0, 7)} (${r.count} file(s) already changed).`);
    return 0;
  }
  const r = check(root, step, path.relative(root, path.resolve(task)), { milestone, wave });
  if (r.missing) console.log(`WARNING: ${r.missing}, so the lane can't be checked precisely.`);
  if (r.outside.length) {
    console.log(`Files changed outside the ${step} lane:`);
    for (const l of r.outside) console.log(`  ${l}`);
    console.log("Inspect them (git status, git diff). Don't revert them automatically.");
    return 2;
  }
  console.log(`In lane: ${r.changed.length} file(s) changed by ${step}, all allowed.`);
  return 0;
}

module.exports = { start, check, changedSince };

if (require.main === module) {
  try {
    process.exit(cli(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
