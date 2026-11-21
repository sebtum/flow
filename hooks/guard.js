#!/usr/bin/env node
// Lane guard for flow steps. Three entry points, chosen by the first argument:
//   pre            PreToolUse: refuse writes outside the current step's lane, and refuse opening the
//                  author's log (.workflow/*.log.md) in verify, verify-codex and qa.
//   stop           Stop: during execute in standard and full mode, run the static contract checks and
//                  send the coder back once if they fail.
//   session-start  SessionStart: forget the saved stage after /clear.
//   subagent-stop  SubagentStop: mark the sub-agent's task finished, so tasks of the next wave can start.
// In execute, a sub-agent must claim one task of the milestone (`lane.js claim T<n>`) before it edits,
// and then may edit only the files that task owns.
// The stage comes from hooks/stage.js (saved by session-title.js). Sessions without a flow stage are
// never affected. Any internal error allows the action: a broken guard must never lock the user out.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const stage = require("./stage");
const record = require("../scripts/record");

const NO_LOG_STAGES = new Set(["verify", "verify-codex", "qa"]);
const LANE_STAGES = new Set(["execute", "clean", "harden", "qa", "verify", "verify-codex"]);
const STOP_TIMEOUT_MS = 100 * 1000;

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function deny(reason) {
  out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `flow guard: ${reason}` } });
}

function warnOnce(sessionId, st, message) {
  if (st.warned) return;
  try {
    stage.save(sessionId, { ...st, warned: true });
  } catch {
    // Warn anyway.
  }
  out({ systemMessage: `flow guard is off for this step: ${message}` });
}

function repoRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return r.status === 0 ? path.resolve(r.stdout.trim()) : null;
}

// Repo-relative path with forward slashes, or null when the path is outside the repo.
function relative(root, p) {
  if (!p) return null;
  const rel = path.relative(root, path.resolve(root, p));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// In `execute fix`, existing test files may be extended but not changed or shortened.
function additive(tool, input, absPath) {
  const before = readText(absPath);
  if (before === null) return true;
  if (tool === "Edit") return String(input.new_string || "").includes(String(input.old_string || ""));
  if (tool === "MultiEdit") return (input.edits || []).every((e) => String(e.new_string || "").includes(String(e.old_string || "")));
  if (tool === "Write") return String(input.content || "").replace(/\r\n/g, "\n").includes(before.replace(/\r\n/g, "\n").trimEnd());
  return false;
}

function pre(input) {
  const st = stage.load(input.session_id);
  if (!st || !LANE_STAGES.has(st.stage)) return;
  const root = repoRoot(st.cwd || input.cwd || process.cwd());
  if (!root) return;
  const tool = input.tool_name;
  const ti = input.tool_input || {};

  if (NO_LOG_STAGES.has(st.stage)) {
    const why = "the author's log (.workflow/*.log.md) holds claims, not evidence. Don't open it.";
    if (tool === "Read" && record.LOG.test(relative(root, ti.file_path) || "")) return deny(why);
    if (tool === "Grep") {
      const rel = relative(root, ti.path || ".");
      if (rel !== null && (record.LOG.test(rel) || /^\.workflow(\/|$)/i.test(rel))) return deny(why);
    }
    if (tool === "Bash" && /\.log\.md\b/i.test(String(ti.command || ""))) return deny(why);
  }

  // Sub-agents of execute work on one task each. Their tool calls carry agent_id.
  const agentId = input.agent_id;
  const perAgent = st.stage === "execute" && !st.fix && agentId && st.milestone && st.task;
  if (perAgent && tool === "Bash") {
    const m = CLAIM.exec(String(ti.command || ""));
    if (m) return claimTask(input, st, root, m[1].toUpperCase());
  }

  const target = tool === "NotebookEdit" ? ti.notebook_path : ti.file_path;
  if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool) || !target) return;
  const rel = relative(root, target);
  if (rel === null) return;

  const taskText = st.task ? readText(path.join(root, st.task)) : null;
  if (taskText === null) return warnOnce(input.session_id, st, `can't read the task record (${st.task || "none found"}).`);
  const f = record.fields(taskText);
  const missing = record.laneMissing(st.stage, f);
  if (missing) return warnOnce(input.session_id, st, `${missing}. Fill it in with /flow:plan.`);

  const why = record.lane(st.stage, f)(rel, st.task.split(path.sep).join("/"));
  if (why) return deny(`${rel} is outside the ${st.stage} lane: ${why}. If it really must change, stop and say so; the user decides (usually /flow:plan).`);

  if (st.stage === "execute" && st.fix && record.matches(rel, f.testPaths) && !additive(tool, ti, path.join(root, rel))) {
    return deny(`${rel}: in execute fix, existing tests may only be extended, not changed or deleted. If a test is wrong, stop and suggest /flow:plan.`);
  }

  if (perAgent) {
    const ts = record.tasks(taskText, st.milestone);
    if (!ts.length) return;
    const mine = stage.claimOf(input.session_id, agentId);
    if (!mine) return deny(`claim your task before editing: run ${claimCommand(st)}`);
    const t = ts.find((x) => x.id === mine);
    if (t && !record.matches(rel, t.owns)) {
      return deny(`${rel} isn't owned by ${mine} (it owns ${t.owns.join(", ")}). Don't edit it; name it under Problems in your report, and the lead agent decides.`);
    }
  }
}

// Only this exact shape counts as a claim, and only a claim is auto-approved: one node call on lane.js,
// no other shell syntax (no ; & | ` $ < > or extra commands).
const CLAIM = /^\s*node\s+(?:"[^"$`]*lane\.js"|[^\s"'$`;&|<>]*lane\.js)\s+claim\s+(T\d+)\s+--task\s+(?:"[^"$`]+"|[^\s"'$`;&|<>]+)\s+--milestone\s+M\d+\s*$/i;

function allow(reason) {
  out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: `flow guard: ${reason}` } });
}
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function claimCommand(st) {
  return `node "${path.join(PLUGIN_ROOT, "scripts", "lane.js").split(path.sep).join("/")}" claim T<n> --task ${st.task.split(path.sep).join("/")} --milestone ${st.milestone}`;
}

// A sub-agent's claim: the task must exist, be free, and every task it runs after must have finished.
function claimTask(input, st, root, id) {
  const text = readText(path.join(root, st.task));
  if (text === null) return;
  const ts = record.tasks(text, st.milestone);
  if (!ts.length) return;
  const t = ts.find((x) => x.id === id);
  if (!t) return deny(`${st.milestone} has no task ${id} (tasks: ${ts.map((x) => x.id).join(", ")}).`);
  const done = stage.doneTasks(input.session_id);
  const waiting = t.after.filter((a) => !done.includes(a));
  if (waiting.length) return deny(`${id} runs after ${waiting.join(", ")}, which haven't finished. The lead agent starts it in a later wave.`);
  const r = stage.claim(input.session_id, input.agent_id, id);
  if (!r.ok) return deny(r.reason);
  // The claim is recorded here; the command itself only prints the task. Approve it so agents don't stop at a prompt.
  return allow(`${id} claimed`);
}

// SubagentStop: the agent's task is finished (done or blocked; its report says which).
function subagentStop(input) {
  const st = stage.load(input.session_id);
  if (!st || st.stage !== "execute" || !input.agent_id) return;
  stage.markDone(input.session_id, input.agent_id);
}

function stop(input) {
  if (input.stop_hook_active) return;
  const st = stage.load(input.session_id);
  if (!st || st.stage !== "execute" || !st.task) return;
  const root = repoRoot(st.cwd || input.cwd || process.cwd());
  if (!root) return;
  const text = readText(path.join(root, st.task));
  if (text === null || record.fields(text).mode === "lite") return;
  const { runContracts } = require("../scripts/contract");
  const r = runContracts({ task: st.task, staticOnly: true, timeoutMs: STOP_TIMEOUT_MS, cwd: root });
  if (r.code !== 3) return;
  out({
    decision: "block",
    reason: [
      "flow guard: the code no longer matches its interface contract (static contract checks failed):",
      ...r.lines,
      "Fix the code so it matches the contract. Don't edit the contract files; if the contract itself is wrong, say so and suggest /flow:plan. If you stopped to ask the user something, say that again and stop.",
    ].join("\n"),
  });
}

function sessionStart(input) {
  if (input.source === "clear") stage.clear(input.session_id);
}

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const mode = process.argv[2];
  if (mode === "pre") pre(input);
  else if (mode === "stop") stop(input);
  else if (mode === "session-start") sessionStart(input);
  else if (mode === "subagent-stop") subagentStop(input);
} catch {
  // Allow on any error.
}
process.exit(0);
