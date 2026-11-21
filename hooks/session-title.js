#!/usr/bin/env node
// UserPromptSubmit hook: names the session after the flow stage being run,
// e.g. "/flow:execute M2" -> "items-pagination · execute M2".
// It also saves the stage for this session, so hooks/guard.js knows which lane applies.
// Prints nothing for other prompts and never blocks a prompt.
const fs = require("fs");
const path = require("path");
const stage = require("./stage");
const record = require("../scripts/record");

const STAGE = /^\s*\/flow:(plan|roadmap|execute|clean|harden|qa|verify-codex|verify)(?![\w-])[ \t]*([^\r\n]*)/;

function taskName(cwd) {
  const records = record.listRecords(cwd);
  return records.length === 1 ? records[0].slice(0, -3) : null;
}

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const match = STAGE.exec(input.prompt || "");
  if (match) {
    const cwd = input.cwd || process.cwd();
    const fullArgs = match[2].trim();
    let args = fullArgs;
    if (args.length > 40) args = args.slice(0, 39).trimEnd() + "…";
    const name = [match[1], args].filter(Boolean).join(" ");
    const task = taskName(cwd);
    const title = task ? `${task} · ${name}` : `flow ${name}`;
    try {
      const words = fullArgs.split(/\s+/);
      stage.clearClaims(input.session_id);
      stage.save(input.session_id, {
        stage: match[1],
        args: fullArgs,
        fix: /^fix\b/i.test(fullArgs),
        milestone: (words.find((w) => /^M\d+$/i.test(w)) || "").toUpperCase() || null,
        task: record.pickRecord(cwd, words),
        cwd,
      });
    } catch {
      // The title still works without the saved stage.
    }
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title },
      })
    );
  }
} catch {
  // Malformed input or anything unexpected: leave the session name alone.
}
process.exit(0);
