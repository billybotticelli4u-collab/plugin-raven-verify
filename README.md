# plugin-raven-verify

ElizaOS plugin: before an agent acts on a Solana token, fetch a **signed Raven
receipt** (receipt-v1) for the mint and **verify it locally** against trusted
published keys — then report the facts. Evidence, not a safe/unsafe verdict.

```
agent mentions a mint → POST /receipt/v1 → verify LOCALLY (in this plugin's code)
→ report findings, what was NOT checked, slot/timestamp, freshness, verification status
→ the agent applies its own policy
```

## What "verify locally" means here

The receipt's ed25519 signature, payload hash, receiptId derivation, byte-exact
disclaimer, and field shape are all re-checked **inside this plugin** (see
[`src/verify/`](src/verify)) before anything is reported. Transport is never
trusted; a tampered or malformed receipt fails closed with the exact reasons. Key
trust and freshness are reported independently of signature validity — a stale
receipt is still authentic and is labeled STALE, never hidden.

The verifier is an independent vendored copy of the open receipt-v1 kernel,
validated against the same **golden vectors** as every other implementation
([`fixtures/receipt-v1/`](fixtures/receipt-v1) — including a real
production-signed receipt). Conformance is defined by shared vectors, not shared
code; that is the Raven standard's trust mechanism, and you can re-run it
yourself: `npm test`, fully offline.

## Configuration

| Setting | Required | Meaning |
|---|---|---|
| `RAVEN_API_KEY` | yes | Producing receipts is metered; the action is disabled without a key. Verification of receipts is free and local, always. |
| `RAVEN_VERIFIER_URL` | no | Defaults to `https://raven-hosted-verifier.onrender.com`. |
| `RAVEN_TRUSTED_KEYS` | no | Comma-separated base64 SPKI keys to pin (strongest). Unset ⇒ the published `/pubkey` key set is fetched and cached (10 min). |

## What the agent gets

One action, `VERIFY_TOKEN` (similes: `CHECK_TOKEN`, `VERIFY_MINT`, `RAVEN_VERIFY`,
`TOKEN_EVIDENCE`, `TOKEN_RECEIPT`). On success the text reports, in order: local
verification status (incl. key trust and staleness), observed slot/timestamp and
the signed token program, findings, **NOT checked** (scope-not-performed +
coverage gaps — the same standing as findings), the `receiptId`, and the signed
disclaimer. `data` carries the full receipt and the verification result for the
agent's own policy layer.

Failure semantics are explicit and fail-closed: transient upstream problems
(429/5xx/network) say *retry later* and claim nothing; a receipt that fails local
verification is reported as **not usable evidence** with the failing checks; a
mint that produces no receipt is stated as exactly that.

## Non-goals

No trading calls, no wallet access, no transaction submission, no risk scores, no
verdict of any kind. Raven does not issue safe/unsafe verdicts; this plugin
reports locally verified, scope-bounded on-chain evidence, and the agent applies
its own policy.

## Development

```
npm ci
npm run typecheck
npm run build      # tsup → dist (ESM + d.ts)
npm test           # offline: vendored golden vectors + fake-fetch action tests
```

Changes in 0.2.0: switched from the v2 `/verify` path to `/receipt/v1` (the
standard's canonical primitive); receipts are now verified **locally in-code**
(previously the plugin reported signature material and left verification to the
reader); dropped the `SOLANA_RPC_URL` requirement (the receipt carries the
resolved token program as a signed field); added the golden-vector conformance
suite, hardened verifier kernel, CI, and this README.
