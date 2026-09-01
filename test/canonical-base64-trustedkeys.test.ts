// Bounded kernel tests: canonical RFC 4648 Base64 (F4) and total trustedKeys
// (8b0068bd). Complements vectors.test.ts; must stay green on the production
// BONK fixture so the decoder change is non-vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { verifyReceiptV1 } from '../src/verify/verifyReceiptV1.ts';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/receipt-v1/', import.meta.url));
const readVector = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(FIXTURE_DIR + name + '.json', 'utf8')) as Record<string, unknown>;

const toBase64UrlKeepPadding = (standard: string): string =>
  standard.replaceAll('+', '-').replaceAll('/', '_');

test('Base64URL of production signature is signature_invalid and does not throw', () => {
  const v = readVector('production-receipt-v1-bonk-verified');
  const input = { ...(v.input as Record<string, unknown>) };
  const original = input.signature as string;
  input.signature = toBase64UrlKeepPadding(original);
  assert.notEqual(input.signature, original, 'fixture signature must use the standard Base64 alphabet');
  assert.ok(
    (input.signature as string).includes('-') || (input.signature as string).includes('_'),
    'Base64URL spelling must differ in alphabet',
  );

  let threw = false;
  let r: ReturnType<typeof verifyReceiptV1> | undefined;
  try {
    r = verifyReceiptV1(input, { now: v.now as string });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'malformed alphabet must not throw');
  assert.equal(r!.valid, false);
  assert.ok(r!.reasons.includes('signature_invalid'), JSON.stringify(r!.reasons));
});

test('trustedKeys as array of signerPublicKey: no throw, keyTrusted true', () => {
  const v = readVector('production-receipt-v1-bonk-verified');
  const input = v.input as Record<string, unknown>;
  const signerPublicKey = input.signerPublicKey as string;

  let threw = false;
  let r: ReturnType<typeof verifyReceiptV1> | undefined;
  try {
    r = verifyReceiptV1(input, { now: v.now as string, trustedKeys: [signerPublicKey] });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'array trustedKeys must not throw');
  assert.equal(r!.keyTrusted, true);
  assert.equal(r!.valid, true, JSON.stringify(r!.reasons));
});

test('trustedKeys as {has:()=>true} duck: no throw, keyTrusted false, trust_config_invalid', () => {
  const v = readVector('production-receipt-v1-bonk-verified');

  let threw = false;
  let r: ReturnType<typeof verifyReceiptV1> | undefined;
  try {
    r = verifyReceiptV1(v.input, {
      now: v.now as string,
      // Duck-typed trust oracle: any object with .has()=>true. Kernel must not
      // treat it as a Set; JSON/env callers hold arrays or Sets, not oracles.
      trustedKeys: { has: () => true } as unknown as readonly string[],
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'duck trustedKeys must not throw');
  assert.equal(r!.keyTrusted, false);
  assert.ok(r!.reasons.includes('trust_config_invalid'), JSON.stringify(r!.reasons));
  assert.equal(r!.valid, true, 'trust must not fold into valid');
});

test('unmodified production fixture still valid true (non-vacuous)', () => {
  const v = readVector('production-receipt-v1-bonk-verified');
  const r = verifyReceiptV1(v.input, {
    now: v.now as string,
    trustedKeys: new Set(v.trustedKeys as string[]),
  });
  assert.equal(r.valid, true, JSON.stringify(r.reasons));
  assert.equal(r.keyTrusted, true);
  assert.equal(r.stale, false);
});
