# Ancestry

- Base: PR #10 head `026fb2b177639ee0c7b6f6686e8c38be9436585b`
  (`fix/canonical-base64-trustedkeys`) — canonical Base64URL + total
  `trustedKeys` hardening; body: "`/pubkey` default NOT changed".
- This branch `billy/plugin-trust-bootstrap-fail-closed` is a **successor**:
  adds fail-closed trust bootstrap that #10 explicitly deferred.
- Do **not** merge PR #10 as part of this work.
- Do **not** self-review #10.
- Do **not** compete with #10; land as follow-on after / instead of competing tip.
