const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { tempRepo, write, rm, sh, RECORD } = require("./helpers");

const SCRIPT = path.join(__dirname, "..", "lane.js");
const run = (repo, ...args) => spawnSync("node", [SCRIPT, ...args, "--task", ".workflow/items.md"], { cwd: repo, encoding: "utf8" });

function setup() {
  return tempRepo({ ".workflow/items.md": RECORD, "src/a.ts": "export const a = 1;\n", "tests/a.test.ts": "test('a', () => {});\n" });
}

test("harden: new and edited tests are in lane", () => {
  const repo = setup();
  try {
    write(repo, { "src/b.ts": "pre-existing change\n" }); // changed before start: not counted
    assert.equal(run(repo, "start", "harden").status, 0);
    write(repo, { "tests/a.test.ts": "test('a2', () => {});\n", "tests/new.test.ts": "x\n", ".workflow/items.log.md": "notes\n" });
    const r = run(repo, "check", "harden");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /3 file\(s\)/);
  } finally {
    rm(repo);
  }
});

test("harden: source edits, untracked files and deletions outside the lane are listed", () => {
  const repo = setup();
  try {
    write(repo, { "src/b.ts": "pre-existing\n" });
    run(repo, "start", "harden");
    write(repo, { "src/a.ts": "export const a = 2;\n", "scratch.txt": "x\n", "src/b.ts": "changed again\n" });
    fs.unlinkSync(path.join(repo, "tests", "a.test.ts"));
    const r = run(repo, "check", "harden");
    assert.equal(r.status, 2);
    assert.match(r.stdout, /src\/a\.ts/);
    assert.match(r.stdout, /scratch\.txt/);
    assert.match(r.stdout, /src\/b\.ts/);
    assert.doesNotMatch(r.stdout, /tests\/a\.test\.ts —/);
  } finally {
    rm(repo);
  }
});

test("clean: committed test changes are caught too", () => {
  const repo = setup();
  try {
    run(repo, "start", "clean");
    write(repo, { "tests/a.test.ts": "weakened\n", "src/a.ts": "export const a = 3;\n" });
    sh("git", ["commit", "-qam", "step"], repo);
    const r = run(repo, "check", "clean");
    assert.equal(r.status, 2);
    assert.match(r.stdout, /tests\/a\.test\.ts — clean refactors code only/);
    assert.doesNotMatch(r.stdout, /src\/a\.ts —/);
  } finally {
    rm(repo);
  }
});

test("check without start is an error", () => {
  const repo = setup();
  try {
    const r = run(repo, "check", "qa");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No lane start/);
  } finally {
    rm(repo);
  }
});
