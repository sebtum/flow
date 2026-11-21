// Reads the parts of a task record (.workflow/<task>.md) that scripts and hooks need:
// the "Mode and lanes" fields, the Checks table and the milestones' Gates/Judge lines.
// Also the lane rules: which repo paths each flow step may write.
"use strict";
const fs = require("fs");
const path = require("path");

const FIELD = /^\s*-\s*(Mode|Fix rounds|Test paths|QA path|Contract path)\s*:\s*(.*?)\s*$/i;
const NONE = /^(|-|—|none|n\/a|<.*>)$/i;

function specPart(text) {
  const i = text.search(/^##\s+Findings\b/m);
  return i < 0 ? text : text.slice(0, i);
}

function stripTicks(s) {
  return s.replace(/`/g, "").trim();
}

// "tests/**, **/*.test.ts" -> ["tests/**", "**/*.test.ts"]; "none" / "—" / "<globs>" -> []
function globList(value) {
  return String(value || "")
    .split(",")
    .map(stripTicks)
    .filter((g) => !NONE.test(g));
}

function fields(text) {
  const out = { mode: "lite", fixRounds: 2, testPaths: [], qaPaths: [], contractPaths: [] };
  for (const line of specPart(text).split(/\r?\n/)) {
    const m = FIELD.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/<!--.*?-->/g, "").trim();
    if (key === "mode") {
      const mode = stripTicks(value).toLowerCase().split(/[\s|]/)[0];
      if (["lite", "standard", "full"].includes(mode)) out.mode = mode;
    } else if (key === "fix rounds") {
      const n = parseInt(stripTicks(value), 10);
      if (Number.isFinite(n) && n >= 0) out.fixRounds = n;
    } else if (key === "test paths") out.testPaths = globList(value);
    else if (key === "qa path") out.qaPaths = globList(value);
    else if (key === "contract path") out.contractPaths = globList(value);
  }
  return out;
}

// Splits a Markdown table row on unescaped pipes; "\|" stays a literal pipe.
function cells(row) {
  const parts = [];
  let cur = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (row[i] === "|") {
      parts.push(cur);
      cur = "";
    } else cur += row[i];
  }
  parts.push(cur);
  if (parts.length && parts[0].trim() === "") parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === "") parts.pop();
  return parts.map((c) => c.trim());
}

// Rows of the Spec's "### Checks" table as objects keyed by lower-case header
// (kind, command, directory, prerequisites, source). Records without a Kind column get kind "".
function checks(text) {
  const lines = specPart(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^###\s+Checks\b/.test(l));
  if (start < 0) return [];
  const rows = [];
  let header = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,3}\s/.test(l)) break;
    if (!/^\s*\|/.test(l)) {
      if (header && l.trim() === "") break;
      continue;
    }
    const c = cells(l);
    if (!header) {
      header = c.map((h) => h.toLowerCase());
      continue;
    }
    if (c.every((x) => /^:?-+:?$/.test(x))) continue;
    const row = {};
    header.forEach((h, j) => (row[h] = stripTicks(c[j] || "")));
    row.kind = (row.kind || "").toLowerCase();
    rows.push(row);
  }
  return rows;
}

// The milestone block "#### M<n>: ..." up to the next milestone or section.
function milestoneBlock(text, id) {
  const lines = specPart(text).split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^####\\s+${id}\\b`, "i").test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{1,4}\s/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

function lineValue(block, key) {
  const m = new RegExp(`^\\s*-\\s*${key}\\s*:\\s*(.*)$`, "im").exec(block || "");
  return m ? stripTicks(m[1].split("|")[0]) : "";
}

const GATE_ORDER = ["clean", "harden", "qa"];

// Which gates run for a milestone: all three in full mode, otherwise the milestone's "Gates:" line.
function gatesFor(text, id) {
  const f = fields(text);
  if (f.mode === "full") return GATE_ORDER.slice();
  const listed = lineValue(milestoneBlock(text, id), "Gates").toLowerCase();
  return GATE_ORDER.filter((g) => new RegExp(`\\b${g}\\b`).test(listed));
}

function judgeFor(text, id) {
  const j = lineValue(milestoneBlock(text, id), "Judge").toLowerCase();
  if (j.includes("codex")) return "verify-codex";
  if (j.includes("verify")) return "verify";
  return fields(text).mode === "full" ? "verify-codex" : "verify";
}

// A milestone's tasks, written by plan one per line:
//   - T1 [W1] <what>. Owns: `src/cart/**`, `tests/cart/**`. Scenarios: S1.1, S1.2. After: —
// W<n> is the wave. Tasks in one wave run as parallel agents; "After:" names tasks of earlier waves.
const TASK = /^\s*-\s*(T\d+)\s*\[W(\d+)\]\s*(.*)$/i;
const TASK_KEYS = ["Owns", "Scenarios", "After"];

function taskField(rest, key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*(.*)$`, "i").exec(rest);
  if (!m) return "";
  const next = new RegExp(`\\b(?:${TASK_KEYS.filter((k) => k !== key).join("|")})\\s*:`, "i").exec(m[1]);
  return (next ? m[1].slice(0, next.index) : m[1]).trim();
}

function tasks(text, id) {
  const block = id ? milestoneBlock(text, id) : null;
  if (!block) return [];
  const out = [];
  for (const line of block.split(/\r?\n/)) {
    const m = TASK.exec(line);
    if (!m) continue;
    const rest = m[3];
    const ownsRaw = taskField(rest, "Owns").replace(/\.\s*$/, "");
    const ticked = [...ownsRaw.matchAll(/`([^`]+)`/g)].map((x) => x[1].trim());
    out.push({
      id: m[1].toUpperCase(),
      wave: parseInt(m[2], 10),
      what: rest.split(/\bOwns\s*:/i)[0].trim().replace(/\.$/, ""),
      owns: ticked.length ? ticked : globList(ownsRaw),
      scenarios: [...taskField(rest, "Scenarios").matchAll(/S\d+\.\d+/gi)].map((x) => x[0].toUpperCase()),
      after: [...taskField(rest, "After").matchAll(/T\d+/gi)].map((x) => x[0].toUpperCase()),
    });
  }
  return out;
}

function scenarioIds(text, id) {
  return [...(milestoneBlock(text, id) || "").matchAll(/Scenario(?: Outline)?:\s*(S\d+\.\d+)/gi)].map((x) => x[1].toUpperCase());
}

// Hard limits that keep a simple milestone from being split into many agents.
const TASK_LIMITS = { total: 6, perWave: 4 };

function staticPrefix(g) {
  const i = g.search(/[*?[]/);
  return (i < 0 ? g : g.slice(0, i)).replace(/\\/g, "/").replace(/^\.\//, "");
}

// Conservative: true whenever two owned globs might name the same file.
function mayOverlap(a, b) {
  const wa = /[*?[]/.test(a), wb = /[*?[]/.test(b);
  if (!wa && !wb) return staticPrefix(a).toLowerCase() === staticPrefix(b).toLowerCase();
  if (!wa) return matches(a, [b]);
  if (!wb) return matches(b, [a]);
  const pa = staticPrefix(a).toLowerCase(), pb = staticPrefix(b).toLowerCase();
  return pa.startsWith(pb) || pb.startsWith(pa);
}

// Problems with a milestone's task split; [] when there are no tasks or the split is sound.
function taskProblems(text, id) {
  const ts = tasks(text, id);
  if (!ts.length) return [];
  const p = [];
  const f = fields(text);
  if (f.mode === "lite") p.push("lite mode works without tasks: remove the task lines");
  if (ts.length < 2) p.push("one task isn't a split: remove the task line and let execute work alone");
  if (ts.length > TASK_LIMITS.total) p.push(`${ts.length} tasks; the limit is ${TASK_LIMITS.total} per milestone. Merge tasks or split the milestone`);
  const ids = new Map(ts.map((t) => [t.id, t]));
  if (ids.size !== ts.length) p.push("task ids must be unique");
  const waves = [...new Set(ts.map((t) => t.wave))].sort((a, b) => a - b);
  for (const w of waves) {
    const inWave = ts.filter((t) => t.wave === w);
    if (inWave.length > TASK_LIMITS.perWave) p.push(`wave W${w} has ${inWave.length} tasks; the limit is ${TASK_LIMITS.perWave}`);
    for (let i = 0; i < inWave.length; i++)
      for (let j = i + 1; j < inWave.length; j++)
        for (const a of inWave[i].owns)
          for (const b of inWave[j].owns)
            if (mayOverlap(a, b)) p.push(`${inWave[i].id} and ${inWave[j].id} are in the same wave and may both own files matching \`${a}\` / \`${b}\``);
  }
  const all = scenarioIds(text, id);
  const owner = new Map();
  for (const t of ts) {
    if (!t.owns.length) p.push(`${t.id} owns no files`);
    for (const g of t.owns) {
      if (!g.includes("/")) p.push(`${t.id}: \`${g}\` has no directory; owned files must be paths, e.g. \`src/cart/**\``);
      if (/^\.?\/?\.workflow\//i.test(g)) p.push(`${t.id}: tasks can't own files under .workflow/`);
    }
    if (all.length && !t.scenarios.length) p.push(`${t.id} covers no scenario; every task delivers at least one scenario`);
    for (const s of t.scenarios) {
      if (all.length && !all.includes(s)) p.push(`${t.id}: ${s} isn't a scenario of ${id}`);
      if (owner.has(s)) p.push(`${s} is in both ${owner.get(s)} and ${t.id}; a scenario belongs to one task`);
      else owner.set(s, t.id);
    }
    for (const a of t.after) {
      const dep = ids.get(a);
      if (!dep) p.push(`${t.id}: After names ${a}, which doesn't exist`);
      else if (dep.wave >= t.wave) p.push(`${t.id} (W${t.wave}) runs after ${a} (W${dep.wave}); it must be in a later wave`);
    }
  }
  return [...new Set(p)];
}

// Task records: .workflow/*.md except roadmap.md and *.log.md.
function listRecords(root) {
  try {
    return fs
      .readdirSync(path.join(root, ".workflow"))
      .filter((f) => f.endsWith(".md") && !f.endsWith(".log.md") && f.toLowerCase() !== "roadmap.md")
      .sort();
  } catch {
    return [];
  }
}

// One record for a hook: the only one, one named in the prompt's words, or the newest by mtime.
function pickRecord(root, words = []) {
  const recs = listRecords(root);
  if (recs.length <= 1) return recs[0] ? path.join(".workflow", recs[0]) : null;
  const named = recs.find((r) => words.some((w) => w && r.slice(0, -3).toLowerCase() === String(w).toLowerCase()));
  if (named) return path.join(".workflow", named);
  const newest = recs
    .map((r) => ({ r, t: fs.statSync(path.join(root, ".workflow", r)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].r;
  return path.join(".workflow", newest);
}

// Minimal glob: "**" any path, "*" within one segment, "?" one char.
// A pattern without "/" matches the file name anywhere; "dir/" or "dir/**" matches everything below dir.
function globToRegExp(glob) {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

function matches(rel, globs) {
  const p = rel.replace(/\\/g, "/");
  const base = p.split("/").pop();
  return globs.some((g) => {
    const re = globToRegExp(g);
    return g.includes("/") ? re.test(p) : re.test(base) || re.test(p);
  });
}

const LOG = /^\.workflow\/[^/]+\.log\.md$/i;

// Lane rule for a step. Returns (rel, task) -> null when the write is allowed, or the reason it isn't.
// `task` is the record's repo-relative path. Unknown steps are allowed everything.
function lane(step, f) {
  const isRecord = (rel, task) => task && rel.toLowerCase() === task.replace(/\\/g, "/").toLowerCase();
  const inWorkflow = (rel) => rel.toLowerCase().startsWith(".workflow/");
  const t = f.testPaths, q = f.qaPaths, c = f.contractPaths;
  switch (step) {
    case "execute":
      return (rel) =>
        matches(rel, c) ? "contract files are changed only by /flow:plan" :
        matches(rel, q) ? "QA scripts are written only by /flow:qa" : null;
    case "clean":
      return (rel) =>
        LOG.test(rel) ? null :
        inWorkflow(rel) ? "clean writes only code and its notes in the log" :
        matches(rel, c) ? "contract files are changed only by /flow:plan" :
        matches(rel, q) ? "QA scripts are written only by /flow:qa" :
        matches(rel, t) ? "clean refactors code only; tests belong to harden" : null;
    case "harden":
      return (rel) => (LOG.test(rel) || (matches(rel, t) && !matches(rel, q) && !matches(rel, c)) ? null : "harden writes only tests (Spec → Test paths)");
    case "qa":
      return (rel, task) => (LOG.test(rel) || isRecord(rel, task) || matches(rel, q) ? null : "qa writes only QA scripts (Spec → QA path)");
    case "verify":
    case "verify-codex":
      return (rel, task) => (isRecord(rel, task) ? null : "the verifier writes only its Findings block in the task record");
    default:
      return () => null;
  }
}

// Paths a step's lane depends on, to tell when the rule can't work (e.g. harden without Test paths).
function laneMissing(step, f) {
  if (step === "harden" && !f.testPaths.length) return "Spec → Test paths is empty";
  if (step === "qa" && !f.qaPaths.length) return "Spec → QA path is empty";
  if (step === "clean" && !f.testPaths.length) return "Spec → Test paths is empty";
  return null;
}

module.exports = { fields, checks, cells, milestoneBlock, gatesFor, judgeFor, tasks, scenarioIds, taskProblems, mayOverlap, TASK_LIMITS, listRecords, pickRecord, globList, globToRegExp, matches, lane, laneMissing, GATE_ORDER, LOG };
