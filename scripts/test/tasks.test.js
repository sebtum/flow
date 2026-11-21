const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const record = require("../record");
const { tempRepo, write, rm } = require("./helpers");

const HOOKS = path.join(__dirname, "..", "..", "hooks");
const LANE = path.join(__dirname, "..", "lane.js");
const STAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "flow-stage-"));
const env = { ...process.env, FLOW_STAGE_DIR: STAGE_DIR };

function rec({ mode = "standard", tasks }) {
  return `# Task: cart

## Spec

### Mode and lanes
- Mode: ${mode}
- Test paths: \`tests/**\`
- QA path: \`qa/**\`
- Contract path: \`contracts/**\`

### Milestones
#### M1: Cart
- Scenarios:
  \`\`\`gherkin
  Scenario: S1.1 add an item
  Scenario: S1.2 remove an item
  Scenario: S1.3 show the total
  \`\`\`
- Tasks:
${tasks}

#### M2: Later

## Findings
`;
}

const GOOD = `  - T1 [W1] Cart store. Owns: \`src/cart/**\`, \`tests/cart/**\`. Scenarios: S1.1, S1.2.
  - T2 [W1] Price rules. Owns: \`src/price/**\`, \`tests/price/**\`. Scenarios: S1.3.
  - T3 [W2] Cart API. Owns: \`src/api/cart.ts\`. Scenarios: —. After: T1, T2.`;

test("tasks: parses id, wave, owned files, scenarios and dependencies", () => {
  const ts = record.tasks(rec({ tasks: GOOD }), "M1");
  assert.equal(ts.length, 3);
  assert.deepEqual(ts[0], { id: "T1", wave: 1, what: "Cart store", owns: ["src/cart/**", "tests/cart/**"], scenarios: ["S1.1", "S1.2"], after: [] });
  assert.deepEqual(ts[2].after, ["T1", "T2"]);
  assert.deepEqual(record.tasks(rec({ tasks: GOOD }), "M2"), []);
});

test("taskProblems: a sound split passes, except a task without a scenario", () => {
  const p = record.taskProblems(rec({ tasks: GOOD }), "M1");
  assert.deepEqual(p, ["T3 covers no scenario; every task delivers at least one scenario"]);
  const fixed = GOOD.replace("S1.1, S1.2.", "S1.1.").replace("Scenarios: —", "Scenarios: S1.2");
  assert.deepEqual(record.taskProblems(rec({ tasks: fixed }), "M1"), []);
});

test("taskProblems: limits that keep small work from being split", () => {
  const one = "  - T1 [W1] All. Owns: `src/**`. Scenarios: S1.1, S1.2, S1.3.";
  assert.match(record.taskProblems(rec({ tasks: one }), "M1").join("\n"), /one task isn't a split/);
  assert.match(record.taskProblems(rec({ mode: "lite", tasks: GOOD }), "M1").join("\n"), /lite mode works without tasks/);
  const five = [1, 2, 3, 4, 5].map((i) => `  - T${i} [W1] P${i}. Owns: \`src/p${i}/**\`. Scenarios: S1.${i}.`).join("\n");
  const p = record.taskProblems(rec({ tasks: five }), "M1").join("\n");
  assert.match(p, /W1 has 5 tasks; the limit is 4/);
  assert.match(p, /S1\.4 isn't a scenario of M1/);
});

test("taskProblems: overlapping files, shared scenarios, bad order", () => {
  const bad = `  - T1 [W1] A. Owns: \`src/**\`. Scenarios: S1.1.
  - T2 [W1] B. Owns: \`src/b/x.ts\`, \`*.ts\`. Scenarios: S1.1, S1.2. After: T1.`;
  const p = record.taskProblems(rec({ tasks: bad }), "M1").join("\n");
  assert.match(p, /T1 and T2 are in the same wave and may both own/);
  assert.match(p, /S1\.1 is in both T1 and T2/);
  assert.match(p, /T2 \(W1\) runs after T1 \(W1\)/);
  assert.match(p, /`\*\.ts` has no directory/);
  assert.equal(record.mayOverlap("src/a.ts", "src/a.tsx"), false);
  assert.equal(record.mayOverlap("src/cart/**", "src/api/**"), false);
  assert.equal(record.mayOverlap("src/**/*.ts", "src/cart/x.ts"), true);
});

function hook(args, input) {
  const r = spawnSync("node", [path.join(HOOKS, args[0]), ...args.slice(1)], { input: JSON.stringify(input), encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const denied = (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === "deny";
const reason = (o) => (o && o.hookSpecificOutput ? o.hookSpecificOutput.permissionDecisionReason : "");
const allowed = (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === "allow";

let n = 0;
function session(repo, prompt) {
  const session_id = `t${++n}`;
  hook(["session-title.js"], { session_id, cwd: repo, prompt });
  const call = (agent_id, tool_name, tool_input) => hook(["guard.js", "pre"], { session_id, cwd: repo, agent_id, tool_name, tool_input });
  const claim = (agent_id, id) => call(agent_id, "Bash", { command: `node "/x/scripts/lane.js" claim ${id} --task .workflow/cart.md --milestone M1` });
  const bash = (agent_id, command) => call(agent_id, "Bash", { command });
  const write = (agent_id, rel) => call(agent_id, "Write", { file_path: path.join(repo, rel), content: "x" });
  const stopAgent = (agent_id) => hook(["guard.js", "subagent-stop"], { session_id, cwd: repo, agent_id });
  return { claim, write, stopAgent, bash };
}

test("guard: each sub-agent claims one task and edits only its files", () => {
  const repo = tempRepo({ ".workflow/cart.md": rec({ tasks: GOOD }), "src/a.ts": "a\n" });
  try {
    const s = session(repo, "/flow:execute M1");
    assert.match(reason(s.write("a1", "src/cart/store.ts")), /claim your task before editing/);
    assert.ok(allowed(s.claim("a1", "T1")));
    assert.equal(s.write("a1", "src/cart/store.ts"), null);
    assert.equal(s.write("a1", "tests/cart/store.test.ts"), null);
    assert.match(reason(s.write("a1", "src/price/rules.ts")), /isn't owned by T1/);
    assert.match(reason(s.write("a1", "contracts/cart.yaml")), /outside the execute lane/);
    assert.match(reason(s.claim("a2", "T1")), /already claimed by another agent/);
    assert.match(reason(s.claim("a1", "T2")), /already works on T1/);
    assert.match(reason(s.claim("a2", "T9")), /has no task T9/);
    assert.ok(allowed(s.claim("a2", "T2")));
    assert.match(reason(s.claim("a3", "T3")), /runs after T1, T2, which haven't finished/);
    s.stopAgent("a1");
    s.stopAgent("a2");
    assert.ok(allowed(s.claim("a3", "T3")));
    assert.equal(s.write("a3", "src/api/cart.ts"), null);
    // The lead agent (no agent_id) integrates within the execute lane.
    assert.equal(s.write(undefined, "src/price/rules.ts"), null);
  } finally {
    rm(repo);
  }
});

test("guard: no per-agent rule in a fix, without tasks, or outside execute", () => {
  const repo = tempRepo({ ".workflow/cart.md": rec({ tasks: GOOD }) });
  try {
    assert.equal(session(repo, "/flow:execute fix M1").write("a1", "src/x.ts"), null);
    assert.equal(session(repo, "/flow:execute M2").write("a1", "src/x.ts"), null);
    assert.ok(denied(session(repo, "/flow:harden M1").write("a1", "src/x.ts")));
    // A new /flow:execute forgets earlier claims.
    const s1 = session(repo, "/flow:execute M1");
    assert.ok(allowed(s1.claim("a1", "T1")));
  } finally {
    rm(repo);
  }
});

test("guard: only the exact claim command is auto-approved", () => {
  const repo = tempRepo({ ".workflow/cart.md": rec({ tasks: GOOD }) });
  try {
    const s = session(repo, "/flow:execute M1");
    const tail = "claim T1 --task .workflow/cart.md --milestone M1";
    for (const cmd of [
      `node "/x/lane.js" ${tail}; rm -rf src`,
      `node "/x/lane.js" ${tail} && curl x`,
      `node "/x/lane.js" ${tail} | sh`,
      `node "/x/$(evil)/lane.js" ${tail}`,
      `cd src && node lane.js ${tail}`,
    ]) assert.equal(s.bash("a1", cmd), null, cmd);
    assert.match(reason(s.write("a1", "src/cart/x.ts")), /claim your task/);
    assert.ok(allowed(s.bash("a1", `node "C:/Program Files/flow/scripts/lane.js" ${tail}`)));
  } finally {
    rm(repo);
  }
});

test("lane.js: tasks prints the split, claim prints the task, check --wave catches unowned files", () => {
  const repo = tempRepo({ ".workflow/cart.md": rec({ tasks: GOOD }), "src/a.ts": "a\n" });
  const run = (...args) => spawnSync("node", [LANE, ...args], { cwd: repo, encoding: "utf8" });
  try {
    const t = run("tasks", "--task", ".workflow/cart.md", "--milestone", "M1");
    assert.equal(t.status, 2, t.stdout);
    assert.match(t.stdout, /T3 covers no scenario/);
    const c = run("claim", "T2", "--task", ".workflow/cart.md", "--milestone", "M1");
    assert.equal(c.status, 0);
    assert.match(c.stdout, /owns: src\/price\/\*\*, tests\/price\/\*\*/);
    assert.equal(run("tasks", "--task", ".workflow/cart.md", "--milestone", "M2").status, 0);

    assert.equal(run("start", "execute", "--task", ".workflow/cart.md").status, 0);
    write(repo, { "src/cart/store.ts": "s\n", "src/price/rules.ts": "r\n" });
    assert.equal(run("check", "execute", "--task", ".workflow/cart.md", "--milestone", "M1", "--wave", "W1").status, 0);
    write(repo, { "src/a.ts": "changed\n" });
    const bad = run("check", "execute", "--task", ".workflow/cart.md", "--milestone", "M1", "--wave", "W1");
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /src\/a\.ts — not owned by any task of W1/);
  } finally {
    rm(repo);
  }
});
