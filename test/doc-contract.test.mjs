// WS4 — permanent README/docs contract test.
// Forbidden: implying /pubkey or published keys bootstrap trust; "trusted published keys".
// Allowed: caller-supplied / caller-pinned / independently obtained trusted keys.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const DOC_FILES = [
  'README.md',
  'RELEASING.md',
  'docs/TRUST_BOOTSTRAP_RED.md',
  'docs/TRUST_SOURCE_CONTRACT.md',
  'src/index.ts',
  'src/actions/verifyToken.ts',
];

const FORBIDDEN = [
  /trusted published keys/i,
  /Unset\s*⇒\s*the published\s*`?\/pubkey`?/i,
  /\/pubkey[^\n.]{0,80}(fetched and trusted|trusted set is fetched|bootstrap(?:s|ed)? trust)/i,
  /default[^\n.]{0,40}\/pubkey[^\n.]{0,40}trust/i,
  /no-pin\s*→\s*\/pubkey/i,
];

const REQUIRED_README = [
  /caller-(?:pinned|supplied)|independently obtained/i,
  /RAVEN_TRUSTED_KEYS/,
  /must not.*bootstrap trust|fail closed/i,
  /valid\s*!=\s*keyTrusted|valid and keyTrusted|valid != keyTrusted/i,
];

function readDocs() {
  const out = {};
  for (const rel of DOC_FILES) {
    const p = join(repoRoot, rel);
    try {
      out[rel] = readFileSync(p, 'utf8');
    } catch {
      out[rel] = null;
    }
  }
  return out;
}

describe('documentation contract', () => {
  it('README uses caller-supplied/pinned trusted keys wording', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    assert.doesNotMatch(readme, /trusted published keys/i);
    for (const re of REQUIRED_README) {
      assert.match(readme, re, 'README missing required concept: ' + re);
    }
  });

  it('plugin description strings avoid trusted published keys', () => {
    const index = readFileSync(join(repoRoot, 'src/index.ts'), 'utf8');
    const action = readFileSync(join(repoRoot, 'src/actions/verifyToken.ts'), 'utf8');
    assert.doesNotMatch(index, /trusted published keys/i);
    assert.doesNotMatch(action, /trusted published keys/i);
    assert.match(index + '\n' + action, /caller-(?:pinned|supplied)|independently obtained|pinned trusted key/i);
  });

  it('all tracked docs forbid dangerous bootstrap wording', () => {
    const docs = readDocs();
    for (const [rel, text] of Object.entries(docs)) {
      if (text == null) {
        if (rel === 'docs/TRUST_SOURCE_CONTRACT.md') {
          assert.fail('missing ' + rel);
        }
        continue;
      }
      // Historical disclosure of OLD vulnerable default is allowed only when
      // clearly marked as prior/0.3.1 behavior.
      for (const re of FORBIDDEN) {
        const matches = text.match(new RegExp(re.source, re.flags + (re.flags.includes('g') ? '' : 'g')));
        if (!matches) continue;
        for (const m of matches) {
          const idx = text.indexOf(m);
          const window = text.slice(Math.max(0, idx - 80), idx + m.length + 80);
          const historical =
            /0\.3\.1|0\.3\.2|BREAKING|no longer|must not|discovery\/cross-check|pre-fix|prior default|was no-pin|OLD|vulnerable|before the fix/i.test(window);
          assert.ok(
            historical,
            `${rel} contains forbidden wording without historical marker: ${m}`,
          );
        }
      }
    }
  });

  it('mutation inserting dangerous wording is detectable (RED)', () => {
    const readmePath = join(repoRoot, 'README.md');
    const orig = readFileSync(readmePath, 'utf8');
    const mutant =
      orig.replace(
        /Unset\/empty ⇒ empty trusted set[\s\S]*?bootstrap trust\./,
        'Unset ⇒ the published `/pubkey` key set is fetched and trusted.',
      ) + '\n';
    assert.notEqual(mutant, orig);
    assert.match(mutant, /Unset ⇒ the published `\/pubkey` key set is fetched and trusted/);
    // Contract test kill condition: forbidden pattern present without historical marker
    const re = /Unset\s*⇒\s*the published\s*`?\/pubkey`?/i;
    assert.match(mutant, re);
    // Ensure current tree stays clean for this exact restoration phrase
    assert.doesNotMatch(orig, /Unset ⇒ the published `\/pubkey` key set is fetched and trusted/);
  });
});
