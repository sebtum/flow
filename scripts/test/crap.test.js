const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const crap = require("../crap");
const { tempRepo, write, rm, sh } = require("./helpers");

const SCRIPT = path.join(__dirname, "..", "crap.js");

test("formula: CRAP equals complexity at full coverage, grows with the square without tests", () => {
  assert.equal(crap.crap(8, 1), 8);
  assert.equal(crap.crap(6, 0), 42);
  assert.equal(crap.crap(2, 0), 6);
  assert.ok(Math.abs(crap.crap(7, 0.8) - 7.392) < 1e-9);
});

test("parseLizardCsv: real lizard 1.x output, quoted fields", () => {
  const csv = '6,3,21,1,6,"f@1-6@src/a.py","src/a.py","f","f( x )",1,6\n4,3,27,1,4,"g@1-4@src/b.ts","src/b.ts","g","g ( a , b )",1,4\n';
  const rows = crap.parseLizardCsv(csv);
  assert.deepEqual(rows[0], { ccn: 3, file: "src/a.py", name: "f", start: 1, end: 6 });
  assert.equal(rows[1].name, "g");
});

test("parseLcov: relative and absolute SF paths, max hits per line", () => {
  const root = path.resolve("/repo");
  const lcov = `SF:src/a.py\nDA:1,1\nDA:2,0\nend_of_record\nSF:${path.join(root, "src", "b.ts")}\nDA:1,3\nDA:1,0\nend_of_record\n`;
  const cov = crap.parseLcov(lcov, root, root);
  assert.equal(cov.get("src/a.py").get(2), 0);
  assert.equal(cov.get("src/b.ts").get(1), 3);
});

test("score: only changed functions, refactor vs test-gap", () => {
  const functions = [
    { ccn: 10, file: "a.py", name: "big", start: 1, end: 20 },
    { ccn: 5, file: "a.py", name: "untested", start: 21, end: 30 },
    { ccn: 2, file: "a.py", name: "fine", start: 31, end: 35 },
    { ccn: 9, file: "a.py", name: "unchanged", start: 40, end: 60 },
  ];
  const changed = new Map([["a.py", new Set([5, 25, 33])]]);
  const da = new Map();
  for (let l = 1; l <= 20; l++) da.set(l, 1);
  for (let l = 31; l <= 35; l++) da.set(l, 1);
  const rows = crap.score({ functions, changed, coverage: new Map([["a.py", da]]), max: 8, all: false });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.big.action, "refactor"); // complexity 10 > 8 even fully covered
  assert.equal(by.untested.action, "test-gap"); // 5² + 5 = 30 > 8, complexity fine
  assert.equal(by.untested.noData, true);
  assert.equal(by.fine.action, "ok");
  assert.equal(by.unchanged, undefined);
  assert.equal(rows[0].name, "untested"); // worst first
});

test("crap.js end to end: changed lines from git, test paths excluded, exit 5 over the limit", () => {
  const repo = tempRepo({ "src/a.py": "def f(x):\n    return x\n", ".workflow/t.md": "## Spec\n- Test paths: `tests/**`\n" });
  try {
    write(repo, {
      "src/a.py": "def f(x):\n    if x:\n        return 1\n    return x\n",
      "tests/test_a.py": "def test_f():\n    if True:\n        pass\n",
      "lizard.csv": '4,2,10,1,4,"f@1-4@src/a.py","src/a.py","f","f( x )",1,4\n3,2,8,0,3,"test_f@1-3@tests/test_a.py","tests/test_a.py","test_f","test_f( )",1,3\n',
      "lcov.info": "SF:src/a.py\nDA:1,1\nDA:2,1\nDA:3,0\nDA:4,1\nend_of_record\n",
    });
    const base = sh("git", ["rev-parse", "HEAD"], repo).trim();
    let r = spawnSync("node", [SCRIPT, "--lcov", "lcov.info", "--base", base, "--task", ".workflow/t.md", "--lizard-csv", "lizard.csv"], { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\| f \| src\/a\.py:1 \| 2 \| 75% \| 2\.1 \| ok \|/);
    assert.doesNotMatch(r.stdout, /test_f/);

    r = spawnSync("node", [SCRIPT, "--lcov", "lcov.info", "--base", base, "--max", "1.5", "--lizard-csv", "lizard.csv"], { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 5);
    assert.match(r.stdout, /refactor/);

    r = spawnSync("node", [SCRIPT, "--lcov", "missing.info", "--base", base, "--lizard-csv", "lizard.csv"], { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /LCOV file not found/);
  } finally {
    rm(repo);
  }
});
