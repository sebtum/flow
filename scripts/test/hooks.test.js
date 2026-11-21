const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { tempRepo, write, rm, RECORD } = require("./helpers");

const HOOKS = path.join(__dirname, "..", "..", "hooks");
const STAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "flow-stage-"));
const env = { ...process.env, FLOW_STAGE_DIR: STAGE_DIR };

function hook(script, args, input) {
  const r = spawnSync("node", [path.join(HOOKS, script), ...args], { input: JSON.stringify(input), encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

let n = 0;
function startStage(repo, prompt) {
  const session_id = `s${++n}`;
  const out = hook("session-title.js", [], { session_id, cwd: repo, prompt });
  return { session_id, title: out && out.hookSpecificOutput.sessionTitle };
}

const pre = (repo, s, tool_name, tool_input) => hook("guard.js", ["pre"], { session_id: s, cwd: repo, tool_name, tool_input });
const denied = (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === "deny";

function setup(record = RECORD) {
  return tempRepo({ ".workflow/items.md": record, "src/a.ts": "a\n", "tests/a.test.ts": "test('a');\n", "contracts/api.yaml": "x\n" });
}

test("session-title: new stages, roadmap.md not counted as a task", () => {
  const repo = setup();
  try {
    write(repo, { ".workflow/roadmap.md": "# Roadmap\n", ".workflow/items.log.md": "x" });
    assert.equal(startStage(repo, "/flow:harden M1").title, "items · harden M1");
    assert.equal(startStage(repo, "/flow:roadmap").title, "items · roadmap");
    assert.equal(startStage(repo, "/flow:qa M2").title, "items · qa M2");
    assert.equal(hook("session-title.js", [], { session_id: "x", cwd: repo, prompt: "hello" }), null);
  } finally {
    rm(repo);
  }
});

test("execute: contract and QA files blocked, source and tests allowed", () => {
  const repo = setup();
  try {
    const { session_id } = startStage(repo, "/flow:execute M1");
    assert.ok(denied(pre(repo, session_id, "Edit", { file_path: path.join(repo, "contracts", "api.yaml"), old_string: "x", new_string: "y" })));
    assert.ok(denied(pre(repo, session_id, "Write", { file_path: path.join(repo, "qa", "s1.spec.ts"), content: "x" })));
    assert.equal(pre(repo, session_id, "Edit", { file_path: path.join(repo, "src", "a.ts"), old_string: "a", new_string: "b" }), null);
    assert.equal(pre(repo, session_id, "Write", { file_path: path.join(repo, "tests", "a.test.ts"), content: "changed" }), null);
    assert.equal(pre(repo, session_id, "Write", { file_path: path.join(os.tmpdir(), "outside.txt"), content: "x" }), null);
  } finally {
    rm(repo);
  }
});

test("execute fix: existing tests may only be extended", () => {
  const repo = setup();
  try {
    const { session_id } = startStage(repo, "/flow:execute fix M1");
    const file = path.join(repo, "tests", "a.test.ts");
    assert.ok(denied(pre(repo, session_id, "Edit", { file_path: file, old_string: "test('a');", new_string: "test.skip('a');" })));
    assert.equal(pre(repo, session_id, "Edit", { file_path: file, old_string: "test('a');", new_string: "test('a');\ntest('b');" }), null);
    assert.ok(denied(pre(repo, session_id, "Write", { file_path: file, content: "nothing left" })));
    assert.equal(pre(repo, session_id, "Write", { file_path: file, content: "test('a');\ntest('c');\n" }), null);
    assert.equal(pre(repo, session_id, "Write", { file_path: path.join(repo, "tests", "new.test.ts"), content: "x" }), null);
  } finally {
    rm(repo);
  }
});

test("harden: only tests; verify: only the record, and never the log", () => {
  const repo = setup();
  try {
    let s = startStage(repo, "/flow:harden M1").session_id;
    assert.ok(denied(pre(repo, s, "Edit", { file_path: path.join(repo, "src", "a.ts"), old_string: "a", new_string: "b" })));
    assert.equal(pre(repo, s, "Write", { file_path: path.join(repo, "tests", "b.test.ts"), content: "x" }), null);
    assert.equal(pre(repo, s, "Read", { file_path: path.join(repo, ".workflow", "items.log.md") }), null);

    s = startStage(repo, "/flow:verify M1").session_id;
    assert.ok(denied(pre(repo, s, "Write", { file_path: path.join(repo, "src", "a.ts"), content: "x" })));
    assert.equal(pre(repo, s, "Edit", { file_path: path.join(repo, ".workflow", "items.md"), old_string: "## Findings", new_string: "## Findings\nx" }), null);
    assert.ok(denied(pre(repo, s, "Read", { file_path: path.join(repo, ".workflow", "items.log.md") })));
    assert.ok(denied(pre(repo, s, "Bash", { command: "cat .workflow/items.log.md" })));
    assert.ok(denied(pre(repo, s, "Grep", { pattern: "x", path: path.join(repo, ".workflow") })));
    assert.equal(pre(repo, s, "Bash", { command: "git diff HEAD" }), null);
  } finally {
    rm(repo);
  }
});

test("no flow stage, plan stage, or after /clear: always allowed", () => {
  const repo = setup();
  try {
    assert.equal(pre(repo, "never-seen", "Write", { file_path: path.join(repo, "contracts", "api.yaml"), content: "x" }), null);
    const p = startStage(repo, "/flow:plan add paging").session_id;
    assert.equal(pre(repo, p, "Write", { file_path: path.join(repo, "contracts", "api.yaml"), content: "x" }), null);
    const v = startStage(repo, "/flow:verify M1").session_id;
    hook("guard.js", ["session-start"], { session_id: v, source: "clear" });
    assert.equal(pre(repo, v, "Write", { file_path: path.join(repo, "src", "a.ts"), content: "x" }), null);
  } finally {
    rm(repo);
  }
});

test("unreadable record or missing Test paths: allowed once with a warning", () => {
  const repo = setup(RECORD.replace(/- Test paths:.*\n/, ""));
  try {
    const s = startStage(repo, "/flow:harden M1").session_id;
    const first = pre(repo, s, "Edit", { file_path: path.join(repo, "src", "a.ts"), old_string: "a", new_string: "b" });
    assert.match(first.systemMessage, /Test paths/);
    assert.equal(pre(repo, s, "Edit", { file_path: path.join(repo, "src", "a.ts"), old_string: "a", new_string: "b" }), null);
    fs.unlinkSync(path.join(repo, ".workflow", "items.md"));
    const s2 = startStage(repo, "/flow:execute M1").session_id;
    const w = pre(repo, s2, "Write", { file_path: path.join(repo, "contracts", "api.yaml"), content: "x" });
    assert.ok(!denied(w));
    assert.match(w.systemMessage, /can't read the task record/);
  } finally {
    rm(repo);
  }
});

test("stop: blocks execute once when a static contract fails", () => {
  const failing = RECORD.replace('`node -e "process.exit(0)"`', '`node -e "console.log(\'drift\');process.exit(1)"`');
  const repo = setup(failing);
  try {
    const s = startStage(repo, "/flow:execute M1").session_id;
    const out = hook("guard.js", ["stop"], { session_id: s, cwd: repo, stop_hook_active: false });
    assert.equal(out.decision, "block");
    assert.match(out.reason, /drift/);
    assert.equal(hook("guard.js", ["stop"], { session_id: s, cwd: repo, stop_hook_active: true }), null);
    const v = startStage(repo, "/flow:verify M1").session_id;
    assert.equal(hook("guard.js", ["stop"], { session_id: v, cwd: repo }), null);
  } finally {
    rm(repo);
  }
});

test("stop: lite mode and passing contracts don't block", () => {
  const repo = setup(RECORD.replace('`node -e "process.exit(0)"`', '`node -e "process.exit(1)"`').replace("Mode: standard", "Mode: lite"));
  try {
    const s = startStage(repo, "/flow:execute M1").session_id;
    assert.equal(hook("guard.js", ["stop"], { session_id: s, cwd: repo }), null);
  } finally {
    rm(repo);
  }
  const ok = setup();
  try {
    const s = startStage(ok, "/flow:execute M1").session_id;
    assert.equal(hook("guard.js", ["stop"], { session_id: s, cwd: ok }), null);
  } finally {
    rm(ok);
  }
});

test.after(() => rm(STAGE_DIR));
