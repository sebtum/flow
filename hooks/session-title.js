#!/usr/bin/env node
// UserPromptSubmit hook: names the session after the flow stage being run,
// e.g. "/flow:execute M2" -> "items-pagination · execute M2".
// Prints nothing for other prompts and never blocks a prompt.
const fs = require("fs");
const path = require("path");

const STAGE = /^\s*\/flow:(plan|execute|verify-codex|verify)(?![\w-])[ \t]*([^\r\n]*)/;

function taskName(cwd) {
  try {
    const records = fs
      .readdirSync(path.join(cwd, ".workflow"))
      .filter((f) => f.endsWith(".md") && !f.endsWith(".log.md"));
    return records.length === 1 ? records[0].slice(0, -3) : null;
  } catch {
    return null;
  }
}

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const match = STAGE.exec(input.prompt || "");
  if (match) {
    let args = match[2].trim();
    if (args.length > 40) args = args.slice(0, 39).trimEnd() + "…";
    const stage = [match[1], args].filter(Boolean).join(" ");
    const task = taskName(input.cwd || process.cwd());
    const title = task ? `${task} · ${stage}` : `flow ${stage}`;
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
