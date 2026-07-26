# Publishing a new package: the bootstrap sequence that actually works

Written down because both problems below bit us twice (sealed-fields and
civic-data-adapters). The steady state is easy; the FIRST publish is the
trap.

## The two traps

**Trap 1: trusted publishing cannot do the first publish.** npm's OIDC
trusted-publishing config lives on the package's settings page, and that
page does not exist until the package exists. A brand-new package
therefore cannot be born through the trusted-publishing workflow. The
first publish must happen locally, with a token or logged-in npm CLI.

**Trap 2: `publishConfig.provenance: true` breaks that local first
publish.** Provenance requires a supported CI OIDC environment. With the
flag committed in package.json, a local `npm publish` fails (the error
surfaces as a null-provider crash, not a helpful message: `provider:
null`). This is why civic-data-adapters dropped the flag from
package.json and moved it to the workflow.

## The sequence

1. package.json: `publishConfig` gets `"access": "public"` and NOTHING
   about provenance.
2. First publish, locally: `npm publish --access public`. Version 0.1.0,
   from a clean checkout, after `prepublishOnly` (typecheck + tests +
   build) passes.
3. Now the package exists. On npmjs.com → package → Settings → configure
   trusted publishing for the repo + release workflow filename.
4. The release workflow (`.github/workflows/release.yml`) carries the
   provenance flag as a CLI argument, where it only runs in CI:
   `npm publish --provenance --access public`, with `permissions:
   id-token: write` and npm >= 11.5 (`npm install -g npm@latest` in the
   job; older npm cannot mint the OIDC token).
5. Every subsequent release: bump version, tag `vX.Y.Z`, push the tag.
   The workflow guard checks tag == package.json version before
   publishing.

## Rules of thumb

- Provenance lives in the workflow command line, never in package.json.
- The release workflow filename is part of the trusted-publishing config;
  renaming the file silently breaks releases until the npm settings are
  updated to match.
- PyPI has the same bootstrap shape (a pending-publisher feature exists,
  but if the first upload happened via twine, configure trusted
  publishing afterward and stop using the token).
- Delete dead tags promptly (a v0.2 tag that never published cost us a
  confused hour on the gateway).
