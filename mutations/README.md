# Trust-bootstrap mutations (M1–M8)

Disposable intent patches. Apply under a throwaway copy; do not commit mutants.

| ID | Intent | Class if killed |
|----|--------|-----------------|
| M1 | Re-introduce `/pubkey` trusted set when unpinned | LOAD-BEARING |
| M2 | Skip `keyTrusted !== true` gate | LOAD-BEARING |
| M3 | Merge `/pubkey` into pins | LOAD-BEARING |
| M4 | Absent pin ⇒ trust-any duck | LOAD-BEARING |
| M5 | Whitespace pin bootstraps `/pubkey` | LOAD-BEARING |
| M6 | Coerce non-string pin | LOAD-BEARING |
| M7 | Gate on `valid` alone | LOAD-BEARING |
| M8 | README unset⇒`/pubkey` trusted | CONTRACT |

Surviving mutation after hostile/RED tests = **finding**.

Run: `node mutations/run-mutations.mjs` (from repo root after build deps).
