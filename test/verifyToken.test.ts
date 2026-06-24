import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractMint, resolveTokenProgram } from '../src/actions/verifyToken.ts';

// --- extractMint -----------------------------------------------------------

test('extractMint pulls a mint out of prose', () => {
  const mint = 'So11111111111111111111111111111111111111112';
  const text = `please get a raven receipt for ${mint} before you touch it`;
  assert.equal(extractMint(text), mint);
});

test('extractMint returns the longest base58 token when several appear', () => {
  const short = 'A'.repeat(32); // valid 32-char base58 run
  const long = 'B'.repeat(44); // valid 44-char base58 run
  const text = `maybe ${short} but really use ${long} for the receipt`;
  assert.equal(extractMint(text), long);
});

test('extractMint ignores ordinary prose with no mint', () => {
  assert.equal(extractMint('hey can you check this token for me please'), null);
});

test('extractMint handles empty / null / undefined', () => {
  assert.equal(extractMint(''), null);
  assert.equal(extractMint(null), null);
  assert.equal(extractMint(undefined), null);
});

test('extractMint rejects runs that are too short to be a mint', () => {
  // 31 chars — one below the 32-char minimum.
  assert.equal(extractMint(`x ${'A'.repeat(31)} y`), null);
});

// --- resolveTokenProgram ---------------------------------------------------

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Build a fake fetch returning a given JSON body, typed to satisfy `typeof fetch`. */
function fakeFetch(body: unknown): typeof fetch {
  return (async () => ({ json: async () => body })) as unknown as typeof fetch;
}

test('resolveTokenProgram returns the owning program from getAccountInfo', async () => {
  const fetchImpl = fakeFetch({
    jsonrpc: '2.0',
    id: 1,
    result: { value: { owner: SPL_TOKEN_PROGRAM, data: ['', 'base64'] } },
  });
  const owner = await resolveTokenProgram('http://rpc.test', 'MintAddr', fetchImpl);
  assert.equal(owner, SPL_TOKEN_PROGRAM);
});

test('resolveTokenProgram returns null when the mint is not found (value: null)', async () => {
  const fetchImpl = fakeFetch({ jsonrpc: '2.0', id: 1, result: { value: null } });
  const owner = await resolveTokenProgram('http://rpc.test', 'MintAddr', fetchImpl);
  assert.equal(owner, null);
});

test('resolveTokenProgram returns null when the owner is missing', async () => {
  const fetchImpl = fakeFetch({ result: { value: {} } });
  const owner = await resolveTokenProgram('http://rpc.test', 'MintAddr', fetchImpl);
  assert.equal(owner, null);
});

test('resolveTokenProgram returns null on fetch failure (no network leak)', async () => {
  const throwingFetch = (async () => {
    throw new Error('network disabled in tests');
  }) as unknown as typeof fetch;
  const owner = await resolveTokenProgram('http://rpc.test', 'MintAddr', throwingFetch);
  assert.equal(owner, null);
});
