const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const { tempRepo, rm, RECORD } = require("./helpers");

const SCRIPT = path.join(__dirname, "..", "contract.js");
const run = (repo, ...args) => spawnSync("node", [SCRIPT, "--task", ".workflow/items.md", ...args], { cwd: repo, encoding: "utf8" });

test("static: runs only Kind contract rows", () => {
  const repo = tempRepo({ ".workflow/items.md": RECORD });
  try {
    const r = run(repo, "--static");
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^PASS {4}contract/m);
    assert.match(r.stdout, /^SKIP {4}contract-live/m);
  } finally {
    rm(repo);
  }
});

test("all: a failing live contract fails the run", () => {
  const repo = tempRepo({ ".workflow/items.md": RECORD });
  try {
    const r = run(repo);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /^FAIL {4}contract-live .*exit 1/m);
  } finally {
    rm(repo);
  }
});

test("missing command is reported, exit 4", () => {
  const rec = RECORD.replace('`node -e "process.exit(0)"`', "missing").replace(/\| contract-live .*\n/, "");
  const repo = tempRepo({ ".workflow/items.md": rec });
  try {
    const r = run(repo);
    assert.equal(r.status, 4, r.stdout);
    assert.match(r.stdout, /^MISSING contract/m);
  } finally {
    rm(repo);
  }
});

test("no contract rows: exit 0; unreadable record: exit 1", () => {
  const repo = tempRepo({ ".workflow/items.md": "## Spec\n### Checks\n| Kind | Command |\n|---|---|\n| unit | npm test |\n" });
  try {
    assert.equal(run(repo).status, 0);
    assert.equal(spawnSync("node", [SCRIPT, "--task", ".workflow/nope.md"], { cwd: repo }).status, 1);
  } finally {
    rm(repo);
  }
});

test("failure output tail and Directory are used", () => {
  const rec = RECORD.replace('`node -e "process.exit(0)"` | . |', '`node -e "console.log(require(\'path\').basename(process.cwd()));process.exit(2)"` | contracts |');
  const repo = tempRepo({ ".workflow/items.md": rec, "contracts/x.txt": "x" });
  try {
    const r = run(repo, "--static");
    assert.equal(r.status, 3);
    assert.match(r.stdout, /FAIL {4}contract .*exit 2/);
    assert.match(r.stdout, /^ {4}contracts$/m);
  } finally {
    rm(repo);
  }
});
