# PLUGIN 0.3.2 RELEASE CANDIDATE HANDOFF

**STATUS:** PLUGIN 0.3.2 RELEASE CANDIDATE READY FOR INDEPENDENT REVIEW

**SELF REVIEW:** NOT PERFORMED
**PUBLISH AUTHORIZED:** NO
**NEVER self-GO.**

## 1. Identity

Candidate HEAD: 0e668209343ad3edd01d44672851743905ab7016
Candidate tree: 60ee038163527d4318ab69be7e69fbba65e2ccd1
Base: 2fa5493eb868bad7bef465123e8425b8706a75fc / tree e3fbef3d7a9cac02b9b16d22d8a009fac7564d12
Branch: billy/plugin-0.3.2-release-quality
Version: 0.3.2 NOT published
PR10: 026fb2b177639ee0c7b6f6686e8c38be9436585b
origin/main: 0bfe919b2dba58180a0e41207abd0691c211dbb6

## 2 Doctrine
Caller RAVEN_TRUSTED_KEYS only. Discovery not trust-bearing. Fail closed without pin.
## 3 Gates
N22.18.0 and N24.20.0: typecheck build source dist package-boundary trust-input doc-contract mutations ALL PASS.
## 4 Mutations
M0 SURVIVE; M1-M7 LOAD-BEARING KILL; M8 CONTRACT-ONLY; M2!=M7.
## 5 Pack freeze
artifact: plugin-raven-verify-0.3.2.tgz
sha256: 262966dfb463066a78bcff52d3162be3a4d0809277986cffbcc24e39ac580503
size: 20999
shasum: b02c435b683809d9e3d3601a19b3435227b04209
integ: sha512-4o/9Um1j/i92mNejOkWYCkTimmX/aQnd80qJFz2NCWC3lgIfDomTv03IPxyDxdgRfdVv4YqsYA6v6bgmKPy4TA==
packed_with: node v22.18.0 / npmCLI 10.9.3
members: package/LICENSE package/README.md package/package.json package/dist/index.js package/dist/index.js.map package/dist/index.d.ts
FC findings: NONE
## 6 PR composition
Recommend A: one combined 0.3.2 PR from this branch. Ancestry includes PR10 head 026fb2b. Draft PR #10 remains open to supersede.

## 7 Hard rules
No registry publish. No dist-tags. No merge. No deploy. No prod credentials. No receipt-v1 edits. No launchguard 206/207. No discovery trust bootstrap. No self-GO.

## 8 FINAL FREEZE checklist (abbrev)
1 identity recorded 2 tree frozen 3 matrix green both nodes 4 pack once 5 members listed 6 FC none 7 mutations green 8 docs contract green 9 trust-input green 10 package-boundary green 11 branch pushed 12 remote SHA readback required 13 no edits after freeze 14 publish NOT authorized 15 self-review NOT performed

## 9 Hostile review prompt (paste to CODEX/KIMI/Chat)

You are an independent hostile reviewer of plugin-raven-verify 0.3.2 RC.
Branch billy/plugin-0.3.2-release-quality at 0e668209343ad3edd01d44672851743905ab7016.
Doctrine: only RAVEN_TRUSTED_KEYS is trust-bearing; discovery must not bootstrap trust; no pin fails closed; valid != keyTrusted.
Attack the candidate: try to find any path where discovery, API key, verifier URL, hardcoded keys, README lies, pack/dist divergence, or mutation survival elevates trust. Check package-boundary, trust-input, doc-contract, mutations harness honesty (CONTRACT-ONLY must not be counted as security kill; M0 must survive; disposable copies only). Verify tarball sha256 262966dfb463066a78bcff52d3162be3a4d0809277986cffbcc24e39ac580503 and member list. Do NOT publish. Report FINDINGS only; do not self-GO.

## 10. Matrix detail
- Node v22.18.0 npmCLI 10.9.3: all gates PASS
- Node v24.20.0 npmCLI 11.19.0: all gates PASS
- Disagreements: none

## 11. Candidate delta (0e66820)
New tests package-boundary trust-input doc-contract; mutations repaired; TRUST_SOURCE_CONTRACT; CI matrix; wording fix; evidence docs.

## 12. Owner decisions
Combined PR merge path; registry release approval not granted by this packet.

## 13. Status line
PLUGIN 0.3.2 RELEASE CANDIDATE READY FOR INDEPENDENT REVIEW
SELF REVIEW: NOT PERFORMED
PUBLISH AUTHORIZED: NO
