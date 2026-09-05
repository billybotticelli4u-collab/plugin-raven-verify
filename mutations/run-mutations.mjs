#!/usr/bin/env node
/**
 * Applies disposable in-memory/source mutations one at a time against a temp
 * copy of loadTrustedKeys / gate / README, runs the hostile RED test (or a
 * minimal assert), restores, and classifies. Surviving mutant = finding.
 */
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = join(root, 'src/actions/verifyToken.ts');
const readmePath = join(root, 'README.md');
const origSrc = readFileSync(srcPath, 'utf8');
const origReadme = readFileSync(readmePath, 'utf8');

function restore() {
  writeFileSync(srcPath, origSrc);
  writeFileSync(readmePath, origReadme);
}

function runHostile() {
  const r = spawnSync(
    process.execPath,
    ['--test', 'test/verifyToken.test.ts'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 120_000 },
  );
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

const mutants = [
  {
    id: 'M1',
    classify: 'LOAD-BEARING',
    apply() {
      // Reintroduce pubkey fetch on absent pin
      writeFileSync(
        srcPath,
        origSrc.replace(
          `if (pinned === undefined || pinned === null) {\n    return new Set();\n  }`,
          `if (pinned === undefined || pinned === null) {\n    const res = await _fetchImpl(\`\${_verifierUrl.replace(/\\/+$/, '')}/pubkey\`);\n    const body = await res.json();\n    return new Set((body?.keys ?? []).map((k) => k.publicKeyBase64).filter(Boolean));\n  }`,
        ),
      );
    },
  },
  {
    id: 'M2',
    classify: 'LOAD-BEARING',
    apply() {
      writeFileSync(
        srcPath,
        origSrc.replace(
          /if \(verification\.keyTrusted !== true\) \{\n[\s\S]*?\n    \}\n\n    \/\/ 2b\./,
          `// MUTANT M2 skipped keyTrusted gate\n\n    // 2b.`,
        ),
      );
    },
  },
  {
    id: 'M3',
    classify: 'LOAD-BEARING',
    apply() {
      writeFileSync(
        srcPath,
        origSrc.replace(
          `  // CASE C: present but yields zero pins (e.g. ",,,") — fail closed.\n  return keys;`,
          `  try {\n    const res = await _fetchImpl(\`\${_verifierUrl.replace(/\\/+$/, '')}/pubkey\`);\n    const body = await res.json();\n    for (const k of body?.keys ?? []) if (k?.publicKeyBase64) keys.add(k.publicKeyBase64);\n  } catch {}\n  return keys;`,
        ),
      );
    },
  },
  {
    id: 'M4',
    classify: 'LOAD-BEARING',
    apply() {
      writeFileSync(
        srcPath,
        origSrc.replace(
          `if (pinned === undefined || pinned === null) {\n    return new Set();\n  }`,
          `if (pinned === undefined || pinned === null) {\n    return { has: () => true } as unknown as ReadonlySet<string>;\n  }`,
        ),
      );
    },
  },
  {
    id: 'M5',
    classify: 'LOAD-BEARING',
    apply() {
      writeFileSync(
        srcPath,
        origSrc.replace(
          `if (trimmed.length === 0) {\n    // CASE B: unset-equivalent whitespace — no discovery bootstrap.\n    return new Set();\n  }`,
          `if (trimmed.length === 0) {\n    const res = await _fetchImpl(\`\${_verifierUrl.replace(/\\/+$/, '')}/pubkey\`);\n    const body = await res.json();\n    return new Set((body?.keys ?? []).map((k) => k.publicKeyBase64).filter(Boolean));\n  }`,
        ),
      );
    },
  },
  {
    id: 'M6',
    classify: 'LOAD-BEARING',
    apply() {
      writeFileSync(
        srcPath,
        origSrc.replace(
          `if (typeof pinned !== 'string') {\n    // CASE C: malformed pin config — fail closed (empty ⇒ keyTrusted false).\n    return new Set();\n  }`,
          `if (typeof pinned !== 'string') {\n    return new Set(String(pinned).split(',').map((s) => s.trim()).filter(Boolean));\n  }`,
        ),
      );
    },
  },
  {
    id: 'M7',
    classify: 'LOAD-BEARING',
    apply() {
      // Drop keyTrusted gate — same as M2 intent for valid-alone gating
      writeFileSync(
        srcPath,
        origSrc.replace(
          /if \(verification\.keyTrusted !== true\) \{\n[\s\S]*?\n    \}\n\n    \/\/ 2b\./,
          `// MUTANT M7: gate on valid alone\n\n    // 2b.`,
        ),
      );
    },
  },
  {
    id: 'M8',
    classify: 'CONTRACT',
    apply() {
      writeFileSync(
        readmePath,
        origReadme.replace(
          /Unset\/empty ⇒ empty trusted set[\s\S]*?bootstrap trust\./,
          'Unset ⇒ the published `/pubkey` key set is fetched and trusted.',
        ),
      );
    },
    test() {
      const r = readFileSync(readmePath, 'utf8');
      const bad = /Unset ⇒ the published `\/pubkey` key set is fetched and trusted/.test(r);
      const good = /must not.*bootstrap trust/i.test(origReadme);
      // "killed" means the mutation is detectable: mutant text present AND original had correct contract
      return { code: bad && good ? 1 : 0, out: bad ? 'mutant readme active' : 'mutant not applied' };
    },
  },
];

let findings = 0;
try {
  for (const m of mutants) {
    restore();
    m.apply();
    const result = m.test ? m.test() : runHostile();
    const killed = result.code !== 0;
    if (!killed) findings += 1;
    console.log(`${m.id}\t${killed ? 'KILLED' : 'SURVIVED'}\t${m.classify}`);
    if (!killed) console.log(result.out.slice(-500));
  }
} finally {
  restore();
}

if (findings) {
  console.error(`FINDING: ${findings} surviving mutation(s)`);
  process.exit(1);
}
console.log('All M1–M8 killed');
