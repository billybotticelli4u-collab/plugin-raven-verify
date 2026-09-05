// WS1 — permanent pack → install → bare-import CI gate.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const fixturePath = join(repoRoot, 'fixtures', 'receipt-v1', 'production-receipt-v1-bonk-verified.json');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout ?? 180_000,
  });
  if (r.error) throw r.error;
  return r;
}
function mustOk(r, label) {
  if ((r.status ?? 1) !== 0) {
    throw new Error(label + ' failed (' + r.status + '):\n' + r.stdout + '\n' + r.stderr);
  }
  return r;
}
const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchWith = (receipt, keys = []) => async (url) =>
  String(url).endsWith('/pubkey')
    ? jsonResponse(200, { keys: keys.map((publicKeyBase64) => ({ publicKeyBase64 })) })
    : jsonResponse(200, receipt);

let workDir, tarballPath, consumerDir, pkg, fixture, verifyTokenAction;

before(async () => {
  fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  workDir = mkdtempSync(join(tmpdir(), 'raven-pkg-boundary-'));
  mustOk(run(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '--noEmit']), 'typecheck');
  mustOk(run(process.execPath, [join(repoRoot, 'node_modules/tsup/dist/cli-default.js')]), 'build');
  const pack = mustOk(run('npm', ['pack', '--json'], { cwd: repoRoot }), 'npm pack');
  const packJson = JSON.parse(pack.stdout);
  const packInfo = Array.isArray(packJson) ? packJson[0] : packJson;
  assert.equal(packInfo.name, 'plugin-raven-verify');
  assert.equal(packInfo.version, '0.3.2');
  tarballPath = join(repoRoot, packInfo.filename);
  assert.ok(existsSync(tarballPath), 'missing tarball ' + tarballPath);
  const list = mustOk(run('tar', ['tzf', tarballPath], { cwd: repoRoot }), 'tar tzf');
  const members = list.stdout.split('\n').filter(Boolean);
  assert.ok(members.some((m) => m === 'package/package.json'));
  assert.ok(members.some((m) => m.endsWith('dist/index.js')));
  assert.ok(members.some((m) => m.endsWith('dist/index.d.ts')));
  assert.ok(!members.some((m) => m.includes('node_modules')), 'tarball must not ship node_modules');
  assert.ok(!members.some((m) => m.includes('src/')), 'tarball must not ship src/');
  assert.ok(!members.some((m) => /0\.3\.1/.test(m)), 'no stale 0.3.1 path members');
  const packedPkg = JSON.parse(
    mustOk(run('tar', ['xzOf', tarballPath, 'package/package.json']), 'extract package.json').stdout,
  );
  assert.equal(packedPkg.version, '0.3.2');
  assert.deepEqual(Object.keys(packedPkg.exports || {}), ['.']);
  consumerDir = join(workDir, 'consumer');
  mkdirSync(consumerDir);
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'raven-pkg-boundary-consumer', private: true, type: 'module' }, null, 2),
  );
  mustOk(run('npm', ['install', tarballPath], { cwd: consumerDir }), 'npm install tarball');
  const installedPkgPath = join(consumerDir, 'node_modules/plugin-raven-verify/package.json');
  pkg = JSON.parse(readFileSync(installedPkgPath, 'utf8'));
  assert.equal(pkg.version, '0.3.2');
  assert.equal(pkg.name, 'plugin-raven-verify');
  const consumerEntry = join(consumerDir, 'import-bare.mjs');
  const bareSrc = [
    'import * as m from ' + JSON.stringify('plugin-raven-verify') + ';',
    'console.log(JSON.stringify(Object.keys(m).sort()));',
  ].join(String.fromCharCode(10));
  writeFileSync(consumerEntry, bareSrc);
  const bare = mustOk(run(process.execPath, [consumerEntry], { cwd: consumerDir }), 'bare import');
  assert.match(bare.stdout, /verifyTokenAction/);
  const mod = await import(pathToFileURL(join(consumerDir, 'node_modules/plugin-raven-verify/dist/index.js')).href);
  assert.ok(typeof mod.default === 'object' || typeof mod.ravenVerifyPlugin === 'object');
  assert.ok(mod.verifyTokenAction, 'public export verifyTokenAction required');
  verifyTokenAction = mod.verifyTokenAction;
});

after(() => {
  try { if (tarballPath && existsSync(tarballPath)) rmSync(tarballPath, { force: true }); } catch {}
  try { if (workDir) rmSync(workDir, { recursive: true, force: true }); } catch {}
});

const runtimeWith = (settings) => ({ getSetting: (k) => settings[k] });
const messageFor = (mint) => ({ content: { text: `check ${mint}` } });
const baseSettings = () => ({
  RAVEN_API_KEY: 'pkg-boundary-test-key',
  RAVEN_VERIFIER_URL: 'https://pkg-boundary.test',
});
describe('package boundary identity', () => {
  it('ships version 0.3.2 and only public export "."', () => {
    assert.equal(pkg.version, '0.3.2');
    assert.deepEqual(Object.keys(pkg.exports), ['.']);
  });
  it('rejects deep/subpath imports of internal modules', async () => {
    await assert.rejects(
      async () => import(pathToFileURL(join(consumerDir, 'node_modules/plugin-raven-verify/dist/actions/verifyToken.js')).href),
      /Cannot find module|ERR_MODULE_NOT_FOUND|ENOENT/i,
    );
    assert.equal(pkg.exports['./actions/verifyToken'], undefined);
    assert.equal(pkg.exports['./verify/verifyReceiptV1'], undefined);
  });
  it('packed dist contains no pubkey trust-bootstrap', () => {
    const distJs = readFileSync(join(consumerDir, 'node_modules/plugin-raven-verify/dist/index.js'), 'utf8');
    assert.ok(!/\/pubkey[\s\S]{0,120}trusted/i.test(distJs));
    assert.ok(!/trustedKeys[\s\S]{0,80}\/pubkey/i.test(distJs));
    assert.equal(distJs.includes('0.3.1'), false);
  });
});

describe('behavioral cases A-C', () => {
  it('A: correct pin succeeds', async () => {
    const result = await verifyTokenAction.handler(
      runtimeWith({ ...baseSettings(), RAVEN_TRUSTED_KEYS: fixture.trustedKeys.join(',') }),
      messageFor(fixture.input.mintAddress), undefined,
      { fetchImpl: fetchWith(fixture.input, ['HOSTILE']), now: fixture.now },
    );
    assert.equal(result.success, true);
    assert.equal(result.data.verification.keyTrusted, true);
    assert.equal(result.data.verification.valid, true);
  });
  it('B: no pin + hostile pubkey fail closed; no pubkey fetch', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/pubkey')) return jsonResponse(200, { keys: [{ publicKeyBase64: fixture.input.signerPublicKey }] });
      return jsonResponse(200, fixture.input);
    };
    const result = await verifyTokenAction.handler(runtimeWith(baseSettings()), messageFor(fixture.input.mintAddress), undefined, { fetchImpl, now: fixture.now });
    assert.equal(result.success, false);
    assert.notEqual(result.data?.verification?.keyTrusted, true);
    assert.equal(calls.filter((u) => u.endsWith('/pubkey')).length, 0);
  });
  it('C: wrong pin fails closed', async () => {
    const result = await verifyTokenAction.handler(
      runtimeWith({ ...baseSettings(), RAVEN_TRUSTED_KEYS: 'NOT_THE_SIGNER_PIN' }),
      messageFor(fixture.input.mintAddress), undefined,
      { fetchImpl: fetchWith(fixture.input, [fixture.input.signerPublicKey]), now: fixture.now },
    );
    assert.equal(result.success, false);
    assert.equal(result.data.verification.valid, true);
    assert.equal(result.data.verification.keyTrusted, false);
  });
});
describe('behavioral cases D-H', () => {
  it('D/E: RSA and P-256 no consequential success even if pinned', async () => {
    for (const attackerKeyType of ['rsa', 'ec']) {
      const pair = attackerKeyType === 'ec'
        ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
      const signerPublicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      const signedBytes = JSON.stringify({ domain: 'raven-receipt', payloadHash: fixture.input.payloadHash, version: 'v1' });
      const receipt = { ...fixture.input, signerPublicKey, signature: cryptoSign(null, Buffer.from(signedBytes, 'utf8'), pair.privateKey).toString('base64') };
      const result = await verifyTokenAction.handler(
        runtimeWith({ ...baseSettings(), RAVEN_TRUSTED_KEYS: signerPublicKey }),
        messageFor(receipt.mintAddress), undefined,
        { fetchImpl: fetchWith(receipt, []), now: fixture.now },
      );
      assert.equal(result.success, false, attackerKeyType + ' must not succeed');
      assert.equal(result.data.verification.valid, false);
    }
  });
  it('F: malformed empty whitespace non-string pin fail closed', async () => {
    for (const settings of [{ RAVEN_TRUSTED_KEYS: '' }, { RAVEN_TRUSTED_KEYS: '   ' }, { RAVEN_TRUSTED_KEYS: ',,,,' }]) {
      const result = await verifyTokenAction.handler(
        runtimeWith({ ...baseSettings(), ...settings }),
        messageFor(fixture.input.mintAddress), undefined,
        { fetchImpl: fetchWith(fixture.input, [fixture.input.signerPublicKey]), now: fixture.now },
      );
      assert.equal(result.success, false);
      assert.notEqual(result.data?.verification?.keyTrusted, true);
    }
    const nonStringRuntime = { getSetting: (k) => (k === 'RAVEN_TRUSTED_KEYS' ? { not: 'string' } : baseSettings()[k]) };
    const result = await verifyTokenAction.handler(nonStringRuntime, messageFor(fixture.input.mintAddress), undefined, { fetchImpl: fetchWith(fixture.input, [fixture.input.signerPublicKey]), now: fixture.now });
    assert.equal(result.success, false);
    assert.notEqual(result.data?.verification?.keyTrusted, true);
  });
  it('G: after pin removal second call fails closed', async () => {
    const ok = await verifyTokenAction.handler(
      runtimeWith({ ...baseSettings(), RAVEN_TRUSTED_KEYS: fixture.trustedKeys.join(',') }),
      messageFor(fixture.input.mintAddress), undefined,
      { fetchImpl: fetchWith(fixture.input, [fixture.input.signerPublicKey]), now: fixture.now },
    );
    assert.equal(ok.success, true);
    const after = await verifyTokenAction.handler(runtimeWith(baseSettings()), messageFor(fixture.input.mintAddress), undefined, { fetchImpl: fetchWith(fixture.input, [fixture.input.signerPublicKey]), now: fixture.now });
    assert.equal(after.success, false);
    assert.notEqual(after.data?.verification?.keyTrusted, true);
  });
  it('H: dist has no pubkey trust bootstrap', async () => {
    const distJs = readFileSync(join(consumerDir, 'node_modules/plugin-raven-verify/dist/index.js'), 'utf8');
    const bootstrapRe = /RAVEN_TRUSTED_KEYS[\s\S]{0,400}\/pubkey|\/pubkey[\s\S]{0,400}publicKeyBase64[\s\S]{0,200}trusted/i;
    assert.equal(bootstrapRe.test(distJs), false);
  });
});
