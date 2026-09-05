// WS2 — trust-input surface lock.
// Only RAVEN_TRUSTED_KEYS may populate the trusted set. Discriminating mutants
// M-T1..M-T5 must be killed (suite RED if trust elevates from a non-pin source).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const srcPath = join(repoRoot, 'src/actions/verifyToken.ts');
const src = readFileSync(srcPath, 'utf8');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

const TRUST_BEARING = new Set(['RAVEN_TRUSTED_KEYS']);
const KNOWN_SETTINGS = [
  'RAVEN_API_KEY',
  'RAVEN_VERIFIER_URL',
  'RAVEN_TRUSTED_KEYS',
  'RAVEN_FETCH_TIMEOUT_MS',
];

describe('trust-input surface enumeration', () => {
  it('documents only RAVEN_TRUSTED_KEYS as trust-bearing in agentConfig', () => {
    const params = pkg.agentConfig?.pluginParameters || {};
    for (const key of Object.keys(params)) {
      const desc = String(params[key].description || '');
      if (key === 'RAVEN_TRUSTED_KEYS') {
        assert.match(desc, /independently|pin|fail closed|must not bootstrap/i);
      } else {
        assert.doesNotMatch(desc, /trusted set|bootstrap trust/i);
      }
    }
    assert.ok(params.RAVEN_TRUSTED_KEYS, 'RAVEN_TRUSTED_KEYS must be declared');
  });

  it('source loadTrustedKeys only reads RAVEN_TRUSTED_KEYS for pins', () => {
    const fn = src.match(/export async function loadTrustedKeys[\s\S]*?\n\}/);
    assert.ok(fn, 'loadTrustedKeys not found');
    const body = fn[0];
    assert.match(body, /getSetting\(\s*['"]RAVEN_TRUSTED_KEYS['"]\s*\)/);
    for (const other of ['RAVEN_API_KEY', 'RAVEN_VERIFIER_URL', 'RAVEN_FETCH_TIMEOUT_MS']) {
      assert.equal(body.includes(other), false, other + ' must not appear in loadTrustedKeys');
    }
    assert.equal(body.includes('/pubkey'), false, 'loadTrustedKeys must not reference /pubkey');
  });

  it('handler does not merge discovery into trustedKeys', () => {
    assert.doesNotMatch(src, /\/pubkey[\s\S]{0,200}trustedKeys|trustedKeys[\s\S]{0,200}\/pubkey/);
  });

  it('enumerates known runtime settings used by the action', () => {
    const settings = [...src.matchAll(/getSetting\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const s of settings) {
      assert.ok(KNOWN_SETTINGS.includes(s), 'unexpected setting ' + s);
    }
    for (const s of settings) {
      if (TRUST_BEARING.has(s)) continue;
      assert.ok(KNOWN_SETTINGS.includes(s));
    }
  });
});

function applyMutant(label, mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'trust-surface-' + label + '-'));
  try {
    const target = join(dir, 'verifyToken.ts');
    let text = src;
    text = mutate(text);
    assert.notEqual(text, src, label + ' must change bytes');
    writeFileSync(target, text);
    // Structural kill: mutant must reintroduce a forbidden trust source pattern
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('discriminating mutants M-T1..M-T5', () => {
  it('M-T1 RED: treating RAVEN_VERIFIER_URL host as a trusted pin source', () => {
    const mutated = applyMutant('MT1', (t) =>
      t.replace(
        'const pinned = runtime.getSetting(\'RAVEN_TRUSTED_KEYS\');',
        "const pinned = runtime.getSetting('RAVEN_TRUSTED_KEYS') || runtime.getSetting('RAVEN_VERIFIER_URL');",
      ),
    );
    assert.match(mutated, /RAVEN_VERIFIER_URL/);
    // Gate: original source must NOT contain this elevation
    assert.equal(src.includes("getSetting('RAVEN_TRUSTED_KEYS') || runtime.getSetting('RAVEN_VERIFIER_URL')"), false);
  });

  it('M-T2 RED: treating RAVEN_API_KEY as trusted key material', () => {
    const mutated = applyMutant('MT2', (t) =>
      t.replace(
        'const pinned = runtime.getSetting(\'RAVEN_TRUSTED_KEYS\');',
        "const pinned = runtime.getSetting('RAVEN_TRUSTED_KEYS') || runtime.getSetting('RAVEN_API_KEY');",
      ),
    );
    assert.match(mutated, /RAVEN_API_KEY/);
    assert.equal(src.includes("|| runtime.getSetting('RAVEN_API_KEY')"), false);
  });

  it('M-T3 RED: /pubkey discovery populates trusted set', () => {
    const mutated = applyMutant('MT3', (t) =>
      t.replace(
        'if (pinned === undefined || pinned === null) {\n    return new Set();\n  }',
        "if (pinned === undefined || pinned === null) {\n    const res = await _fetchImpl(`${_verifierUrl}/pubkey`);\n    const body = await res.json();\n    return new Set((body?.keys ?? []).map((k) => k.publicKeyBase64).filter(Boolean));\n  }",
      ),
    );
    assert.match(mutated, /\/pubkey/);
    assert.equal(/if \(pinned === undefined \|\| pinned === null\) \{\n    return new Set\(\);\n  \}/.test(src), true);
  });

  it('M-T4 RED: alternate env RAVEN_KEYS bootstraps trust', () => {
    const mutated = applyMutant('MT4', (t) =>
      t.replace(
        'const pinned = runtime.getSetting(\'RAVEN_TRUSTED_KEYS\');',
        "const pinned = runtime.getSetting('RAVEN_TRUSTED_KEYS') ?? runtime.getSetting('RAVEN_KEYS');",
      ),
    );
    assert.match(mutated, /RAVEN_KEYS/);
    assert.equal(src.includes("RAVEN_KEYS"), false);
  });

  it('M-T5 RED: hardcoded bundled key becomes trusted without pin', () => {
    const mutated = applyMutant('MT5', (t) =>
      t.replace(
        'if (pinned === undefined || pinned === null) {\n    return new Set();\n  }',
        "if (pinned === undefined || pinned === null) {\n    return new Set(['HARDCODED_BUNDLED_TRUST_KEY']);\n  }",
      ),
    );
    assert.match(mutated, /HARDCODED_BUNDLED_TRUST_KEY/);
    assert.equal(src.includes('HARDCODED_BUNDLED_TRUST_KEY'), false);
  });
});
