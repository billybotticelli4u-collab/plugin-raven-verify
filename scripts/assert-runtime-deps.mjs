#!/usr/bin/env node
// Release gate (blocking): assert the packed artifact's declared runtime
// dependency set is exactly the expected set. This is change-detection, not an
// audit: it fails the moment anyone adds a runtime dependency, widens or adds
// a peer, or adds an optional/bundled dependency — at which point advisories
// on that set become release-blocking too.
//
// The set is read from the packed tarball's package.json, not the working
// tree: the artifact is what a consumer installs.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The complete expected runtime dependency surface of the shipped package.
// Empty object/array means the field must be absent or empty in the artifact.
const EXPECTED = {
  dependencies: {},
  peerDependencies: { "@elizaos/core": "^1.0.0" },
  optionalDependencies: {},
  bundleDependencies: [],
  bundledDependencies: [],
};

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize).sort();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonicalize(value[k])]),
    );
  }
  return value;
}

const tmp = mkdtempSync(join(tmpdir(), "assert-runtime-deps-"));
try {
  const packOut = execFileSync(
    "npm",
    ["pack", "--pack-destination", tmp, "--json"],
    { encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(packOut);
  const pkgJson = execFileSync(
    "tar",
    ["-xzOf", join(tmp, filename), "package/package.json"],
    { encoding: "utf8" },
  );
  const pkg = JSON.parse(pkgJson);

  let failed = false;
  for (const [field, expected] of Object.entries(EXPECTED)) {
    const fallback = Array.isArray(expected) ? [] : {};
    const actual = canonicalize(pkg[field] ?? fallback);
    const want = canonicalize(expected);
    const ok = JSON.stringify(actual) === JSON.stringify(want);
    console.log(`${ok ? "ok  " : "FAIL"} ${field}: ${JSON.stringify(actual)}`);
    if (!ok) {
      console.error(`  expected exactly: ${JSON.stringify(want)}`);
      failed = true;
    }
  }

  if (failed) {
    console.error(
      "\nDeclared runtime dependency set changed. If intentional, update" +
        " EXPECTED in this script in the same change; advisories on the new" +
        " set are then release-blocking.",
    );
    process.exit(1);
  }
  console.log("\nDeclared runtime dependency set matches the expected set exactly.");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
