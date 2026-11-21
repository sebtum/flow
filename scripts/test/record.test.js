const test = require("node:test");
const assert = require("node:assert/strict");
const record = require("../record");
const { RECORD } = require("./helpers");

test("fields: reads Mode and lanes from the Spec only", () => {
  const f = record.fields(RECORD);
  assert.equal(f.mode, "standard"); // "Mode: full" under Findings is ignored
  assert.equal(f.fixRounds, 2);
  assert.deepEqual(f.testPaths, ["tests/**", "**/*.test.ts"]);
  assert.deepEqual(f.qaPaths, ["qa/**"]);
  assert.deepEqual(f.contractPaths, ["contracts/**"]);
});

test("fields: defaults for an old record without the section", () => {
  const f = record.fields("# Task: x\n\n## Spec\n\n### Checks\n");
  assert.equal(f.mode, "lite");
  assert.deepEqual(f.testPaths, []);
});

test("fields: placeholders and 'none' mean empty", () => {
  const f = record.fields("## Spec\n- Test paths: <globs>\n- QA path: none\n- Contract path: —\n");
  assert.deepEqual([f.testPaths, f.qaPaths, f.contractPaths], [[], [], []]);
});

test("checks: rows by header, backticks stripped, escaped pipes kept", () => {
  const rows = record.checks(RECORD);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].kind, "contract");
  assert.equal(rows[1].command, 'node -e "process.exit(0)"');
  assert.equal(rows[3].command, "echo a | grep a");
});

test("checks: a record without a Kind column still parses", () => {
  const rows = record.checks("## Spec\n### Checks\n| Command | Directory | Prerequisites | Source |\n|---|---|---|---|\n| `make test` | . | — | Makefile |\n");
  assert.equal(rows[0].command, "make test");
  assert.equal(rows[0].kind, "");
});

test("gatesFor and judgeFor", () => {
  assert.deepEqual(record.gatesFor(RECORD, "M1"), ["clean", "qa"]);
  assert.deepEqual(record.gatesFor(RECORD, "M2"), []);
  assert.deepEqual(record.gatesFor(RECORD.replace("Mode: standard", "Mode: full"), "M2"), ["clean", "harden", "qa"]);
  assert.equal(record.judgeFor(RECORD, "M1"), "verify-codex");
  assert.equal(record.judgeFor(RECORD, "M2"), "verify");
  assert.equal(record.judgeFor(RECORD.replace("Mode: standard", "Mode: full"), "M2"), "verify-codex");
});

test("matches: basename patterns, directory patterns, **", () => {
  assert.ok(record.matches("src/a/b.test.ts", ["**/*.test.ts"]));
  assert.ok(record.matches("src/a/b.test.ts", ["*.test.ts"]));
  assert.ok(record.matches("tests/x/y.py", ["tests/**"]));
  assert.ok(record.matches("tests/x/y.py", ["tests/"]));
  assert.ok(record.matches("tests\\x\\y.py", ["tests/**"]));
  assert.ok(!record.matches("src/tests.ts", ["tests/**"]));
  assert.ok(!record.matches("src/b.ts", ["**/*.test.ts"]));
});

test("lane rules per step", () => {
  const f = record.fields(RECORD);
  const task = ".workflow/items.md";
  const ex = record.lane("execute", f);
  assert.equal(ex("src/a.ts", task), null);
  assert.equal(ex("tests/a.test.ts", task), null);
  assert.match(ex("contracts/api.yaml", task), /plan/);
  assert.match(ex("qa/s1.spec.ts", task), /qa/);

  const cl = record.lane("clean", f);
  assert.equal(cl("src/a.ts", task), null);
  assert.equal(cl(".workflow/items.log.md", task), null);
  assert.match(cl("tests/a.py", task), /harden/);
  assert.match(cl(".workflow/items.md", task), /clean/);

  const hd = record.lane("harden", f);
  assert.equal(hd("tests/a.py", task), null);
  assert.equal(hd("src/a.test.ts", task), null);
  assert.match(hd("src/a.ts", task), /tests/);

  const qa = record.lane("qa", f);
  assert.equal(qa("qa/s1.spec.ts", task), null);
  assert.equal(qa(task, task), null);
  assert.match(qa("src/a.ts", task), /QA/);

  const vf = record.lane("verify", f);
  assert.equal(vf(task, task), null);
  assert.match(vf("src/a.ts", task), /Findings/);

  assert.equal(record.lane("plan", f)("contracts/api.yaml", task), null);
});

test("laneMissing", () => {
  const f = record.fields("## Spec\n- Mode: full\n");
  assert.match(record.laneMissing("harden", f), /Test paths/);
  assert.equal(record.laneMissing("execute", f), null);
});
