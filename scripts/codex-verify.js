#!/usr/bin/env node
// Runs Codex as an independent, report-only verifier for one flow milestone.
//
// Usage: node codex-verify.js --task .workflow/<task>.md --milestone M<n> [--model <m>] [--effort <e>] [--no-env]
//
// If the repo has .workflow/verify-env.json (and --no-env isn't given), a private copy of its services is started in a
// throwaway worktree first (see verify-env.js), Codex runs in that worktree, and everything is torn down afterwards.
//
// stdout: the Findings block or an error message, optional "NOTE:" lines, then always a final "STATUS: ..." line once Codex ran.
// Exit codes: 0 ok · 1 preflight or environment setup failed (Codex didn't run) · 2 Codex modified the repository or the
// worktree · 3 Codex failed or gave no Findings block · 4 Findings block has Blocked checks (verify incomplete).
// Env: FLOW_CODEX_BIN overrides the codex executable (a .js file runs with node). CODEX_HOME as in Codex.
//      FLOW_KEEP_ENV=1 keeps the services and worktree after the run and prints how to tear them down.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn, spawnSync } = require("child_process");
const env = require("./verify-env");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MODEL = "gpt-6-astra";
const DEFAULT_EFFORT = "high";
const USAGE = "Usage: codex-verify.js --task .workflow/<task>.md --milestone M<n> [--model <m>] [--effort <e>] [--no-env]";

class Exit {
  constructor(code, lines, status) {
    this.code = code;
    this.lines = lines;
    this.status = status;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-env") {
      out.noEnv = true;
      continue;
    }
    const m = /^--(task|milestone|model|effort)$/.exec(argv[i]);
    if (m && i + 1 < argv.length) out[m[1]] = argv[++i];
  }
  return out;
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

// Resolve how to start codex. On Windows the npm shim is a .cmd, which Node won't spawn without a shell,
// so run the package's codex.js with node directly when it can be found.
function codexCommand() {
  const override = process.env.FLOW_CODEX_BIN;
  if (override) return override.endsWith(".js") ? [process.execPath, override] : [override];
  if (process.platform === "win32") {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      const js = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(path.join(dir, "codex.cmd")) && fs.existsSync(js)) return [process.execPath, js];
    }
  }
  return ["codex"];
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

function servicesSection(state) {
  if (!state) {
    return `No services were started for this verify (no \`${env.CONFIG_REL}\`, or provisioning was skipped), and your sandbox has no network access. A listed check that needs running services or network can't run: list it under Blocked with the reason.`;
  }
  const c = state.config;
  const last = state.portBase + c.ports - 1;
  return `A private copy of this repository's services is already running for this verify. It was started from this checkout with \`${c.up}\`; its health check is \`${c.health}\`.
- FLOW_RUN_ID=${state.runId}, FLOW_PORT_BASE=${state.portBase} (ports ${state.portBase}–${last}). Both are set in your environment. Keep them set when you run checks, e.g. \`FLOW_RUN_ID=${state.runId} FLOW_PORT_BASE=${state.portBase} <command>\`.
- You are in a throwaway checkout of the code under review: the same revision plus the same uncommitted changes. The no-modify rule above applies to it too.
- Don't run \`${c.down}\`, don't run \`${c.up}\` again, and don't run \`docker compose down\` or anything else that stops, restarts, resets or deletes these services or their data. They are torn down after you finish.
- If a listed check still can't run, list it under Blocked with the reason.`;
}

function buildPrompt({ task, milestone, header, verifyRules, state }) {
  return `You are Codex, acting as the independent verifier for the "flow" workflow. Another agent wrote the code.

Input: task record \`${task}\`, milestone ${milestone}. The baseline revision is in the record's Spec → Baseline.

Rules that override the instructions below:
- Do not modify, create or delete any file inside this repository, including \`.workflow/\`. Put scratch files only in the system temp directory. Your changes are detected and would invalidate this verify.
- Do not append to the task record. Instead, return the Findings block as your final message, starting exactly with this header line:
  ${header}
  followed by the Defects / Open questions / Optional / Scenarios / Blocked / Checks run lines described below. Nothing before the header. Write \`Blocked: none\` if every listed check ran.
- Ignore the instruction about \`/clear\` (you start in a fresh context) and the "Services" section (that's for another runner; your environment is described next).
- Never open \`.workflow/*.log.md\`.

Services:
${servicesSection(state)}

---

${verifyRules.replace(/\$ARGUMENTS/g, milestone).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN_ROOT.split(path.sep).join("/"))}`;
}

// The Blocked items of a Findings block: [] when it says none, a placeholder when the line is missing.
function blockedItems(block) {
  const lines = block.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*Blocked:/.test(l));
  if (i < 0) return ["(the Findings block has no Blocked: line)"];
  const items = [lines[i].replace(/^\s*Blocked:\s*/, "")];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s*(Defects|Open questions|Optional|Scenarios|Checks run|Blocked):/.test(lines[j]) || /^#{1,6}\s/.test(lines[j])) break;
    if (!/^\s+\S|^\s*[-*]\s/.test(lines[j])) break; // only indented or bulleted continuation lines
    items.push(lines[j]);
  }
  const text = items.map((l) => l.trim()).filter(Boolean);
  if (!text.length || (text.length === 1 && /^(none|n\/a|—|-)\.?$/i.test(text[0]))) return [];
  return text;
}

function walk(dir, match, depth = 0) {
  if (depth > 5) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && match(e.name)) return p;
    if (e.isDirectory()) {
      const found = walk(p, match, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function lastTokenCount(threadId) {
  if (!threadId) return null;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const file = walk(path.join(home, "sessions"), (n) => n.includes(threadId) && /\.jsonl(\.zst)?$/.test(n));
  if (!file) return null;
  let raw = fs.readFileSync(file);
  if (file.endsWith(".zst")) raw = zlib.zstdDecompressSync(raw);
  let last = null;
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line.includes('"token_count"')) continue;
    try {
      const ev = JSON.parse(line);
      const p = ev.payload || ev.msg || ev;
      if (p.type === "token_count" && p.info) last = p;
    } catch {}
  }
  return last;
}

function k(n) {
  if (n == null || isNaN(n)) return "?";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function resetTime(epochSeconds) {
  if (!epochSeconds) return "";
  const d = new Date(epochSeconds * 1000);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `, resets ${day} ${time}`;
}

function statusLine({ model, effort, events, threadId }) {
  const parts = [`Codex ${model}/${effort}`];
  const tc = lastTokenCount(threadId);
  if (tc) {
    const total = tc.info.total_token_usage || {};
    const used = (tc.info.last_token_usage || {}).total_tokens;
    const win = tc.info.model_context_window;
    if (used != null && win) parts.push(`context ${k(used)} used, ${k(win - used)} left (${k(win)})`);
    parts.push(
      `tokens in ${k(total.input_tokens)} (${k(total.cached_input_tokens || 0)} cached) / out ${k(total.output_tokens)}` +
        (total.reasoning_output_tokens ? ` (${k(total.reasoning_output_tokens)} reasoning)` : "")
    );
    const rl = tc.rate_limits || {};
    const windows = [rl.primary, rl.secondary].filter(Boolean);
    for (const w of windows) {
      const label = w.window_minutes === 10080 ? "weekly" : w.window_minutes === 300 ? "5h" : `${w.window_minutes}min`;
      parts.push(
        label === "weekly"
          ? `weekly ${Math.round(100 - w.used_percent)}% left${resetTime(w.resets_at)}`
          : `${label} ${Math.round(w.used_percent)}% used${resetTime(w.resets_at)}`
      );
    }
    if (!windows.length) parts.push("limits unavailable");
  } else {
    const u = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    let seen = false;
    for (const ev of events) {
      if (ev.type === "turn.completed" && ev.usage) {
        seen = true;
        for (const key of Object.keys(u)) u[key] += ev.usage[key] || 0;
      }
    }
    if (seen) parts.push(`tokens in ${k(u.input_tokens)} (${k(u.cached_input_tokens)} cached) / out ${k(u.output_tokens)}`);
    parts.push("limits unavailable");
  }
  return "STATUS: " + parts.join(" · ");
}

// Shared with the signal handlers: the running env and Codex child, so either exit path can clean up.
const run = { state: null, child: null, teardown: null };

function teardown() {
  if (!run.state) return [];
  if (!run.teardown) {
    const result = env.down(run.state, { keep: process.env.FLOW_KEEP_ENV === "1" });
    // Worktree changes were already checked; only report a kept env or a failed teardown.
    const lines = env.describeDown(run.state, { ...result, changed: [] }).join("\n").split("\n");
    run.teardown = lines.filter(Boolean).map((l) => "NOTE: " + l);
  }
  return run.teardown;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model || DEFAULT_MODEL;
  const effort = args.effort || DEFAULT_EFFORT;
  if (!args.task || !/^M\d+$/.test(args.milestone || "")) throw new Exit(1, [USAGE]);

  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], process.cwd()).toString().trim();
  } catch {
    throw new Exit(1, ["Not inside a git repository."]);
  }
  const task = path.resolve(args.task);
  if (!fs.existsSync(task)) throw new Exit(1, [`Task record not found: ${args.task}`]);
  const taskRel = path.relative(root, task).split(path.sep).join("/");

  const cmd = codexCommand();
  const probe = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { encoding: "utf8", shell: cmd[0] === "codex" && process.platform === "win32" });
  if (probe.status !== 0) {
    throw new Exit(1, ["Codex CLI not available. Install it with `npm i -g @openai/codex`, then run `codex login`."]);
  }

  let config = null;
  if (!args.noEnv) {
    try {
      config = env.loadConfig(root);
    } catch (e) {
      throw new Exit(1, [e.message]);
    }
  }

  const verifyRules = stripFrontmatter(fs.readFileSync(path.join(__dirname, "..", "skills", "verify", "SKILL.md"), "utf8"));
  const before = env.snapshot(root);
  const date = new Date().toISOString().slice(0, 10);
  const header =
    `### ${args.milestone} — verify (codex ${model}/${effort}) ${date} @ ${before.head.slice(0, 7)}` +
    (before.status.trim() ? " (+ uncommitted)" : "");

  if (config) {
    try {
      await env.up(root, config, { copy: [taskRel], onState: (s) => (run.state = s) });
    } catch (e) {
      run.state = null; // up() already cleaned up after itself
      throw new Exit(1, [`Verify environment setup failed; Codex was not started. ${e.message}`, ...(e.tail ? ["Log tail:", e.tail] : [])]);
    }
  }
  const state = run.state;
  const workdir = state ? state.worktree : root;
  const prompt = buildPrompt({ task: taskRel, milestone: args.milestone, header, verifyRules, state });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-codex-"));
  const lastMsg = path.join(tmp, "last-message.md");
  const jsonlPath = path.join(tmp, "codex.jsonl");
  const stderrPath = path.join(tmp, "codex.stderr.log");
  const sandbox = state && config.sandbox === "danger-full-access" ? ["-s", "danger-full-access"] : ["-s", "workspace-write"];
  if (state && config.sandbox === "workspace-write" && config.network) sandbox.push("-c", "sandbox_workspace_write.network_access=true");
  const codexArgs = [
    ...cmd.slice(1),
    "exec",
    "--json",
    ...sandbox,
    "-C", workdir,
    "-m", model,
    "-c", `model_reasoning_effort="${effort}"`,
    "-o", lastMsg,
    "-",
  ];
  const childEnv = state ? { ...process.env, FLOW_RUN_ID: state.runId, FLOW_PORT_BASE: String(state.portBase) } : process.env;

  const outFd = fs.openSync(jsonlPath, "w");
  const errFd = fs.openSync(stderrPath, "w");
  const code = await new Promise((resolve) => {
    const child = spawn(cmd[0], codexArgs, {
      cwd: workdir,
      env: childEnv,
      stdio: ["pipe", outFd, errFd],
      shell: cmd[0] === "codex" && process.platform === "win32",
    });
    run.child = child;
    child.on("error", () => resolve(-1));
    child.on("close", (c) => resolve(c));
    child.stdin.end(prompt);
  });
  run.child = null;
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  const events = [];
  for (const line of fs.readFileSync(jsonlPath, "utf8").split("\n")) {
    try {
      if (line.trim()) events.push(JSON.parse(line));
    } catch {}
  }
  const threadId = (events.find((e) => e.type === "thread.started") || {}).thread_id;
  let status;
  try {
    status = statusLine({ model, effort, events, threadId });
  } catch (e) {
    status = `STATUS: Codex ${model}/${effort} · usage unavailable (${e.message})`;
  }

  const after = env.snapshot(root);
  const repoChanged = env.sameSnapshot(before, after) ? [] : env.changedPaths(before, after);
  let wtChanged = [];
  if (state) {
    try {
      wtChanged = env.worktreeChanges(state);
    } catch (e) {
      wtChanged = [`(could not compare the worktree: ${e.message})`];
    }
  }
  if (repoChanged.length || wtChanged.length) {
    const lines = ["Codex modified the repository — findings rejected. Changed:"];
    if (repoChanged.length) lines.push(...(state ? ["  in the repository:"] : []), ...repoChanged.map((l) => (state ? "    " : "  ") + l));
    if (wtChanged.length) lines.push("  in the verify worktree:", ...wtChanged.map((l) => "    " + l));
    lines.push(`Codex output: ${tmp}`);
    throw new Exit(2, lines, status);
  }

  const message = fs.existsSync(lastMsg) ? fs.readFileSync(lastMsg, "utf8") : "";
  const start = message.search(new RegExp(`^###\\s+${args.milestone}\\b.*verify`, "m"));
  if (code !== 0 || start < 0) {
    const tail = fs.readFileSync(stderrPath, "utf8").trim().split("\n").slice(-15).join("\n");
    throw new Exit(3, [`Codex ${code !== 0 ? `exited with code ${code}` : "returned no Findings block"}. Logs: ${tmp}`, tail].filter(Boolean), status);
  }

  const block = message.slice(start).trimEnd();
  const blocked = blockedItems(block);
  return { code: blocked.length ? 4 : 0, lines: [block, ...(blocked.length ? [`NOTE: verify incomplete, ${blocked.length} Blocked item(s).`] : [])], status };
}

function finish({ code, lines, status }) {
  const out = [...lines, ...teardown()];
  if (status) out.push(status);
  process.stdout.write(out.join("\n").trimEnd() + "\n");
  process.exit(code);
}

env.onInterrupt(() => {
  if (run.child) {
    try {
      run.child.kill();
    } catch {}
  }
  for (const l of teardown()) process.stdout.write(l + "\n");
});

main().then(finish, (e) => {
  if (e instanceof Exit) finish({ code: e.code, lines: e.lines, status: e.status });
  else finish({ code: 3, lines: [`codex-verify failed: ${e.message}`] });
});
