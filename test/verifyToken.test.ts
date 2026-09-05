// Tests for the VERIFY_TOKEN action with a mocked fetch and fixed settings.
//
// Uses node:test directly. Time is PINNED via an options hook (now) so tests
// are deterministic regardless of wall clock. Local verification is real:
// the plugin's vendored kernel runs against the golden vectors.
//
// Ancestry: based on PR #10 head; adds fail-closed bootstrap #10 deferred.
// RED: RAVEN_TRUSTED_KEYS absent + hostile /pubkey must NOT elevate trust.
// See docs/TRUST_BOOTSTRAP_RED.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

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

// A fetchImpl that returns a queued receipt response for /receipt/v1 and may
 // answer /pubkey (discovery must NEVER become the trusted set).
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

  it('happy path: verifies locally against pinned keys and reports evidence', async () => {
    const v = vector('production-receipt-v1-bonk-verified');
    const { fetchImpl, calls } = fetchWith(v.input, { keys: ['HOSTILE_SHOULD_NOT_MATTER'] });
    const runtime = runtimeWith({
      ...RUNTIME_SETTINGS,
      RAVEN_TRUSTED_KEYS: v.trustedKeys.join(','),
    });
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
    assert.ok(text.includes('verified locally against a pinned trusted key'));
    assert.ok(!text.includes('STALE'));
    assert.equal(calls.filter((c) => c.url.endsWith('/pubkey')).length, 0, 'must not fetch /pubkey for trust');
  });

  it('fails closed when the receipt is bound to a different mint', async () => {
    const v = vector('production-receipt-v1-bonk-verified');
    const { fetchImpl } = fetchWith(v.input);
    const runtime = runtimeWith({
      ...RUNTIME_SETTINGS,
      RAVEN_TRUSTED_KEYS: v.trustedKeys.join(','),
    });
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
    const runtime = runtimeWith({
      ...RUNTIME_SETTINGS,
      RAVEN_TRUSTED_KEYS: (v.trustedKeys ?? []).join(','),
    });
    const result = await verifyTokenAction.handler(
      runtime,
      msg(`check ${v.input.mintAddress}`),
      undefined,
      { fetchImpl, now: v.now },
    );
    assert.equal(result.success, false);
    assert.match(result.text!, /FAILED local verification/);
  });

  it('fails closed when the receipt signer is not trusted (CASE D)', async () => {
    const v = vector('production-receipt-v1-bonk-verified');
    const { fetchImpl } = fetchWith(v.input, { keys: [v.input.signerPublicKey] });
    const runtime = runtimeWith({
      ...RUNTIME_SETTINGS,
      RAVEN_TRUSTED_KEYS: 'NOT_THE_SIGNER_PIN',
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
    const { fetchImpl, calls } = fetchWith(v.input);
    const runtime = runtimeWith({
      ...RUNTIME_SETTINGS,
      RAVEN_TRUSTED_KEYS: v.trustedKeys.join(','),
    });
    await verifyTokenAction.handler(runtime, msg(`check ${v.input.mintAddress}`), undefined, {
      fetchImpl,
      now: v.now,
    });
    const receiptCall = calls.find((c) => c.url.endsWith('/receipt/v1'))!;
    const body = JSON.parse(String(receiptCall.init?.body));
    assert.deepEqual(Object.keys(body).sort(), ['mintAddress']);
  });
});

// --- Group C regression: timeouts (pubkey cache removed with trust bootstrap) ---

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

it('loadTrustedKeys: pinned env wins; absent pin does NOT bootstrap from /pubkey (CASE A/B)', async () => {
  let pubkeyCalls = 0;
  const hostileFetch = (async (url: string) => {
    if (String(url).endsWith('/pubkey')) {
      pubkeyCalls += 1;
      return jsonResponse(200, { keys: [{ publicKeyBase64: 'HOSTILE_PUBKEY' }] });
    }
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;

  const pinned = await loadTrustedKeys(
    runtimeWith({ RAVEN_TRUSTED_KEYS: ' keyA , keyB ' }),
    'https://raven.example.test',
    hostileFetch,
  );
  assert.deepEqual([...pinned].sort(), ['keyA', 'keyB']);
  assert.equal(pubkeyCalls, 0, 'pinned path must not call /pubkey');

  const unpinned = await loadTrustedKeys(runtimeWith({}), 'https://raven.example.test', hostileFetch);
  assert.deepEqual([...unpinned], []);
  assert.equal(pubkeyCalls, 0, 'unpinned path must not call /pubkey for trust');
});

it('loadTrustedKeys: malformed pin config fails closed (CASE C)', async () => {
  const emptyPins = await loadTrustedKeys(
    runtimeWith({ RAVEN_TRUSTED_KEYS: ' , , ' }),
    'https://raven.example.test',
  );
  assert.deepEqual([...emptyPins], []);

  const whitespace = await loadTrustedKeys(
    runtimeWith({ RAVEN_TRUSTED_KEYS: '   ' }),
    'https://raven.example.test',
  );
  assert.deepEqual([...whitespace], []);

  const nonStringRuntime = {
    getSetting: () => ({ not: 'a-string' }),
  } as unknown as Parameters<typeof verifyTokenAction.validate>[0];
  const badType = await loadTrustedKeys(nonStringRuntime, 'https://raven.example.test');
  assert.deepEqual([...badType], []);
});

/**
 * RED / hostile trust-bootstrap (frozen evidence — docs/TRUST_BOOTSTRAP_RED.md):
 * Pre-fix (#10 head and 0.3.1): absent RAVEN_TRUSTED_KEYS + hostile /pubkey
 * returning attacker pubkey + attacker-signed receipt ⇒ action succeeded with
 * keyTrusted true (trust bootstrap via discovery).
 * Post-fix: must fail closed; /pubkey must not elevate trust.
 */
it('RED hostile: no pin + hostile /pubkey + attacker receipt must fail closed (CASE B/F)', async () => {
  const v = vector('production-receipt-v1-bonk-verified');
  const pair = generateKeyPairSync('ed25519');
  const attackerPub = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const signedBytes = JSON.stringify({
    domain: 'raven-receipt',
    payloadHash: v.input.payloadHash,
    version: 'v1',
  });
  const receipt = {
    ...v.input,
    signerPublicKey: attackerPub,
    signature: cryptoSign(null, Buffer.from(signedBytes, 'utf8'), pair.privateKey).toString('base64'),
  };
  const { fetchImpl, calls } = fetchWith(receipt, { keys: [attackerPub] });
  // CASE B: RAVEN_TRUSTED_KEYS absent — must NOT trust /pubkey.
  const runtime = runtimeWith(RUNTIME_SETTINGS);
  const result = await verifyTokenAction.handler(
    runtime,
    msg(`check ${receipt.mintAddress}`),
    undefined,
    { fetchImpl, now: v.now },
  );
  assert.equal(result.success, false, 'hostile discovery must not succeed as trusted verification');
  const verification = result.data?.verification as { valid?: boolean; keyTrusted?: boolean };
  // Signature may be cryptographically valid; trust must not elevate from /pubkey.
  assert.notEqual(verification?.keyTrusted, true);
  assert.match(result.text!, /trusted key set|fail-closed/i);
  assert.equal(
    calls.filter((c) => c.url.endsWith('/pubkey')).length,
    0,
    'action must not fetch /pubkey to populate trust',
  );
});

it('CASE F: pinned path ignores /pubkey unavailable; unpinned fails closed without /pubkey', async () => {
  const v = vector('production-receipt-v1-bonk-verified');
  const fetchNoPubkey = (async (url: string) => {
    if (String(url).endsWith('/pubkey')) {
      return jsonResponse(503, { error: 'down' });
    }
    return jsonResponse(200, v.input);
  }) as unknown as typeof fetch;

  const pinnedOk = await verifyTokenAction.handler(
    runtimeWith({ ...RUNTIME_SETTINGS, RAVEN_TRUSTED_KEYS: v.trustedKeys.join(',') }),
    msg(`check ${v.input.mintAddress}`),
    undefined,
    { fetchImpl: fetchNoPubkey, now: v.now },
  );
  assert.equal(pinnedOk.success, true);

  const unpinnedFail = await verifyTokenAction.handler(
    runtimeWith(RUNTIME_SETTINGS),
    msg(`check ${v.input.mintAddress}`),
    undefined,
    { fetchImpl: fetchNoPubkey, now: v.now },
  );
  assert.equal(unpinnedFail.success, false);
  assert.notEqual(
    (unpinnedFail.data?.verification as { keyTrusted?: boolean })?.keyTrusted,
    true,
  );
});
