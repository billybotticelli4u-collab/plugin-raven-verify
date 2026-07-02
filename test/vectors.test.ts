// Conformance tests for the vendored receipt-v1 verifier kernel.
//
// This is an independent vendored copy of the open verifier, validated against
// the SAME golden vectors as every other implementation — conformance is
// defined by the vectors, not by shared code (Raven standard: independent
// verifiers agreeing byte-for-byte on shared vectors is the trust mechanism).
// Includes the real production-signed BONK receipt. All tests run OFFLINE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { verifyReceiptV1 } from '../src/verify/verifyReceiptV1.ts';
import { canonicalJson } from '../src/verify/canonicalJson.ts';
import { RECEIPT_DISCLAIMER } from '../src/verify/receiptV1.ts';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/receipt-v1/', import.meta.url));
const readVector = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(FIXTURE_DIR + name + '.json', 'utf8')) as Record<string, unknown>;

const SINGLE_INPUT_VECTORS = [
  'valid-minimal',
  'valid-with-findings',
  'valid-stale',
  'tampered-finding',
  'tampered-disclaimer',
  'forbidden-word',
  'wrong-domain',
  'wrong-key',
  'unparseable-timestamp',
];

test('all vendored fixture files are present', () => {
  const required = [...SINGLE_INPUT_VECTORS, 'canonical-ordering', 'production-receipt-v1-bonk-verified'];
  for (const name of required) {
    assert.ok(fs.existsSync(FIXTURE_DIR + name + '.json'), `missing fixture: ${name}.json`);
  }
});

for (const name of SINGLE_INPUT_VECTORS) {
  test(`vector ${name} verifies as expected`, () => {
    const v = readVector(name);
    const expected = v.expected as Record<string, unknown>;
    const trustedKeys = Array.isArray(v.trustedKeys) ? new Set(v.trustedKeys as string[]) : undefined;
    const r = verifyReceiptV1(v.input, { now: v.now as string, trustedKeys });
    assert.equal(r.valid, expected.valid, `valid for ${name}: ${JSON.stringify(r.reasons)}`);
    assert.equal(r.stale, expected.stale, `stale for ${name}`);
    if ('keyTrusted' in expected) assert.equal(r.keyTrusted, expected.keyTrusted);
    if (Array.isArray(expected.reasonsInclude)) {
      for (const reason of expected.reasonsInclude as string[]) {
        assert.ok(r.reasons.includes(reason), `${name} needs reason ${reason}: got ${JSON.stringify(r.reasons)}`);
      }
    }
  });
}

test('vector canonical-ordering: byte-different inputs share one payloadHash and both verify', () => {
  const v = readVector('canonical-ordering');
  const a = v.inputA as Record<string, unknown>;
  const b = v.inputB as Record<string, unknown>;
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(a.payloadHash, b.payloadHash);
  assert.equal(verifyReceiptV1(a, { now: v.now as string }).valid, true);
  assert.equal(verifyReceiptV1(b, { now: v.now as string }).valid, true);
});

test('production BONK vector verifies valid + trusted, and payloadHash recomputes', () => {
  const v = readVector('production-receipt-v1-bonk-verified');
  const trustedKeys = new Set(v.trustedKeys as string[]);
  const r = verifyReceiptV1(v.input, { now: v.now as string, trustedKeys });
  assert.equal(r.valid, true, JSON.stringify(r.reasons));
  assert.equal(r.keyTrusted, true);
  const input = v.input as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const k of [
    'chain', 'mintAddress', 'tokenProgramAddress', 'slot', 'timestamp',
    'rulesVersion', 'findingTaxonomyVersion', 'scopeChecksPerformed',
    'scopeChecksNotPerformed', 'coverageGaps', 'findings', 'interpretations',
    'maxAgeSeconds', 'disclaimer',
  ]) body[k] = input[k];
  const recomputed = 'sha256:' + createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
  assert.equal(recomputed, input.payloadHash);
});

test('disclaimer is byte-exact: a one-character change fails verification', () => {
  const v = readVector('valid-minimal');
  const tampered = { ...(v.input as Record<string, unknown>), disclaimer: RECEIPT_DISCLAIMER.slice(0, -1) + '!' };
  const r = verifyReceiptV1(tampered, { now: v.now as string });
  assert.equal(r.valid, false);
  assert.ok(r.reasons.includes('disclaimer_mismatch'));
});

test('hostile deep nesting is contained: an outcome, never an exception', () => {
  let evidence: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 200_000; i++) evidence = { deeper: evidence };
  const v = readVector('valid-minimal');
  const input = {
    ...(v.input as Record<string, unknown>),
    findings: [{ code: 'venue.infrastructure_tier_immutable', source: 'hostile', evidence }],
  };
  const r = verifyReceiptV1(input, { now: v.now as string });
  assert.equal(r.valid, false);
  assert.ok(r.reasons.includes('canonicalization_failed') || r.reasons.includes('payload_hash_mismatch'));
});

test('verify kernel imports no HTTP/network client (verification is local, forever)', () => {
  const srcDir = fileURLToPath(new URL('../src/verify/', import.meta.url));
  const forbidden = ['node:http', 'node:https', 'node:net', 'node:dgram', 'fetch(', 'undici', 'axios'];
  for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(srcDir + file, 'utf8');
    for (const needle of forbidden) {
      assert.ok(!src.includes(needle), `${file} must not reference ${needle}`);
    }
  }
});
