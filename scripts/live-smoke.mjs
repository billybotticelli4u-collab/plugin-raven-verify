// Live end-to-end smoke test for plugin-raven-verify.
// Exercises the EXACT path the VERIFY_TOKEN action uses: resolve the token
// program from the mint, then call the hosted Raven verifier with your key.
// Dev-only (not shipped — package "files" is ["dist"]).
//
// Usage:
//   RAVEN_API_KEY=... SOLANA_RPC_URL=... node scripts/live-smoke.mjs <mint>
//   (mint defaults to wrapped SOL if omitted)

const apiKey = process.env.RAVEN_API_KEY;
const rpcUrl = process.env.SOLANA_RPC_URL;
const verifierUrl = (process.env.RAVEN_VERIFIER_URL || 'https://raven-hosted-verifier.onrender.com').replace(/\/+$/, '');
const mint = process.argv[2] || 'So11111111111111111111111111111111111111112';

if (!apiKey || !rpcUrl) {
  console.error('Set RAVEN_API_KEY and SOLANA_RPC_URL in the environment.');
  process.exit(2);
}

// 1. Resolve the owning token program (same call the action makes).
const acct = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
    params: [mint, { encoding: 'base64', commitment: 'finalized' }],
  }),
});
const acctJson = await acct.json();
const tokenProgram = acctJson?.result?.value?.owner;
if (typeof tokenProgram !== 'string') {
  console.error('Could not resolve token program for', mint, '— mint not found or RPC unavailable.');
  process.exit(1);
}
console.log('mint           :', mint);
console.log('token program  :', tokenProgram);

// 2. Call the hosted verifier with the resolved program + your key.
const res = await fetch(`${verifierUrl}/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
  body: JSON.stringify({ mintAddress: mint, tokenProgramAddress: tokenProgram, commitment: 'finalized' }),
});
console.log('verify status  :', res.status);
if (!res.ok) {
  console.error('Verifier did not return 200 — receipt not produced.');
  process.exit(1);
}
const body = await res.json();

// 3. Show the receipt fields the plugin surfaces.
console.log('verdict        :', body.verdict, body.reason ? `(${body.reason})` : '');
console.log('findingCodes   :', JSON.stringify(body.findingCodes));
console.log('coverageGaps   :', JSON.stringify(body.coverageGaps));
console.log('keyId          :', body.keyId);
console.log('signature      :', body.signature ? `present (${body.signatureAlg})` : 'MISSING');
console.log('replayHash     :', body.replayHash);
console.log('observedSlot   :', body?.rpc?.observedSlot ?? null);
console.log('issuedAt       :', body.issuedAt);
console.log('\nSmoke OK — the action will return a real signed receipt end-to-end.');
