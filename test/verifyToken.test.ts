// Tests for the VERIFY_TOKEN action with a mocked fetch and fixed settings.
//
// Uses node:test directly. Time is PINNED via an options hook (now) so tests
// are deterministic regardless of wall clock. Local verification is real:
// the plugin's vendored kernel runs against the golden vectors.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { verifyTokenAction, extractMint, loadTrustedKeys } from '../src/actions/verifyToken.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, '..', 'fixtures', 'receipt-v1');
const vector = (name: string) => JSON.parse(readFileSync(join(vectorsDir, `${name}.json`), 'utf8'));

const RUNTIME_SETTINGS = {
  RAVEN_API_KEY: 'test-key-not-a-real-secret',
  RAVEN_VERIFIER_URL: 'https://verifier.test',
};

const runtimeWith = (settings: Record<string, string>) =>
  ({
    getSetting: (k: string) => settings[k],
  }) as unknown as Parameters<typeof verifyTokenAction.validate>[0];

const msg = (text: string) => ({ content: { text } }) as Parameters<typeof verifyTokenAction.validate>[1];

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

// A fetchImpl that returns a queued receipt response for /receipt/v1 and the
// published key set for /pubkey.
const fetchWith = (receipt: unknown, opts: { keys?: string[] } = {}) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/pubkey')) {
      return jsonResponse(200, { keys: (opts.keys ?? []).map((k) => ({ publicKeyBase64: k })) });
    }
    return jsonResponse(200, receipt);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

const MINT = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';

describe('extractMint', () => {
  it('finds a mint in free text', () => {
    assert.equal(extractMint(`check ${MINT} please`), MINT);
  });
  it('prefers the longest base58 candidate', () => {
    const short = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'.slice(0, 32);
    assert.equal(extractMint(`${short} and ${MINT}`), MINT);
  });
  it('returns null without a candidate', () => {
    assert.equal(extractMint('nothing here'), null);
    assert.equal(extractMint(undefined), null);
  });
});

describe('VERIFY_TOKEN action', () => {
  it('validate() is false without an API key', async () => {
    const ok = await verifyTokenAction.validate(runtimeWith({}), msg(`check ${MINT}`));
    assert.equal(ok, false);
  });

  it('happy path: verifies locally against published keys and reports evidence', async () => {
    const v = vector('production-receipt-v1-bonk-verified');
    const { fetchImpl } = fetchWith(v.input, { keys: [v.input.signerPublicKey] });
    const runtime = runtimeWith(RUNTIME_SETTINGS);
    const texts: string[] = [];
    const result = await verifyTokenAction.handler(
      runtime,
      msg(`check ${v.input.mintAddress}`),
      undefined,
      { fetchImpl, now: v.now },
      async (c) => {
        texts.push(c.text as string);
        return [];
      },
    );
    assert.equal(result.success, true);
    const text = texts.join('\n');
    assert.ok(text.includes('verified locally against a trusted published key'));
    assert.ok(!text.includes('STALE'));
  });

  it('fails closed when the receipt is bound to a different mint', async () => {
    const v = vector('production-receipt-v1-bonk-verified');
    const { fetchImpl } = fetchWith(v.input, { keys: [v.input.signerPublicKey] });
    const runtime = runtimeWith(RUNTIME_SETTINGS);
    const result = await verifyTokenAction.handler(runtime, msg(`check ${MINT}`), undefined, {
      fetchImpl,
      now: v.now,
    });
    assert.equal(result.success, false);
    assert.match(result.text!, /bound to a different mint/);
    assert.match(result.text!, /fail-closed/);
  });

  it('fails closed when local verification fails (tampered signature)', async () => {
    const v = vector('tampered-signature');
    const { fetchImpl } = fetchWith(v.input);
    const runtime = runtimeWith(RUNTIME_SETTINGS);
    const result = await verifyTokenAction.handler(
      runtime,
      msg(`check ${v.input.mintAddress}`),
      undefined,
      { fetchImpl, now: v.now },
    );
    assert.equal(result.success, false);
    assert.match(result.text!, /FAILED local verification/);
  });

  it('fails closed when the receipt signer is not trusted', async () => {
    const v = vector('production-receipt-v1-bonk-verified');
    const { fetchImpl } = fetchWith(v.input, { keys: [] });
    const runtime = runtimeWith({
      ...RUNTIME_SETTINGS,
      RAVEN_VERIFIER_URL: 'https://untrusted-verifier.test',
    });
    const result = await verifyTokenAction.handler(
      runtime,
      msg(`check ${v.input.mintAddress}`),
      undefined,
      { fetchImpl, now: v.now },
    );
    assert.equal(result.success, false);
    assert.equal((result.data?.verification as { valid?: boolean }).valid, true);
    assert.equal((result.data?.verification as { keyTrusted?: boolean }).keyTrusted, false);
    assert.match(result.text!, /signer is not in the trusted key set/);
    assert.match(result.text!, /fail-closed/);
  });

  it('429 is transient and preserves the Retry-After hint', async () => {
    const fetchImpl = (async () =>
      jsonResponse(429, { error: 'rate_limited' }, { 'retry-after': '17' })) as unknown as typeof fetch;
    const runtime = runtimeWith(RUNTIME_SETTINGS);
    const result = await verifyTokenAction.handler(runtime, msg(`check ${MINT}`), undefined, {
      fetchImpl,
    });
    assert.equal(result.success, false);
    assert.match(result.text!, /retry later/);
    assert.match(result.text!, /17/);
  });

  it('receipts sent upstream contain ONLY mintAddress', async () => {
    const v = vector('production-receipt-v1-bonk-verified');
    const { fetchImpl, calls } = fetchWith(v.input, { keys: [v.input.signerPublicKey] });
    const runtime = runtimeWith(RUNTIME_SETTINGS);
    await verifyTokenAction.handler(runtime, msg(`check ${v.input.mintAddress}`), undefined, {
      fetchImpl,
      now: v.now,
    });
    const receiptCall = calls.find((c) => c.url.endsWith('/receipt/v1'))!;
    const body = JSON.parse(String(receiptCall.init?.body));
    assert.deepEqual(Object.keys(body).sort(), ['mintAddress']);
  });
});

// --- Group C regression: timeouts + URL-keyed pubkey cache -------------------

it('a hanging /receipt/v1 fetch fails fast (transient), never hangs forever', async () => {
  const hanging = (async (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error('should have been aborted')), 60_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      });
    })) as unknown as typeof fetch;
  const runtime = runtimeWith({ ...RUNTIME_SETTINGS, RAVEN_FETCH_TIMEOUT_MS: '50' });
  const started = Date.now();
  const result = await verifyTokenAction.handler(runtime, msg(`check ${MINT}`), undefined, {
    fetchImpl: hanging,
  });
  assert.ok(Date.now() - started < 10_000, 'must return promptly');
  assert.equal(result.success, false);
});

it('pubkey cache is keyed by verifier URL (no cross-host key reuse)', async () => {
  const calls: string[] = [];
  const keysFor = (host: string) =>
    (async (url: string) => {
      calls.push(url);
      return jsonResponse(200, { keys: [{ publicKeyBase64: `key-of-${host}` }] });
    }) as unknown as typeof fetch;

  const runtime = runtimeWith(RUNTIME_SETTINGS);
  const a1 = await loadTrustedKeys(runtime, 'https://host-a.example', keysFor('host-a'));
  const a2 = await loadTrustedKeys(runtime, 'https://host-a.example', keysFor('host-a')); // cached
  const b1 = await loadTrustedKeys(runtime, 'https://host-b.example', keysFor('host-b')); // must refetch

  assert.ok(a1.has('key-of-host-a'));
  assert.ok(a2.has('key-of-host-a'));
  assert.ok(b1.has('key-of-host-b'));
  assert.ok(!b1.has('key-of-host-a'), 'must not serve host-a keys for host-b');
  assert.equal(calls.filter((u) => u.includes('host-a')).length, 1, 'host-a fetched once (cached)');
  assert.equal(calls.filter((u) => u.includes('host-b')).length, 1, 'host-b fetched separately');
});

// --- Restored pre-existing coverage (dropped in the first push of this branch,
// --- restored verbatim-in-substance with this file's helper style) -----------

const FORBIDDEN = /\b(safe|unsafe|legit|scam-free|approved|guaranteed|rug-proof)\b/i;

it('stale receipt (wall-clock now) is reported STALE while still verifying', async () => {
  const v = vector('production-receipt-v1-bonk-verified');
  const { fetchImpl } = fetchWith(v.input);
  const runtime = runtimeWith({ ...RUNTIME_SETTINGS, RAVEN_TRUSTED_KEYS: v.trustedKeys.join(',') });
  const result = await verifyTokenAction.handler(runtime, msg(`check ${v.input.mintAddress}`), undefined, {
    // no `now` ⇒ wall clock; the June fixture is genuinely stale by now
    fetchImpl,
  });
  assert.equal(result.success, true); // authentic evidence — staleness is reported, not hidden
  assert.ok(result.text!.includes('STALE'), result.text);
  assert.ok(!FORBIDDEN.test(result.text!));
});

it('loadTrustedKeys: pinned env wins; /pubkey fallback parses the published key set', async () => {
  const pinned = await loadTrustedKeys(
    runtimeWith({ RAVEN_TRUSTED_KEYS: ' keyA , keyB ' }),
    'https://raven.example.test',
    (async () => new Response('should-not-be-called', { status: 500 })) as unknown as typeof fetch,
  );
  assert.deepEqual([...pinned].sort(), ['keyA', 'keyB']);

  const fetched = await loadTrustedKeys(
    runtimeWith({}),
    'https://raven.example.test',
    (async (url: string) => {
      assert.ok(url.endsWith('/pubkey'));
      return jsonResponse(200, { keys: [{ keyId: 'rvk_x', publicKeyBase64: 'PUBKEY_B64', alg: 'ed25519' }] });
    }) as unknown as typeof fetch,
  );
  assert.deepEqual([...fetched], ['PUBKEY_B64']);
});
