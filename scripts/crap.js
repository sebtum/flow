#!/usr/bin/env node
// CRAP score for the functions changed since a base revision.
//   CRAP = complexity² × (1 − coverage)³ + complexity
// Complexity comes from lizard (per function, TS/JS and Python), coverage from an LCOV file.
//
// Usage (inside the target repo):
//   node crap.js --lcov coverage/lcov.info --base <rev> [--max 8] [--task .workflow/<task>.md]
//                [--lizard "<command>"] [--lizard-csv <file>] [--all] [--json]
//   --task        leaves out the Spec's Test, QA and Contract paths (tests aren't scored)
//   --all         score every function in the changed files, not only the changed ones
//   --lizard-csv  read lizard's CSV output from a file instead of running lizard
// Output: a Markdown table, worst first. Action per row: ok · refactor (complexity alone is over the limit)
//         · test-gap (complexity is fine, coverage is too low).
// Exit codes: 0 every function at or under --max · 1 usage, git or lizard error · 5 a function is over --max
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const record = require("./record");

const EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/i;
const DEFAULT_MAX = 8;

function parseArgs(argv) {
  const a = { max: DEFAULT_MAX, all: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--lcov") a.lcov = argv[++i];
    else if (k === "--base") a.base = argv[++i];
    else if (k === "--max") a.max = Number(argv[++i]);
    else if (k === "--task") a.task = argv[++i];
    else if (k === "--lizard") a.lizard = argv[++i];
    else if (k === "--lizard-csv") a.lizardCsv = argv[++i];
    else if (k === "--all") a.all = true;
    else if (k === "--json") a.json = true;
    else throw new Error(`Unknown argument: ${k}`);
  }
  if (!a.lcov || !a.base) throw new Error("Usage: crap.js --lcov <lcov.info> --base <rev> [--max 8] [--task <record>]");
  if (!Number.isFinite(a.max) || a.max <= 0) throw new Error("--max must be a positive number");
  return a;
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");

// Changed line numbers per file since `base` (working tree), untracked files count as fully changed.
function changedLines(root, base) {
  const out = new Map();
  let file = null;
  for (const line of git(["diff", "-U0", "--no-color", "--no-ext-diff", base, "--"], root).split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : norm(line.slice(4).replace(/^b\//, ""));
      if (file && !out.has(file)) out.set(file, new Set());
    } else if (file && line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      const startLine = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < count; i++) out.get(file).add(startLine + i);
    }
  }
  for (const f of git(["ls-files", "--others", "--exclude-standard", "-z"], root).split("\0").filter(Boolean)) {
    out.set(norm(f), "all");
  }
  return out;
}

// LCOV → Map(repo-relative file → Map(line → hits)).
function parseLcov(text, root, lcovDir) {
  const out = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const sf = line.slice(3);
      const abs = path.isAbsolute(sf) ? sf : fs.existsSync(path.resolve(root, sf)) ? path.resolve(root, sf) : path.resolve(lcovDir, sf);
      const rel = norm(path.relative(root, abs));
      cur = out.get(rel) || new Map();
      out.set(rel, cur);
    } else if (line.startsWith("DA:") && cur) {
      const [ln, hits] = line.slice(3).split(",");
      cur.set(Number(ln), Math.max(cur.get(Number(ln)) || 0, Number(hits)));
    } else if (line === "end_of_record") cur = null;
  }
  return out;
}

// lizard --csv columns: nloc, ccn, tokens, params, length, location, file, function, long name, start, end
function parseLizardCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
      } else if (ch === "," && !quoted) { cols.push(cur); cur = ""; }
      else cur += ch;
    }
    cols.push(cur);
    if (cols.length < 11 || !/^\d+$/.test(cols[1])) continue;
    rows.push({ ccn: Number(cols[1]), file: norm(cols[6]), name: cols[7], start: Number(cols[9]), end: Number(cols[10]) });
  }
  return rows;
}

function runLizard(root, files, custom) {
  const candidates = custom ? [custom] : ["lizard", "python -m lizard", "python3 -m lizard", "py -m lizard"];
  for (const cmd of candidates) {
    const r = spawnSync(`${cmd} --csv ${files.map((f) => JSON.stringify(f)).join(" ")}`, { cwd: root, shell: true, encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status === 0 && !/No module named|not recognized|not found/i.test(r.stderr || "")) return r.stdout;
    if (custom) throw new Error(`lizard failed (${cmd}): ${(r.stderr || "").trim().split("\n").pop()}`);
  }
  throw new Error("lizard not found. Install it with `pip install lizard` (or pipx), or pass --lizard \"<command>\".");
}

function crap(ccn, coverage) {
  return ccn * ccn * Math.pow(1 - coverage, 3) + ccn;
}

// Scores functions. `changed`: Map from changedLines(); `coverage`: Map from parseLcov().
function score({ functions, changed, coverage, max, all }) {
  const rows = [];
  for (const fn of functions) {
    const lines = changed.get(fn.file);
    if (!lines) continue;
    if (!all && lines !== "all") {
      let touched = false;
      for (let l = fn.start; l <= fn.end && !touched; l++) touched = lines.has(l);
      if (!touched) continue;
    }
    const cov = coverage.get(fn.file);
    let total = 0, hit = 0;
    if (cov) for (const [ln, hits] of cov) if (ln >= fn.start && ln <= fn.end) { total++; if (hits > 0) hit++; }
    const covered = total ? hit / total : 0;
    const value = crap(fn.ccn, covered);
    const action = value <= max ? "ok" : fn.ccn > max ? "refactor" : "test-gap";
    rows.push({ ...fn, coverage: covered, noData: !total, crap: value, action });
  }
  return rows.sort((a, b) => b.crap - a.crap || a.file.localeCompare(b.file) || a.start - b.start);
}

function table(rows, max) {
  const out = [`CRAP per changed function (limit ${max}):`, "", "| Function | Location | Complexity | Coverage | CRAP | Action |", "|---|---|---|---|---|---|"];
  for (const r of rows) {
    const cov = r.noData ? "0% (no data)" : `${Math.round(r.coverage * 100)}%`;
    out.push(`| ${r.name} | ${r.file}:${r.start} | ${r.ccn} | ${cov} | ${r.crap.toFixed(1)} | ${r.action} |`);
  }
  if (!rows.length) out.push("| (no changed functions) | | | | | |");
  const over = rows.filter((r) => r.action !== "ok");
  out.push("", over.length ? `${over.length} function(s) over the limit: ${over.filter((r) => r.action === "refactor").length} refactor, ${over.filter((r) => r.action === "test-gap").length} test-gap.` : "All changed functions are within the limit.");
  return out.join("\n");
}

function main(argv) {
  const a = parseArgs(argv);
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  let exclude = [];
  if (a.task) {
    const f = record.fields(fs.readFileSync(path.resolve(a.task), "utf8"));
    exclude = [...f.testPaths, ...f.qaPaths, ...f.contractPaths];
  }
  const changed = changedLines(root, a.base);
  for (const f of [...changed.keys()]) {
    if (!EXTENSIONS.test(f) || f.startsWith(".workflow/") || record.matches(f, exclude) || !fs.existsSync(path.join(root, f))) changed.delete(f);
  }
  const lcovPath = path.resolve(a.lcov);
  if (!fs.existsSync(lcovPath)) throw new Error(`LCOV file not found: ${a.lcov}. Run the coverage command from Spec → Checks first.`);
  const coverage = parseLcov(fs.readFileSync(lcovPath, "utf8"), root, path.dirname(lcovPath));
  const files = [...changed.keys()];
  const csv = a.lizardCsv ? fs.readFileSync(a.lizardCsv, "utf8") : files.length ? runLizard(root, files, a.lizard) : "";
  const rows = score({ functions: parseLizardCsv(csv), changed, coverage, max: a.max, all: a.all });
  console.log(a.json ? JSON.stringify(rows, null, 2) : table(rows, a.max));
  return rows.some((r) => r.action !== "ok") ? 5 : 0;
}

module.exports = { crap, score, parseLcov, parseLizardCsv, changedLines, table };

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
