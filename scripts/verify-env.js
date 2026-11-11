#!/usr/bin/env node
// Provisions a private copy of the target repo's services for one verify run, then tears it down.
//
// The target repo describes its services in .workflow/verify-env.json:
//   { "requires": ["docker"], "network": true,
//     "up": "make verify-up", "health": "make verify-health", "down": "make verify-down",
//     "timeoutSeconds": 900 }
// Optional: "sandbox" ("workspace-write" | "danger-full-access", for Codex), "ports" (default 4),
// "copy" (ignored files such as ".env" to copy into the worktree).
//
// Usage (run inside the target repo):
//   node verify-env.js up                 create the worktree, start the stack, print FLOW_RUN_ID / FLOW_PORT_BASE / WORKTREE
//   node verify-env.js down <runId>       tear down one env; exit 2 if the worktree was modified
//   node verify-env.js down --all         tear down every leftover env of this repo
//   node verify-env.js run -- <command>   up, run <command> in the worktree, always down
//
// The up/health/down commands run in the worktree with FLOW_RUN_ID and FLOW_PORT_BASE set; the repo uses them for
// its project name and ports. Exit codes: 0 ok · 1 config, prerequisite or startup failure · 2 worktree modified.
// Env: FLOW_KEEP_ENV=1 keeps the env after `run` (and after codex-verify.js) and prints the down command instead.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const CONFIG_REL = ".workflow/verify-env.json";
const SANDBOXES = ["workspace-write", "danger-full-access"];
const HEALTH_INTERVAL_MS = 3000;
const DOWN_TIMEOUT_MS = 5 * 60 * 1000;
const LOG_TAIL_LINES = 30;

class EnvError extends Error {
  constructor(message, logPath) {
    super(message);
    this.logPath = logPath;
  }
}

function git(args, cwd, input) {
  const r = spawnSync("git", args, { cwd, input, encoding: "buffer", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

function repoRoot(cwd) {
  return git(["rev-parse", "--show-toplevel"], cwd).toString().trim();
}

// HEAD, tracked changes and the content of untracked files. Ignored files are not covered.
function snapshot(root) {
  const head = git(["rev-parse", "HEAD"], root).toString().trim();
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], root).toString();
  const hash = crypto.createHash("sha256").update(git(["diff", "--binary", "HEAD"], root));
  for (const f of untrackedFiles(root)) {
    hash.update("\0" + f + "\0");
    try {
      hash.update(fs.readFileSync(path.join(root, f)));
    } catch {
      hash.update("<unreadable>");
    }
  }
  return { head, status, digest: hash.digest("hex") };
}

function sameSnapshot(a, b) {
  return a.digest === b.digest && a.head === b.head && a.status === b.status;
}

function changedPaths(before, after) {
  const a = new Set(before.status.split("\n").filter(Boolean));
  const b = new Set(after.status.split("\n").filter(Boolean));
  const diff = [...b].filter((l) => !a.has(l)).concat([...a].filter((l) => !b.has(l)).map((l) => l + "  (reverted)"));
  if (before.head !== after.head) diff.unshift(`HEAD moved ${before.head.slice(0, 7)} -> ${after.head.slice(0, 7)}`);
  return diff.length ? diff : ["(file contents changed; status lines are identical)"];
}

function untrackedFiles(root) {
  return git(["ls-files", "--others", "--exclude-standard", "-z"], root).toString().split("\0").filter(Boolean).sort();
}

// The author's progress notes. Never part of a verify checkout.
function isAuthorLog(rel) {
  return /^\.workflow\/[^/]+\.log\.md$/.test(rel.split(path.sep).join("/"));
}

function loadConfig(root) {
  const file = path.join(root, CONFIG_REL);
  if (!fs.existsSync(file)) return null;
  let c;
  try {
    c = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new EnvError(`Invalid ${CONFIG_REL}: ${e.message}`);
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new EnvError(`Invalid ${CONFIG_REL}: expected an object.`);
  for (const key of ["up", "health", "down"]) {
    if (typeof c[key] !== "string" || !c[key].trim()) throw new EnvError(`Invalid ${CONFIG_REL}: "${key}" must be a command string.`);
  }
  const list = (key) => {
    if (c[key] == null) return [];
    if (!Array.isArray(c[key]) || c[key].some((x) => typeof x !== "string" || !x)) {
      throw new EnvError(`Invalid ${CONFIG_REL}: "${key}" must be a list of strings.`);
    }
    return c[key];
  };
  const sandbox = c.sandbox == null ? "workspace-write" : c.sandbox;
  if (!SANDBOXES.includes(sandbox)) throw new EnvError(`Invalid ${CONFIG_REL}: "sandbox" must be one of ${SANDBOXES.join(", ")}.`);
  const timeoutSeconds = c.timeoutSeconds == null ? 900 : Number(c.timeoutSeconds);
  if (!(timeoutSeconds > 0)) throw new EnvError(`Invalid ${CONFIG_REL}: "timeoutSeconds" must be a positive number.`);
  const ports = c.ports == null ? 4 : Number(c.ports);
  if (!Number.isInteger(ports) || ports < 1 || ports > 10) throw new EnvError(`Invalid ${CONFIG_REL}: "ports" must be an integer from 1 to 10.`);
  for (const p of list("copy")) {
    if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) throw new EnvError(`Invalid ${CONFIG_REL}: "copy" entries must be paths inside the repo (${p}).`);
  }
  return {
    requires: list("requires"),
    network: c.network === true,
    sandbox,
    timeoutSeconds,
    ports,
    copy: list("copy"),
    up: c.up,
    health: c.health,
    down: c.down,
  };
}

function onPath(name) {
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of exts) {
      try {
        if (dir && fs.statSync(path.join(dir, name + ext)).isFile()) return true;
      } catch {}
    }
  }
  return false;
}

function checkRequires(config) {
  for (const name of config.requires) {
    if (name === "docker") {
      const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 30000 });
      if (r.status !== 0) {
        const why = String(r.error ? r.error.message : r.stderr || "").trim().split("\n")[0];
        throw new EnvError(
          `Docker is not reachable (\`docker info\` failed${why ? `: ${why}` : ""}). Start Docker and retry. ` +
            "On WSL, enable Docker Desktop → Settings → Resources → WSL integration for this distro."
        );
      }
    } else if (!onPath(name)) {
      throw new EnvError(`Required tool not found on PATH: ${name} (listed in ${CONFIG_REL} → requires).`);
    }
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "0.0.0.0", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

async function freePortBase(count) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 29000 + 10 * crypto.randomInt(0, 1000);
    let ok = true;
    for (let p = base; p < base + count && ok; p++) ok = await portFree(p);
    if (ok) return base;
  }
  throw new EnvError("No free block of ports found between 29000 and 38999.");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function envDir(runId) {
  return path.join(os.tmpdir(), `flow-env-${runId}`);
}

function writeState(state) {
  fs.writeFileSync(path.join(state.dir, "state.json"), JSON.stringify(state, null, 2));
}

function readState(runId) {
  if (!/^[0-9a-f]{8}$/.test(runId || "")) throw new EnvError(`Not a run id: ${runId}`);
  const file = path.join(envDir(runId), "state.json");
  if (!fs.existsSync(file)) throw new EnvError(`No env with run id ${runId} (looked for ${file}).`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function commandEnv(state) {
  return { ...process.env, FLOW_RUN_ID: state.runId, FLOW_PORT_BASE: String(state.portBase) };
}

// Runs a shell command in the worktree, appending its output to the env log.
function runLogged(state, label, command, timeoutMs) {
  fs.appendFileSync(state.logPath, `\n$ ${command}    # ${label}, ${new Date().toISOString()}\n`);
  const fd = fs.openSync(state.logPath, "a");
  try {
    const r = spawnSync(command, {
      cwd: fs.existsSync(state.worktree) ? state.worktree : state.root,
      env: commandEnv(state),
      shell: true,
      stdio: ["ignore", fd, fd],
      timeout: Math.max(1000, timeoutMs),
      killSignal: "SIGTERM",
    });
    if (r.error && r.error.code === "ETIMEDOUT") return { status: null, timedOut: true };
    return { status: r.status, timedOut: false };
  } finally {
    fs.closeSync(fd);
  }
}

function logTail(logPath, n = LOG_TAIL_LINES) {
  try {
    return fs.readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

function copyInto(root, wt, rel) {
  const src = path.join(root, rel);
  const dst = path.join(wt, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true, dereference: false });
}

// A detached worktree of HEAD plus the tracked changes and untracked files of `root`, without the author's log.
function createWorktree(state, extraCopy, log) {
  const { root, worktree: wt, config } = state;
  log(`creating worktree ${wt}`);
  git(["worktree", "add", "--detach", "--quiet", wt, "HEAD"], root);
  const diff = git(["diff", "--binary", "HEAD"], root);
  if (diff.length) {
    try {
      git(["apply", "--binary", "--whitespace=nowarn"], wt, diff);
    } catch (e) {
      throw new EnvError(`Could not copy uncommitted changes into the worktree: ${e.message}`);
    }
  }
  for (const f of untrackedFiles(root)) {
    if (f.endsWith("/") || isAuthorLog(f)) continue; // nested repos are skipped
    copyInto(root, wt, f);
  }
  for (const rel of [...config.copy, ...extraCopy]) {
    if (isAuthorLog(rel)) continue;
    if (!fs.existsSync(path.join(root, rel))) {
      log(`note: ${rel} not found, not copied`);
      continue;
    }
    if (!fs.existsSync(path.join(wt, rel))) copyInto(root, wt, rel);
  }
  const wf = path.join(wt, ".workflow");
  if (fs.existsSync(wf)) {
    for (const name of fs.readdirSync(wf)) if (/\.log\.md$/.test(name)) fs.rmSync(path.join(wf, name), { force: true });
  }
}

// Creates the worktree and starts the services. Returns the state; throws EnvError (after cleaning up) on failure.
// opts.onState(state) is called as soon as there is something to clean up, so signal handlers can tear it down.
async function up(root, config, opts = {}) {
  const log = opts.log || ((m) => process.stderr.write(`flow env: ${m}\n`));
  checkRequires(config);
  const runId = crypto.randomBytes(4).toString("hex");
  const dir = envDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const portBase = await freePortBase(config.ports);
  const state = {
    root,
    runId,
    dir,
    worktree: path.join(dir, "wt"),
    logPath: path.join(dir, "env.log"),
    portBase,
    config,
    baseline: null,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(state.logPath, `flow verify env ${runId}, repo ${root}, ports ${portBase}-${portBase + config.ports - 1}\n`);
  writeState(state);
  if (opts.onState) opts.onState(state);

  try {
    createWorktree(state, opts.copy || [], log);
    state.baseline = snapshot(state.worktree);
    writeState(state);

    const deadline = Date.now() + config.timeoutSeconds * 1000;
    log(`starting services: ${config.up} (FLOW_RUN_ID=${runId}, FLOW_PORT_BASE=${portBase})`);
    const r = runLogged(state, "up", config.up, deadline - Date.now());
    if (r.status !== 0) {
      throw new EnvError(r.timedOut ? `"${config.up}" did not finish within ${config.timeoutSeconds}s.` : `"${config.up}" failed (exit ${r.status}).`, state.logPath);
    }
    log(`waiting for health: ${config.health}`);
    for (;;) {
      const h = runLogged(state, "health", config.health, Math.min(60000, deadline - Date.now()));
      if (h.status === 0) break;
      if (Date.now() + HEALTH_INTERVAL_MS >= deadline) {
        throw new EnvError(`Services not healthy within ${config.timeoutSeconds}s ("${config.health}" kept failing).`, state.logPath);
      }
      sleepSync(HEALTH_INTERVAL_MS);
    }
    log("services healthy");
    return state;
  } catch (e) {
    const err = e instanceof EnvError ? e : new EnvError(e.message);
    err.tail = logTail(state.logPath);
    const result = down(state, { log: () => {} });
    if (result.downFailed) err.message += ` Teardown also failed; retry with: ${downCommand(runId)}`;
    throw err;
  }
}

// Changes in the worktree since `up` finished setting it up.
function worktreeChanges(state) {
  if (!state.baseline || !fs.existsSync(state.worktree)) return [];
  const after = snapshot(state.worktree);
  return sameSnapshot(state.baseline, after) ? [] : changedPaths(state.baseline, after);
}

// Stops the services and removes the worktree. Idempotent. With keep, leaves everything in place.
// Returns { changed, kept, downFailed }. If the down command fails, the env is kept so it can be retried.
function down(state, opts = {}) {
  const log = opts.log || ((m) => process.stderr.write(`flow env: ${m}\n`));
  if (state._downDone) return state._downDone;
  let changed = [];
  try {
    changed = worktreeChanges(state);
  } catch (e) {
    changed = [`(could not compare the worktree: ${e.message})`];
  }
  const result = { changed, kept: false, downFailed: false };
  state._downDone = result;
  if (opts.keep) {
    result.kept = true;
    return result;
  }
  if (fs.existsSync(state.dir)) {
    log(`stopping services: ${state.config.down}`);
    const r = runLogged(state, "down", state.config.down, DOWN_TIMEOUT_MS);
    if (r.status !== 0) {
      result.downFailed = true;
      result.tail = logTail(state.logPath);
      return result;
    }
  }
  try {
    git(["worktree", "remove", "--force", state.worktree], state.root);
  } catch {}
  fs.rmSync(state.dir, { recursive: true, force: true });
  try {
    git(["worktree", "prune"], state.root);
  } catch {}
  return result;
}

// SIGINT / SIGTERM / SIGHUP run `fn` synchronously and exit 130. Returns a function that removes the handlers.
function onInterrupt(fn) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handler = (sig) => {
    process.stderr.write(`flow env: ${sig}, cleaning up\n`);
    try {
      fn();
    } finally {
      process.exit(130);
    }
  };
  for (const s of signals) process.on(s, handler);
  return () => signals.forEach((s) => process.off(s, handler));
}

function downCommand(runId) {
  return `node "${__filename}" down ${runId}`;
}

function describeDown(state, result) {
  const lines = [];
  if (result.changed.length) lines.push("Worktree changed:", ...result.changed.map((l) => "  " + l));
  if (result.kept) lines.push(`Environment kept (FLOW_KEEP_ENV=1): ${state.worktree}. Tear down with: ${downCommand(state.runId)}`);
  if (result.downFailed) {
    lines.push(`"${state.config.down}" failed; environment kept. Log tail:`, result.tail || "(empty)", `Retry with: ${downCommand(state.runId)}`);
  }
  return lines;
}

async function cli(argv) {
  const [cmd, ...rest] = argv;
  let root;
  try {
    root = repoRoot(process.cwd());
  } catch {
    throw new EnvError("Not inside a git repository.");
  }

  if (cmd === "up" || cmd === "run") {
    const config = loadConfig(root);
    if (!config) throw new EnvError(`No ${CONFIG_REL} in ${root}.`);
    let command = "";
    if (cmd === "run") {
      const sep = rest.indexOf("--");
      command = (sep >= 0 ? rest.slice(sep + 1) : rest).join(" ").trim();
      if (!command) throw new EnvError("Usage: verify-env.js run -- <command>");
    }
    let state = null;
    const removeHandlers = onInterrupt(() => state && down(state, { keep: cmd === "run" && process.env.FLOW_KEEP_ENV === "1" }));
    state = await up(root, config, { onState: (s) => (state = s) });
    const vars = `FLOW_RUN_ID=${state.runId} FLOW_PORT_BASE=${state.portBase}`;
    if (cmd === "up") {
      removeHandlers();
      process.stdout.write(
        [
          `Environment ready (ports ${state.portBase}-${state.portBase + config.ports - 1}).`,
          `FLOW_RUN_ID=${state.runId}`,
          `FLOW_PORT_BASE=${state.portBase}`,
          `WORKTREE=${state.worktree}`,
          `Run checks with: cd "${state.worktree}" && ${vars} <command>`,
          `Tear down when done: ${downCommand(state.runId)}`,
        ].join("\n") + "\n"
      );
      return 0;
    }
    const r = spawnSync(command, { cwd: state.worktree, env: commandEnv(state), shell: true, stdio: "inherit" });
    const result = down(state, { keep: process.env.FLOW_KEEP_ENV === "1" });
    removeHandlers();
    const lines = describeDown(state, result);
    if (lines.length) process.stdout.write(lines.join("\n") + "\n");
    if (result.changed.length) return 2;
    return r.status == null ? 1 : r.status;
  }

  if (cmd === "down") {
    let states;
    if (rest[0] === "--all") {
      const real = fs.realpathSync(root);
      states = [];
      for (const name of fs.readdirSync(os.tmpdir())) {
        const m = /^flow-env-([0-9a-f]{8})$/.exec(name);
        if (!m) continue;
        try {
          const s = readState(m[1]);
          if (fs.realpathSync(s.root) === real) states.push(s);
        } catch {}
      }
      if (!states.length) process.stdout.write("No leftover environments for this repository.\n");
    } else {
      states = [readState(rest[0])];
    }
    let code = 0;
    for (const s of states) {
      const result = down(s);
      const lines = describeDown(s, result);
      process.stdout.write([`Environment ${s.runId}: ${result.downFailed ? "teardown failed" : "removed"}.`, ...lines].join("\n") + "\n");
      if (result.downFailed) code = 1;
      else if (result.changed.length && code === 0) code = 2;
    }
    return code;
  }

  throw new EnvError("Usage: verify-env.js up | down <runId> | down --all | run -- <command>");
}

module.exports = { CONFIG_REL, EnvError, loadConfig, up, down, snapshot, sameSnapshot, changedPaths, worktreeChanges, onInterrupt, downCommand, describeDown };

if (require.main === module) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      const lines = [e.message];
      if (e.tail) lines.push("Log tail:", e.tail);
      process.stdout.write(lines.join("\n") + "\n");
      process.exit(1);
    }
  );
}
