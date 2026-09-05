# TRUST BOOTSTRAP RED (frozen)

**Branch:** `billy/plugin-trust-bootstrap-fail-closed`  
**Ancestry:** based on PR #10 head `026fb2b177639ee0c7b6f6686e8c38be9436585b`
(`fix/canonical-base64-trustedkeys`). Adds the fail-closed bootstrap that #10
explicitly deferred ("`/pubkey` default NOT changed"). Do **not** merge PR #10
from this work; this branch is the successor.

## Pre-fix behavior (PR #10 head / 0.3.1)

`loadTrustedKeys` in `src/actions/verifyToken.ts`:

- If `RAVEN_TRUSTED_KEYS` is set → use pins.
- Else → **fetch `{verifier}/pubkey`**, cache 10 min, and treat returned
  `publicKeyBase64` values as the **trusted set**.

## RED reproduction (must fail closed after fix)

1. Leave `RAVEN_TRUSTED_KEYS` **absent**.
2. Serve a hostile `/pubkey` that returns an **attacker** Ed25519 SPKI.
3. Serve a `/receipt/v1` receipt **signed by that attacker** (cryptographically
   valid shape for the vendored kernel).
4. Invoke `VERIFY_TOKEN`.

**Pre-fix result:** action can succeed with `keyTrusted: true` — trust
elevated from discovery (fail-open bootstrap).

**Post-fix required result:** action **must not** succeed as trusted
verification (`success === false`, `keyTrusted !== true`). `/pubkey` must not
populate `trustedKeys`.

Automated: `test/verifyToken.test.ts` →
`RED hostile: no pin + hostile /pubkey + attacker receipt must fail closed`.

## Cases

| Case | Config | Required |
|------|--------|----------|
| A | valid pins | use only pins |
| B | absent pin | empty set; no `/pubkey` trust |
| C | malformed pin | empty set (fail closed) |
| D | pin present, signer not in set | `keyTrusted false` |
| E | unsupported key types | fail closed per verifier (#10) |
| F | `/pubkey` down | irrelevant when pinned; unpinned still fail closed |
| G/H | `/pubkey` discovery | never populate trustedKeys (omitted from trust path) |
