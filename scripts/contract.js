#!/usr/bin/env node
// Runs the interface-contract checks listed in a task record's Spec → Checks table.
//
// Rows with Kind "contract" need no running app (tsc, mypy.stubtest, oasdiff on an exported OpenAPI file).
// Rows with Kind "contract-live" need the services (Schemathesis against the running API).
//
// Usage: node contract.js --task .workflow/<task>.md [--static] [--root <dir>]
//   --static   run only "contract" rows (used by the execute Stop hook)
//   --root     directory the Checks' Directory column is relative to (default: the repo root;
//              verify passes the throwaway worktree)
// Output: one line per contract (PASS / FAIL / MISSING / SKIP), the output tail of each failure.
// Exit codes: 0 all passed or no contracts · 1 usage or record error · 3 a contract failed · 4 none failed, some missing
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const record = require("./record");

const TAIL = 30;
const TIMEOUT_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const a = { static: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") a.task = argv[++i];
    else if (argv[i] === "--root") a.root = argv[++i];
    else if (argv[i] === "--static") a.static = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!a.task) throw new Error("Usage: contract.js --task .workflow/<task>.md [--static] [--root <dir>]");
  return a;
}

function repoRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : cwd;
}

function tail(text, n = TAIL) {
  const lines = String(text || "").trimEnd().split(/\r?\n/);
  return lines.slice(-n).map((l) => "    " + l);
}

// Checks commands are written for bash (the shell verify uses). On Windows that's Git Bash, never WSL's
// System32\bash.exe, which would run the command inside Linux. Falls back to the default shell.
function bashShell() {
  if (process.platform !== "win32") return "/bin/sh";
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];
  const where = spawnSync("where", ["bash"], { encoding: "utf8" });
  if (where.status === 0) candidates.push(...where.stdout.split(/\r?\n/).filter((p) => p && !/\\(System32|WindowsApps)\\/i.test(p)));
  return candidates.find((p) => p && fs.existsSync(p)) || true;
}

function isMissing(cmd) {
  return /^\s*(missing|none|—|-)\b/i.test(cmd) || cmd.trim() === "";
}

// Returns { code, lines }. `timeoutMs` caps each command (the Stop hook passes a short one).
function runContracts({ task, root, staticOnly = false, timeoutMs = TIMEOUT_MS, cwd = process.cwd() }) {
  const repo = repoRoot(cwd);
  const taskPath = path.resolve(repo, task);
  let text;
  try {
    text = fs.readFileSync(taskPath, "utf8");
  } catch (e) {
    return { code: 1, lines: [`Can't read the task record ${task}: ${e.message}`] };
  }
  const base = root ? path.resolve(cwd, root) : repo;
  const rows = record.checks(text).filter((r) => r.kind === "contract" || r.kind === "contract-live");
  if (!rows.length) return { code: 0, lines: ["No contract checks in Spec → Checks (Kind contract / contract-live)."] };

  const lines = [];
  const shell = bashShell();
  let failed = 0, missing = 0;
  for (const row of rows) {
    const cmd = row.command || "";
    const label = `${row.kind} · ${cmd}`;
    if (isMissing(cmd)) {
      missing++;
      lines.push(`MISSING ${row.kind} · ${row.prerequisites || row.source || "no command recorded"}`);
      continue;
    }
    if (staticOnly && row.kind === "contract-live") {
      lines.push(`SKIP    ${label} (needs the running services)`);
      continue;
    }
    const dir = path.resolve(base, row.directory && !/^(\.|—|-)$/.test(row.directory) ? row.directory : ".");
    const t0 = Date.now();
    const r = spawnSync(cmd, { cwd: dir, shell, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1 << 26, env: process.env });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status === 0) {
      lines.push(`PASS    ${label} (${secs}s)`);
    } else {
      failed++;
      const why = r.error ? (r.error.code === "ETIMEDOUT" ? "timed out" : r.error.message) : `exit ${r.status}`;
      lines.push(`FAIL    ${label} (${why}, ${secs}s)`, ...tail((r.stdout || "") + "\n" + (r.stderr || "")));
    }
  }
  return { code: failed ? 3 : missing ? 4 : 0, lines };
}

module.exports = { runContracts };

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { code, lines } = runContracts({ task: args.task, root: args.root, staticOnly: args.static });
  console.log(lines.join("\n"));
  process.exit(code);
}
