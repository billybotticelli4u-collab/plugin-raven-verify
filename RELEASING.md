# Releasing `plugin-raven-verify`

The release path is deliberately two-phase: CI may **stage** a package, but it
cannot make that package public. A maintainer must inspect the staged tarball and
approve it with 2FA.

## One-time owner configuration

1. Enable 2FA on the `raven_verify` npm account.
2. In the npm settings for `plugin-raven-verify`, configure a GitHub Actions
   trusted publisher with:
   - organization/user: `billybotticelli4u-collab`
   - repository: `plugin-raven-verify`
   - workflow: `release.yml`
   - environment: `npm-release`
   - allowed action: **stage publish only**
3. Set package publishing access to **require 2FA and disallow tokens**.
4. In GitHub, create the `npm-release` environment and require owner approval.
5. Protect `v*` tags from deletion or force-update.

Do not add a long-lived `NPM_TOKEN`. Trusted publishing uses short-lived OIDC
credentials and automatically produces npm provenance for a public package built
from this public repository.

## Prepare a release

1. Update `package.json` and both root version entries in `package-lock.json`.
2. Update the README change note.
3. Run:

   ```bash
   npm ci
   npm run typecheck
   npm run build
   npm run test:dist
   npm test
   npm pack --dry-run --json
   ```

4. Merge the release PR only after its full GitHub Actions check is green.
5. Confirm the exact merged `main` commit, then create a signed annotated tag
   matching the package version (for example, `v0.3.0`) at that commit.
6. Push only that tag. The `release.yml` workflow will rerun every gate and stage
   the package; it will not publish it.

## Review and approve

Use npm CLI 11.15.0 or newer, or npmjs.com:

```bash
npm stage list plugin-raven-verify
npm stage view <stage-id>
npm stage download <stage-id>
```

Before approval, verify the downloaded tarball's hash, file list, version,
repository identity, provenance record, Ed25519-only behavior, and untrusted-key
fail-closed behavior in a clean environment. Compare it to the CI artifact and
the tagged source commit.

Only after those checks pass:

```bash
npm stage approve <stage-id>
```

Approval requires maintainer presence and 2FA. If any check differs, reject the
stage; do not attempt to reuse the same version.

References:

- https://docs.npmjs.com/trusted-publishers/
- https://docs.npmjs.com/staged-publishing/
- https://docs.npmjs.com/generating-provenance-statements/
