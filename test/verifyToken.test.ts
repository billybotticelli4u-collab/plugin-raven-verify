import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractMint, loadTrustedKeys, verifyTokenAction } from '../src/actions/verifyToken.ts';
import type { IAgentRuntime, Memory } from '@elizaos/core';

const vector = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL('../fixtures/receipt-v1/production-receipt-v1-bonk-verified.json', import.meta.url)),
    'utf8',
  ),
) as { input: Record<string, unknown>; now: string; trustedKeys: string[] };
const MINT = vector.input.mintAddress as string;
const FORBIDDEN = /\b(safe|unsafe|legit|scam-free|approved|guaranteed)\b/i;

// --- extractMint (unchanged behavior) ---------------------------------------

test('extractMint pulls a mint out of prose', () => {
  const mint = 'So11111111111111111111111111111111111111112';
  assert.equal(extractMint(`please get a raven receipt for ${mint} before you touch it`), mint);
});

test('extractMint returns the longest base58 token when several appear', () => {
  const short = 'A'.repeat(32);
  const long = 'B'.repeat(44);
  assert.equal(extractMint(`maybe ${short} but really use ${long}`), long);
});

test('extractMint ignores prose with no mint and handles empty input', () => {
  assert.equal(extractMint('hey can you check this token for me please'), null);
  assert.equal(extractMint(''), null);
  assert.equal(extractMint(null), null);
  assert.equal(extractMint(undefined), null);
});

// --- action -----------------------------------------------------------------

const runtimeWith = (settings: Record<string, string | undefined>): IAgentRuntime =>
  ({ getSetting: (k: string) => settings[k] }) as unknown as IAgentRuntime;

const msg = (text: string): Memory => ({ content: { text } }) as unknown as Memory;

const SETTINGS: Record<string, string | undefined> = {
  RAVEN_API_KEY: 'test-key-not-a-real-secret',
  RAVEN_VERIFIER_URL: 'https://raven.example.test',
};

const fakeFetch =
  (handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  (async (url: unknown, init?: unknown) => handler(String(url), init as RequestInit)) as typeof fetch;

test('validate: false without RAVEN_API_KEY; true with key and mint present', async () => {
  assert.equal(await verifyTokenAction.validate(runtimeWith({}), msg(`check ${MINT}`)), false);
  const runtime = runtimeWith({ ...SETTINGS });
  assert.equal(await verifyTokenAction.validate(runtime, msg(`check ${MINT}`)), true);
  assert.equal(await verifyTokenAction.validate(runtime, msg('check this token')), false);
});

test('happy path: fetches /receipt/v1, verifies LOCALLY with pinned keys, reports facts + NOT-checked', async () => {
  const runtime = runtimeWith({ ...SETTINGS, RAVEN_TRUSTED_KEYS: vector.trustedKeys.join(',') });
  const calls: string[] = [];
  const responses: Array<{ text: string }> = [];
  const result = await verifyTokenAction.handler(
    runtime,
    msg(`get a receipt for ${MINT}`),
    undefined,
    {
      now: vector.now, // pinned so the fixture is fresh; live use = wall clock
      fetchImpl: fakeFetch((url) => {
        calls.push(url);
        return new Response(JSON.stringify(vector.input), { status: 200 });
      }),
    },
    async (r) => {
      responses.push(r as { text: string });
      return [];
    },
  );
  assert.equal((result as { success: boolean }).success, true);
  assert.deepEqual(calls, ['https://raven.example.test/receipt/v1']); // pinned keys ⇒ no /pubkey call
  const text = responses[0].text;
  assert.ok(text.includes('verified locally against a trusted published key'), text);
  assert.ok(text.includes('NOT checked'), 'not-checked list must be reported');
  assert.ok(text.includes('venue.infrastructure_tier_immutable'));
  assert.ok(!text.includes('STALE'));
  assert.ok(!FORBIDDEN.test(text), `forbidden verdict word: ${text}`);
});

test('tampered receipt from transport FAILS local verification: fail-closed, never reported as evidence', async () => {
  const runtime = runtimeWith({ ...SETTINGS, RAVEN_TRUSTED_KEYS: vector.trustedKeys.join(',') });
  const tampered = { ...vector.input, findings: [] }; // strip the finding after signing
  const result = await verifyTokenAction.handler(
    runtime,
    msg(`check ${MINT}`),
    undefined,
    { now: vector.now, fetchImpl: fakeFetch(() => new Response(JSON.stringify(tampered), { status: 200 })) },
  );
  const r = result as { success: boolean; text: string };
  assert.equal(r.success, false);
  assert.ok(r.text.includes('FAILED local verification'), r.text);
  assert.ok(r.text.includes('payload_hash_mismatch'), r.text);
});

test('receipt/request binding: a VALID signed receipt for a different mint is rejected fail-closed', async () => {
  // The signature proves authenticity, not relevance. Serve the genuine,
  // correctly-signed BONK receipt against a request for a DIFFERENT mint —
  // it must never be presented as evidence for the requested token.
  const otherMint = 'So11111111111111111111111111111111111111112';
  assert.notEqual(otherMint, MINT);
  const runtime = runtimeWith({ ...SETTINGS, RAVEN_TRUSTED_KEYS: vector.trustedKeys.join(',') });
  const responses: Array<{ text: string }> = [];
  const result = await verifyTokenAction.handler(
    runtime,
    msg(`check ${otherMint}`),
    undefined,
    {
      now: vector.now,
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(vector.input), { status: 200 })),
    },
    async (r) => {
      responses.push(r as { text: string });
      return [];
    },
  );
  const r = result as { success: boolean; text: string; data?: { receiptMintAddress?: string } };
  assert.equal(r.success, false);
  assert.ok(r.text.includes('bound to a different mint'), r.text);
  assert.ok(r.text.includes('fail-closed'), r.text);
  assert.equal(r.data?.receiptMintAddress, MINT);
  // The requested mint's "receipt" must never appear as a success line.
  for (const resp of responses) {
    assert.ok(!resp.text.startsWith(`Raven receipt — ${otherMint}`), resp.text);
  }
  assert.ok(!FORBIDDEN.test(r.text));
});

test('429 is transient: retry-later text with the suggested wait, no evidence claimed', async () => {
  const runtime = runtimeWith({ ...SETTINGS });
  const result = await verifyTokenAction.handler(runtime, msg(`check ${MINT}`), undefined, {
    fetchImpl: fakeFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'rate_limited' } }), {
          status: 429,
          headers: { 'retry-after': '7' },
        }),
    ),
  });
  const r = result as { success: boolean; text: string; data?: { transient?: boolean } };
  assert.equal(r.success, false);
  assert.ok(r.text.includes('retry later'), r.text);
  assert.ok(r.text.includes('~7s'), r.text);
  assert.equal(r.data?.transient, true);
});

test('stale receipt (wall-clock now) is reported STALE while still verifying', async () => {
  const runtime = runtimeWith({ ...SETTINGS, RAVEN_TRUSTED_KEYS: vector.trustedKeys.join(',') });
  const result = await verifyTokenAction.handler(runtime, msg(`check ${MINT}`), undefined, {
    // no `now` ⇒ wall clock; the June fixture is genuinely stale by now
    fetchImpl: fakeFetch(() => new Response(JSON.stringify(vector.input), { status: 200 })),
  });
  const r = result as { success: boolean; text: string };
  assert.equal(r.success, true); // authentic evidence — staleness is reported, not hidden
  assert.ok(r.text.includes('STALE'), r.text);
  assert.ok(!FORBIDDEN.test(r.text));
});

test('loadTrustedKeys: pinned env wins; /pubkey fallback parses the published key set', async () => {
  const pinned = await loadTrustedKeys(
    runtimeWith({ RAVEN_TRUSTED_KEYS: ' keyA , keyB ' }),
    'https://raven.example.test',
    fakeFetch(() => new Response('should-not-be-called', { status: 500 })),
  );
  assert.deepEqual([...pinned].sort(), ['keyA', 'keyB']);

  const fetched = await loadTrustedKeys(
    runtimeWith({}),
    'https://raven.example.test',
    fakeFetch((url) => {
      assert.ok(url.endsWith('/pubkey'));
      return new Response(
        JSON.stringify({ keys: [{ keyId: 'rvk_x', publicKeyBase64: 'PUBKEY_B64', alg: 'ed25519' }] }),
        { status: 200 },
      );
    }),
  );
  assert.deepEqual([...fetched], ['PUBKEY_B64']);
});
