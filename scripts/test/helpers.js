// Test helpers: throwaway git repos and a sample task record.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function sh(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function tempRepo(files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-test-")));
  sh("git", ["init", "-q", "-b", "main"], dir);
  sh("git", ["config", "user.email", "t@example.com"], dir);
  sh("git", ["config", "user.name", "t"], dir);
  sh("git", ["config", "core.autocrlf", "false"], dir);
  write(dir, files);
  sh("git", ["add", "-A"], dir);
  sh("git", ["commit", "-q", "--allow-empty", "-m", "base"], dir);
  return dir;
}

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const RECORD = `# Task: items

## Spec

### Mode and lanes
- Mode: standard
- Fix rounds: 2
- Test paths: \`tests/**\`, \`**/*.test.ts\`
- QA path: \`qa/**\`
- Contract path: \`contracts/**\`

### Checks
| Kind | Command | Directory | Prerequisites | Source |
|---|---|---|---|---|
| unit | \`npm test\` | . | node | package.json |
| contract | \`node -e "process.exit(0)"\` | . | node | plan |
| contract-live | \`node -e "process.exit(1)"\` | . | services | plan |
| lint | \`echo a \\| grep a\` | . | — | docs |

### Milestones
#### M1: List items
- Depends on: —
- Judge: verify-codex · Touches: auth
- Gates: clean, qa

#### M2: Docs
- Depends on: M1

## Findings
- Mode: full
`;

module.exports = { sh, tempRepo, write, rm, RECORD };
