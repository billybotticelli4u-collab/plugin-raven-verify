// Compiled-boundary regressions. These import dist/index.js, not TypeScript
// source, so a release cannot pass solely because the source tests are green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { verifyTokenAction } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, '..', 'fixtures', 'receipt-v1', 'production-receipt-v1-bonk-verified.json'), 'utf8'),
);
const runtimeWith = (settings) => ({ getSetting: (key) => settings[key] });
const messageFor = (mint) => ({ content: { text: `check ${mint}` } });
const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fetchWith = (receipt, keys) =>
  async (url) =>
    url.endsWith('/pubkey')
      ? jsonResponse(200, { keys: keys.map((publicKeyBase64) => ({ publicKeyBase64 })) })
      : jsonResponse(200, receipt);

const settings = {
  RAVEN_API_KEY: 'compiled-boundary-test-key',
  RAVEN_VERIFIER_URL: 'https://compiled-boundary.test',
  RAVEN_TRUSTED_KEYS: fixture.trustedKeys.join(','),
};

test('compiled action succeeds for the production Ed25519 receipt and pinned key', async () => {
  const result = await verifyTokenAction.handler(
    runtimeWith(settings),
    messageFor(fixture.input.mintAddress),
    undefined,
    { fetchImpl: fetchWith(fixture.input, ['HOSTILE_IGNORED']), now: fixture.now },
  );
  assert.equal(result.success, true);
  assert.equal(result.data.verification.keyTrusted, true);
});

test('compiled action fails closed when the signer is not trusted', async () => {
  const result = await verifyTokenAction.handler(
    runtimeWith({
      ...settings,
      RAVEN_VERIFIER_URL: 'https://compiled-untrusted.test',
      RAVEN_TRUSTED_KEYS: 'NOT_THE_SIGNER',
    }),
    messageFor(fixture.input.mintAddress),
    undefined,
    { fetchImpl: fetchWith(fixture.input, [fixture.input.signerPublicKey]), now: fixture.now },
  );
  assert.equal(result.success, false);
  assert.equal(result.data.verification.valid, true);
  assert.equal(result.data.verification.keyTrusted, false);
  assert.match(result.text, /trusted key set/);
});

test('compiled action fails closed when no pin even if /pubkey returns signer', async () => {
  const result = await verifyTokenAction.handler(
    runtimeWith({
      RAVEN_API_KEY: settings.RAVEN_API_KEY,
      RAVEN_VERIFIER_URL: 'https://compiled-nopin.test',
      // RAVEN_TRUSTED_KEYS intentionally absent
    }),
    messageFor(fixture.input.mintAddress),
    undefined,
    { fetchImpl: fetchWith(fixture.input, [fixture.input.signerPublicKey]), now: fixture.now },
  );
  assert.equal(result.success, false);
  assert.notEqual(result.data.verification.keyTrusted, true);
  assert.match(result.text, /trusted key set/);
});

for (const attackerKeyType of ['ed25519', 'ec', 'rsa']) {
  test(`compiled action handles an attacker ${attackerKeyType.toUpperCase()} signer by protocol`, async () => {
    const pair = attackerKeyType === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : attackerKeyType === 'ec'
        ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signerPublicKey = pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
    const signedBytes = JSON.stringify({
      domain: 'raven-receipt',
      payloadHash: fixture.input.payloadHash,
      version: 'v1',
    });
    const receipt = {
      ...fixture.input,
      signerPublicKey,
      signature: cryptoSign(null, Buffer.from(signedBytes, 'utf8'), pair.privateKey).toString('base64'),
    };
    // Pin the attacker key to isolate protocol (Ed25519-only) from trust bootstrap.
    const result = await verifyTokenAction.handler(
      runtimeWith({
        ...settings,
        RAVEN_VERIFIER_URL: `https://compiled-${attackerKeyType}.test`,
        RAVEN_TRUSTED_KEYS: signerPublicKey,
      }),
      messageFor(receipt.mintAddress),
      undefined,
      { fetchImpl: fetchWith(receipt, []), now: fixture.now },
    );
    const expectedSuccess = attackerKeyType === 'ed25519';
    assert.equal(result.success, expectedSuccess);
    assert.equal(result.data.verification.valid, expectedSuccess);
    if (!expectedSuccess) assert.match(result.text, /FAILED local verification/);
  });
}
