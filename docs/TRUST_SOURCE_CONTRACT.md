# Trust-source contract (maintainers)

## Allowed trust-bearing input (exactly one)

- `RAVEN_TRUSTED_KEYS` — caller-controlled, independently obtained trusted
  public keys (comma-separated base64 SPKI). This is the **only** input that
  may populate the local trusted set used for `keyTrusted`.

## Non-trust-bearing inputs (must never elevate trust)

| Input | Role |
|-------|------|
| `RAVEN_API_KEY` | Auth for receipt production only |
| `RAVEN_VERIFIER_URL` | Transport base URL only |
| `RAVEN_FETCH_TIMEOUT_MS` | Timeout tuning only |
| `GET {verifier}/pubkey` | Discovery / cross-check only — **never** trusted set |
| Package metadata / agentConfig defaults | Documentation of settings — not runtime trust |
| Receipt `signerPublicKey` | Identity under verification — not a trust pin |
| Hardcoded / bundled keys | Forbidden |

## Doctrine

- No pin ⇒ fail closed (`keyTrusted !== true`).
- `valid` and `keyTrusted` are independent; do not gate usable evidence on `valid` alone.
- `/pubkey` must not bootstrap trust.
- Callers supply pins obtained out-of-band; the plugin does not publish or invent trust.

## Gate

Automated: `test/trust-input-surface.test.mjs` (and mutation IDs M-T1..M-T5).
