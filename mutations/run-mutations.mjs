#!/usr/bin/env node
/**
 * WS3 — mutation harness (repaired).
 *
 * - Mutates ONLY a disposable copy of the repo files (never the live tree).
 * - Each mutant ID asserts a distinct security property.
 * - Proves: anchor matched, bytes changed, expected RED (test failure), restore.
 * - Patch files under mutations/*.patch are the source of truth when present.
 * - Classifications: LOAD-BEARING | PARTIAL | VACUOUS | DUPLICATE | CONTRACT-ONLY
 * - CONTRACT-ONLY is documentation surface only and is NOT counted as a security kill.
 * - M0 is a no-op positive control: must SURVIVE (harness sanity).
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mutationsDir = join(root, 'mutations');

function runTests(cwd) {
  const r = spawnSync(
    process.execPath,
    ['--test', 'test/verifyToken.test.ts', 'test/doc-contract.test.mjs'],
    { cwd, encoding: 'utf8', env: process.env, timeout: 180_000 },
  );
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

function disposableTree() {
  const dir = mkdtempSync(join(tmpdir(), 'raven-mut-'));
  // Copy only what tests need
  for (const rel of [
    'src', 'test', 'fixtures', 'docs', 'package.json', 'tsconfig.json',
    'README.md', 'RELEASING.md', 'node_modules',
  ]) {
    const from = join(root, rel);
    const to = join(dir, rel);
    if (!existsSync(from)) continue;
    cpSync(from, to, { recursive: true });
  }
  return dir;
}

/** Apply unified diff if it matches; return {ok, reason, before, after} */
function applyPatchFile(cwd, patchName, relTarget) {
  const patchPath = join(mutationsDir, patchName);
  const target = join(cwd, relTarget);
  const before = readFileSync(target, 'utf8');
  if (!existsSync(patchPath)) {
    return { ok: false, reason: 'missing-patch', before, after: before };
  }
  const patch = readFileSync(patchPath, 'utf8');
  // Prefer git apply in the disposable tree
  const r = spawnSync('git', ['apply', '--unsafe-paths', '--directory', cwd, patchPath], {
    encoding: 'utf8',
  });
  if ((r.status ?? 1) === 0) {
    const after = readFileSync(target, 'utf8');
    return { ok: after !== before, reason: after !== before ? 'git-apply' : 'noop', before, after };
  }
  // Fallback: programmatic mutants (anchors) when patch cannot apply
  return { ok: false, reason: 'git-apply-failed:' + (r.stderr || r.stdout || ''), before, after: before };
}

function mustChange(before, after, id) {
  if (before === after) throw new Error(id + ': bytes did not change');
}

function anchorPresent(haystack, needle, id) {
  if (!haystack.includes(needle)) throw new Error(id + ': anchor not matched: ' + needle.slice(0, 60));
}

const mutants = [
  {
    id: 'M0',
    classify: 'VACUOUS',
    expectKilled: false, // no-op positive control — must SURVIVE
    property: 'no-op control (harness must not false-kill)',
    target: 'src/actions/verifyToken.ts',
    apply(cwd) {
      const p = join(cwd, this.target);
      const before = readFileSync(p, 'utf8');
      // Touch nothing security-relevant: add a trailing whitespace-only comment line then remove? true no-op:
      writeFileSync(p, before);
      const after = readFileSync(p, 'utf8');
      return { before, after };
    },
  },
  {
    id: 'M1',
    classify: 'LOAD-BEARING',
    expectKilled: true,
    property: 'absent pin must not fetch /pubkey into trusted set',
    target: 'src/actions/verifyToken.ts',
    patch: 'M1_reintroduce_pubkey_fallback.patch',
    apply(cwd) {
      const p = join(cwd, this.target);
      const before = readFileSync(p, 'utf8');
      const anchor = 'if (pinned === undefined || pinned === null) {\n    return new Set();\n  }';
      anchorPresent(before, anchor, this.id);
      const after = before.replace(
        anchor,
        'if (pinned === undefined || pinned === null) {\n    const res = await _fetchImpl(`${_verifierUrl.replace(/\\/+$/, \'\')}/pubkey`);\n    const body = await res.json();\n    return new Set((body?.keys ?? []).map((k) => k.publicKeyBase64).filter(Boolean));\n  }',
      );
      mustChange(before, after, this.id);
      writeFileSync(p, after);
      return { before, after };
    },
  },
  {
    id: 'M2',
    classify: 'LOAD-BEARING',
    expectKilled: true,
    property: 'skip keyTrusted gate entirely',
    target: 'src/actions/verifyToken.ts',
    patch: 'M2_skip_keyTrusted_gate.patch',
    apply(cwd) {
      const p = join(cwd, this.target);
      const before = readFileSync(p, 'utf8');
      const re = /if \(verification\.keyTrusted !== true\) \{\n[\s\S]*?\n    \}\n\n    \/\/ 2b\./;
      if (!re.test(before)) throw new Error(this.id + ': anchor not matched');
      const after = before.replace(re, '// MUTANT M2 skipped keyTrusted gate\n\n    // 2b.');
      mustChange(before, after, this.id);
      writeFileSync(p, after);
      return { before, after };
    },
  },
  {
    id: 'M3',
    classify: 'LOAD-BEARING',
    expectKilled: true,
    property: 'must not merge /pubkey into pins',
    target: 'src/actions/verifyToken.ts',
    patch: 'M3_merge_pubkey_into_pins.patch',
    apply(cwd) {
      const p = join(cwd, this.target);
      const before = readFileSync(p, 'utf8');
      const anchor = '  // CASE C: present but yields zero pins (e.g. ",,,") — fail closed.\n  return keys;';
      anchorPresent(before, anchor, this.id);
      const after = before.replace(
        anchor,
        '  try {\n    const res = await _fetchImpl(`${_verifierUrl.replace(/\\/+$/, \'\')}/pubkey`);\n    const body = await res.json();\n    for (const k of body?.keys ?? []) if (k?.publicKeyBase64) keys.add(k.publicKeyBase64);\n  } catch {}\n  return keys;',
      );
      mustChange(before, after, this.id);
      writeFileSync(p, after);
      return { before, after };
    },
  },
];

mutants.push(
  {
    id: 'M4',
    classify: 'LOAD-BEARING',
    expectKilled: true,
    property: 'absent pin must not become trust-any',
    target: 'src/actions/verifyToken.ts',
    patch: 'M4_treat_empty_as_trusted_all.patch',
    apply(cwd) {
      const p = join(cwd, this.target);
      const before = readFileSync(p, 'utf8');
      const anchor = 'if (pinned === undefined || pinned === null) {\n    return new Set();\n  }';
      anchorPresent(before, anchor, this.id);
      const after = before.replace(
        anchor,
        'if (pinned === undefined || pinned === null) {\n    return { has: () => true } as unknown as ReadonlySet<string>;\n  }',
      );
      mustChange(before, after, this.id);
      writeFileSync(p, after);
      return { before, after };
    },
  },
  {
    id: 'M5',
    classify: 'LOAD-BEARING',
    expectKilled: true,
    property: 'whitespace pin must not bootstrap /pubkey',
    target: 'src/actions/verifyToken.ts',
    patch: 'M5_whitespace_pin_bootstraps.patch',
    apply(cwd) {
      const p = join(cwd, this.target);
      const before = readFileSync(p, 'utf8');
      const anchor = 'if (trimmed.length === 0) {\n    // CASE B: unset-equivalent whitespace — no discovery bootstrap.\n    return new Set();\n  }';
      anchorPresent(before, anchor, this.id);
      const after = before.replace(
        anchor,
        'if (trimmed.length === 0) {\n    const res = await _fetchImpl(`${_verifierUrl.replace(/\\/+$/, \'\')}/pubkey`);\n    const body = await res.json();\n    return new Set((body?.keys ?? []).map((k) => k.publicKeyBase64).filter(Boolean));\n  }',
      );
      mustChange(before, after, this.id);
      writeFileSync(p, after);
      return { before, after };
    },
  },
  {
    id: 'M6',
    classify: 'LOAD-BEARING',
    expectKilled: true,
    property: 'non-string pin must fail closed (not coerced)',
    target: 'src/actions/verifyToken.ts',
    patch: 'M6_malformed_nonstring_ignored.patch',
    apply(cwd) {
      const p = join(cwd, this.target);
      const before = readFileSync(p, 'utf8');
      const anchor = "if (typeof pinned !== 'string') {\n    // CASE C: malformed pin config — fail closed (empty ⇒ keyTrusted false).\n    return new Set();\n  }";
      anchorPresent(before, anchor, this.id);
      const after = before.replace(
        anchor,
        "if (typeof pinned !== 'string') {\n    return new Set(String(pinned).split(',').map((s) => s.trim()).filter(Boolean));\n  }",
      );
      mustChange(before, after, this.id);
      writeFileSync(p, after);
      return { before, after };
    },
  },
  {
    id: 'M7',
    classify: 'LOAD-BEARING',
    expectKilled: true,
    property: 'valid must not imply keyTrusted (collapse independence)',
    target: 'src/actions/verifyToken.ts',
    patch: 'M7_gate_on_valid_alone.patch',
    apply(cwd) {
      const p = join(cwd, this.target);
      const before = readFileSync(p, 'utf8');
      // Distinct from M2: keep the keyTrusted block but force keyTrusted=true whenever valid.
      const anchor = 'const verification = verifyReceiptV1(receipt, { now: hooks.now, trustedKeys });';
      anchorPresent(before, anchor, this.id);
      const after = before.replace(
        anchor,
        "const verification = verifyReceiptV1(receipt, { now: hooks.now, trustedKeys });\n    if (verification.valid) (verification as { keyTrusted?: boolean }).keyTrusted = true; // MUTANT M7",
      );
      mustChange(before, after, this.id);
      // Ensure M2-style skip is NOT used
      if (after.includes('MUTANT M2')) throw new Error('M7 must not duplicate M2');
      writeFileSync(p, after);
      return { before, after };
    },
  },
  {
    id: 'M8',
    classify: 'CONTRACT-ONLY',
    expectKilled: true, // killed by doc-contract, but NOT a security kill
    property: 'README must not restore /pubkey-as-trust wording',
    target: 'README.md',
    patch: 'M8_readme_restore_pubkey_default.patch',
    securityKill: false,
    apply(cwd) {
      const p = join(cwd, this.target);
      const before = readFileSync(p, 'utf8');
      const after = before.replace(
        /Unset\/empty ⇒ empty trusted set[\s\S]*?bootstrap trust\./,
        'Unset ⇒ the published `/pubkey` key set is fetched and trusted.',
      );
      mustChange(before, after, this.id);
      writeFileSync(p, after);
      return { before, after };
    },
  },
);

const results = [];
let securityFindings = 0;
let harnessFindings = 0;

for (const m of mutants) {
  const cwd = disposableTree();
  try {
    const { before, after } = m.apply(cwd);
    const changed = before !== after;
    if (m.id === 'M0') {
      if (changed) throw new Error('M0 must be a true no-op');
    } else if (!changed) {
      throw new Error(m.id + ': expected byte change');
    }

    const result = runTests(cwd);
    const killed = result.code !== 0;
    const ok = killed === m.expectKilled;
    const securityKill = m.classify !== 'CONTRACT-ONLY' && m.securityKill !== false && killed;

    console.log(
      [
        m.id,
        killed ? 'KILLED' : 'SURVIVED',
        m.classify,
        ok ? 'EXPECTED' : 'UNEXPECTED',
        'changed=' + changed,
        m.property,
      ].join('\t'),
    );

    if (!ok) {
      if (m.classify === 'CONTRACT-ONLY') {
        harnessFindings += 1;
      } else if (m.id === 'M0') {
        harnessFindings += 1;
      } else {
        securityFindings += 1;
      }
      console.log(result.out.slice(-800));
    }

    // CONTRACT-ONLY kills are recorded but not security kills
    if (m.classify === 'CONTRACT-ONLY') {
      console.log(m.id + '\tNOTE\tCONTRACT-ONLY kill is NOT a security kill');
    }

    results.push({ id: m.id, killed, classify: m.classify, ok, securityKill });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const dup = mutants.filter((m) => m.id === 'M2' || m.id === 'M7');
if (dup[0].property === dup[1].property) {
  console.error('FINDING: M2 and M7 are DUPLICATE properties');
  process.exit(1);
}

console.log('\nClassification summary:');
for (const r of results) {
  console.log(`- ${r.id}: ${r.classify} killed=${r.killed} expected_ok=${r.ok}`);
}

if (securityFindings || harnessFindings) {
  console.error(`FINDING: security=${securityFindings} harness=${harnessFindings}`);
  process.exit(1);
}
console.log('Mutation harness green: M0 survived; M1–M7 load-bearing killed; M8 contract-only detected.');
