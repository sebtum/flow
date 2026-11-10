#!/usr/bin/env node
// Runs Codex as an independent, report-only verifier for one flow milestone.
//
// Usage: node codex-verify.js --task .workflow/<task>.md --milestone M<n> [--model <m>] [--effort <e>]
//
// stdout: the Findings block (exit 0) or an error message, then always a final "STATUS: ..." line once Codex ran.
// Exit codes: 0 ok · 1 preflight failed · 2 Codex modified the repository · 3 Codex failed or gave no Findings block.
// Env: FLOW_CODEX_BIN overrides the codex executable (a .js file runs with node). CODEX_HOME as in Codex.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn, spawnSync } = require("child_process");

const DEFAULT_MODEL = "gpt-6-astra";
const DEFAULT_EFFORT = "high";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(task|milestone|model|effort)$/.exec(argv[i]);
    if (m && i + 1 < argv.length) out[m[1]] = argv[++i];
  }
  return out;
}

function fail(code, msg) {
  process.stdout.write(msg.trimEnd() + "\n");
  process.exit(code);
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

// HEAD, tracked changes and the content of untracked files. Ignored files are not covered.
function snapshot(root) {
  const head = git(["rev-parse", "HEAD"], root).toString().trim();
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], root).toString();
  const hash = crypto.createHash("sha256").update(git(["diff", "--binary", "HEAD"], root));
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], root)
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const f of untracked) {
    hash.update("\0" + f + "\0");
    try {
      hash.update(fs.readFileSync(path.join(root, f)));
    } catch {
      hash.update("<unreadable>");
    }
  }
  return { head, status, digest: hash.digest("hex") };
}

function changedPaths(before, after) {
  const a = new Set(before.status.split("\n").filter(Boolean));
  const b = new Set(after.status.split("\n").filter(Boolean));
  const diff = [...b].filter((l) => !a.has(l)).concat([...a].filter((l) => !b.has(l)).map((l) => l + "  (reverted)"));
  if (before.head !== after.head) diff.unshift(`HEAD moved ${before.head.slice(0, 7)} -> ${after.head.slice(0, 7)}`);
  return diff.length ? diff : ["(file contents changed; status lines are identical)"];
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

function buildPrompt({ task, milestone, header, verifyRules }) {
  return `You are Codex, acting as the independent verifier for the "flow" workflow. Another agent wrote the code.

Input: task record \`${task}\`, milestone ${milestone}. The baseline revision is in the record's Spec → Baseline.

Rules that override the instructions below:
- Do not modify, create or delete any file inside this repository, including \`.workflow/\`. Put scratch files only in the system temp directory. Your changes are detected and would invalidate this verify.
- Do not append to the task record. Instead, return the Findings block as your final message, starting exactly with this header line:
  ${header}
  followed by the Defects / Open questions / Optional / Checks run lines described below. Nothing before the header.
- Ignore the instruction about \`/clear\`; you start in a fresh context.
- Never open \`.workflow/*.log.md\`.

---

${verifyRules.replace(/\$ARGUMENTS/g, milestone)}`;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model || DEFAULT_MODEL;
  const effort = args.effort || DEFAULT_EFFORT;
  if (!args.task || !/^M\d+$/.test(args.milestone || "")) {
    fail(1, "Usage: codex-verify.js --task .workflow/<task>.md --milestone M<n> [--model <m>] [--effort <e>]");
  }

  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], process.cwd()).toString().trim();
  } catch {
    fail(1, "Not inside a git repository.");
  }
  const task = path.resolve(args.task);
  if (!fs.existsSync(task)) fail(1, `Task record not found: ${args.task}`);
  const taskRel = path.relative(root, task).split(path.sep).join("/");

  const cmd = codexCommand();
  const probe = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { encoding: "utf8", shell: cmd[0] === "codex" && process.platform === "win32" });
  if (probe.status !== 0) {
    fail(1, "Codex CLI not available. Install it with `npm i -g @openai/codex`, then run `codex login`.");
  }

  const verifyRules = stripFrontmatter(fs.readFileSync(path.join(__dirname, "..", "skills", "verify", "SKILL.md"), "utf8"));
  const before = snapshot(root);
  const date = new Date().toISOString().slice(0, 10);
  const header =
    `### ${args.milestone} — verify (codex ${model}/${effort}) ${date} @ ${before.head.slice(0, 7)}` +
    (before.status.trim() ? " (+ uncommitted)" : "");
  const prompt = buildPrompt({ task: taskRel, milestone: args.milestone, header, verifyRules });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-codex-"));
  const lastMsg = path.join(tmp, "last-message.md");
  const jsonlPath = path.join(tmp, "codex.jsonl");
  const stderrPath = path.join(tmp, "codex.stderr.log");
  const codexArgs = [
    ...cmd.slice(1),
    "exec",
    "--json",
    "-s", "workspace-write",
    "-C", root,
    "-m", model,
    "-c", `model_reasoning_effort="${effort}"`,
    "-o", lastMsg,
    "-",
  ];

  const outFd = fs.openSync(jsonlPath, "w");
  const errFd = fs.openSync(stderrPath, "w");
  const code = await new Promise((resolve) => {
    const child = spawn(cmd[0], codexArgs, {
      cwd: root,
      stdio: ["pipe", outFd, errFd],
      shell: cmd[0] === "codex" && process.platform === "win32",
    });
    child.on("error", () => resolve(-1));
    child.on("close", (c) => resolve(c));
    child.stdin.end(prompt);
  });
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

  const after = snapshot(root);
  if (after.digest !== before.digest || after.head !== before.head || after.status !== before.status) {
    fail(2, ["Codex modified the repository — findings rejected. Changed:", ...changedPaths(before, after).map((l) => "  " + l), `Codex output: ${tmp}`, status].join("\n"));
  }

  const message = fs.existsSync(lastMsg) ? fs.readFileSync(lastMsg, "utf8") : "";
  const start = message.search(new RegExp(`^###\\s+${args.milestone}\\b.*verify`, "m"));
  if (code !== 0 || start < 0) {
    const tail = fs.readFileSync(stderrPath, "utf8").trim().split("\n").slice(-15).join("\n");
    fail(3, [`Codex ${code !== 0 ? `exited with code ${code}` : "returned no Findings block"}. Logs: ${tmp}`, tail, status].filter(Boolean).join("\n"));
  }

  process.stdout.write(message.slice(start).trimEnd() + "\n" + status + "\n");
  process.exit(0);
}

main().catch((e) => fail(3, `codex-verify failed: ${e.message}`));
