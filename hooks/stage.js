// The flow stage of each Claude Code session, saved by session-title.js and read by guard.js.
// One small JSON file per session under the temp directory.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = process.env.FLOW_STAGE_DIR || path.join(os.tmpdir(), "flow-hooks", "sessions");

function file(sessionId) {
  return path.join(DIR, `${String(sessionId).replace(/[^\w.-]/g, "_")}.json`);
}

function save(sessionId, state) {
  if (!sessionId) return;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(sessionId), JSON.stringify({ ...state, at: new Date().toISOString() }));
}

function load(sessionId) {
  if (!sessionId) return null;
  try {
    return JSON.parse(fs.readFileSync(file(sessionId), "utf8"));
  } catch {
    return null;
  }
}

function clear(sessionId) {
  if (!sessionId) return;
  try {
    fs.unlinkSync(file(sessionId));
  } catch {
    // Nothing saved for this session.
  }
  clearClaims(sessionId);
}

// Task claims of execute's sub-agents: which agent works on which task, and which tasks finished.
// One small file per fact, created exclusively, so parallel agents can't claim the same task.
function claimDir(sessionId) {
  return path.join(DIR, `${String(sessionId).replace(/[^\w.-]/g, "_")}.claims`);
}

function readOr(p, fallback) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return fallback;
  }
}

function safe(s) {
  return String(s).replace(/[^\w.-]/g, "_");
}

function claimOf(sessionId, agentId) {
  if (!sessionId || !agentId) return null;
  return readOr(path.join(claimDir(sessionId), `agent-${safe(agentId)}`), null);
}

// -> { ok: true } or { ok: false, reason }
function claim(sessionId, agentId, taskId) {
  const dir = claimDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const mine = claimOf(sessionId, agentId);
  if (mine && mine !== taskId) return { ok: false, reason: `this agent already works on ${mine}; one agent, one task` };
  const taskFile = path.join(dir, `task-${safe(taskId)}`);
  try {
    fs.writeFileSync(taskFile, String(agentId), { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (readOr(taskFile, "") !== String(agentId)) return { ok: false, reason: `${taskId} is already claimed by another agent` };
  }
  fs.writeFileSync(path.join(dir, `agent-${safe(agentId)}`), taskId);
  return { ok: true };
}

function markDone(sessionId, agentId) {
  const t = claimOf(sessionId, agentId);
  if (t) fs.writeFileSync(path.join(claimDir(sessionId), `done-${safe(t)}`), String(agentId));
  return t;
}

function doneTasks(sessionId) {
  try {
    return fs.readdirSync(claimDir(sessionId)).filter((f) => f.startsWith("done-")).map((f) => f.slice(5));
  } catch {
    return [];
  }
}

function clearClaims(sessionId) {
  if (!sessionId) return;
  fs.rmSync(claimDir(sessionId), { recursive: true, force: true });
}

module.exports = { save, load, clear, claim, claimOf, markDone, doneTasks, clearClaims, DIR };
