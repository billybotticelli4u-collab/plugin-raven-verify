# plugin-raven-verify

Pre-action **Solana token verification** for ElizaOS agents, via [Raven](https://ravenattest.com).

When an agent is about to touch a token, this plugin fetches a **signed, scope-bounded
on-chain evidence receipt** for the mint — what was checked, what was **not** checked, coverage
gaps, the observed slot, and an **ed25519 signature** the agent can verify itself. It is the
deterministic complement to an opaque trust score: every finding is reproducible from on-chain
evidence, and the result is signed, so a consumer can **re-derive and verify it rather than
trust it**.

### What it does NOT do

By design, it does **not** issue a safe/unsafe/legit/rug verdict, give trading or financial
advice, or predict price. It reports observed on-chain state within a stated scope, and returns
`unknowable` instead of guessing when evidence is missing. The agent applies its own policy.

## What it checks (on-chain evidence)

Mint & freeze authority, Token-2022 transfer hooks / permanent delegate, metadata mutability,
and CPMM liquidity-lock state — surfaced as deterministic finding codes plus an explicit list
of coverage gaps (surfaces NOT evaluated for this receipt).

## Install

```bash
npm install plugin-raven-verify
# or: bun add plugin-raven-verify
```

Add it to your agent's plugins, alongside your Solana plugin.

## Configuration

| Setting | Required | Description |
|---|---|---|
| `RAVEN_API_KEY` | yes | Raven hosted-verifier API key. Request access at https://raven-launch-console.vercel.app/request-access.html |
| `SOLANA_RPC_URL` | yes | Solana RPC endpoint — used to resolve the owning token program (SPL Token / Token-2022) from the mint before verification. |
| `RAVEN_VERIFIER_URL` | no | Verifier base URL. Defaults to `https://raven-hosted-verifier.onrender.com`. |

```env
RAVEN_API_KEY=your-raven-key
SOLANA_RPC_URL=https://your-rpc-endpoint
```

## Action

**`VERIFY_TOKEN`** (similes: `CHECK_TOKEN`, `VERIFY_MINT`, `RAVEN_VERIFY`, `TOKEN_EVIDENCE`,
`TOKEN_RECEIPT`)

Triggers when a message contains a Solana mint address and asks to verify / check it. The
handler resolves the token program from the mint, calls the Raven verifier, and returns a
scope-bounded receipt summary: outcome, finding codes that fired, coverage gaps, observed slot,
and the signing `keyId` + `replayHash` (verify against `<verifier>/pubkey`).

**Example**

> User: *Before I touch this, get a Raven receipt for `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump`*
>
> Agent: *Raven receipt — 9BB6… · Outcome (scope-bounded, not a safety verdict): … · Checks that fired: … · NOT evaluated / coverage gaps: … · Signed: keyId rvk_… ; replayHash sha256:… — verify against …/pubkey.*

Fail-closed throughout: if the mint can't be resolved, the verifier can't sign, or the request
fails, the plugin returns **no receipt** rather than a guessed result.

## How it works

The plugin is a thin client over the hosted Raven verifier ([`/verify`](https://raven-launch-console.vercel.app/openapi.json)).
The engine, the deterministic finding logic, and the ed25519 signing all live server-side; the
plugin never holds keys, never trades, and never submits transactions.

## Links

- Raven: https://ravenattest.com
- API spec: https://raven-launch-console.vercel.app/openapi.json
- npm (MCP server): https://www.npmjs.com/package/raven-verify-mcp

## License

MIT
