#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function appendSummary(text) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  appendFileSync(
    summaryPath,
    [
      "### Consumer-tree audit of the packed tarball (non-blocking visibility)",
      "",
      "```",
      text.trimEnd(),
      "```",
      "",
    ].join("\n"),
  );
}

const work = mkdtempSync(join(tmpdir(), "consumer-tree-audit-"));
try {
  execFileSync("npm", ["pack", "--pack-destination", work], { stdio: "inherit" });
  const [tarball] = readdirSync(work).filter((name) => name.endsWith(".tgz"));
  if (!tarball) {
    throw new Error(`npm pack did not produce a tarball in ${work}`);
  }

  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  execFileSync("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
  execFileSync("npm", ["install", join(work, tarball)], {
    cwd: consumer,
    stdio: "inherit",
  });

  const audit = spawnSync("npm", ["audit", "--audit-level=high"], {
    cwd: consumer,
    encoding: "utf8",
  });
  if (audit.error) throw audit.error;
  const output = [audit.stdout, audit.stderr].filter(Boolean).join("");

  process.stdout.write(output);
  appendSummary(output);

  process.exit(audit.status ?? 1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
