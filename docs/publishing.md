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
5. Every subsequent release: bump version, then either tag `vX.Y.Z` and
   push the tag, or run the Release workflow manually (Actions → Release
   → Run workflow) and give it the version — it creates the tag for you.
   The manual path exists because pushing a tag needs credentials that
   not every release path has, and it is the same publish job either
   way. Both are guarded on tag == package.json version, so a manual run
   cannot publish a version the branch does not declare.

## Installing a commit that is not released yet

An adopter who needs a fix before it ships — or while a publish is stuck in
the T+26 window below — installs the git ref directly:

```sh
npm install "github:mpointer/llm-governance-gateway#<commit-sha>"
```

That works only because of the `prepare` script. `dist/` is gitignored, so a
git checkout carries no build output; npm installs devDependencies for a git
dependency specifically so it can run `prepare`, which builds it. Without the
script npm installs the package, skips the build, and `files` publishes the
three things that do exist — LICENSE, README.md, package.json — producing an
install that resolves and then throws on first import:

```
ERR_MODULE_NOT_FOUND: Cannot find module .../llm-governance-gateway/dist/index.js
```

`prepublishOnly` does NOT cover this: npm runs it for `npm publish` only,
never for a git install.

The same script is what makes `npm pack` self-contained. Packing a clean
checkout without it produced a 3-file tarball with no `dist/` — the identical
failure, in a form that looks like a real artifact and can be handed to
someone before anyone notices. With it, `npm pack` builds first and produces
95 files.

The optional peer dependencies are unchanged by any of this: `/http` needs
`hono` and the drizzle adapters need `drizzle-orm` in the CONSUMER's project,
on a git install exactly as on a registry install.

## Rules of thumb

- Provenance lives in the workflow command line, never in package.json.
- `scripts.prepare` is load-bearing twice over: it is the only thing that
  makes a git ref installable, and the only thing that makes `npm pack`
  build. Removing it breaks both silently — the install succeeds and the
  tarball is produced, each missing `dist/`.
- The release workflow filename is part of the trusted-publishing config;
  renaming the file silently breaks releases until the npm settings are
  updated to match. The trust binds to the *file*, not to the trigger, so
  adding `workflow_dispatch` to it did not require an npm settings change.
- PyPI has the same bootstrap shape (a pending-publisher feature exists,
  but if the first upload happened via twine, configure trusted
  publishing afterward and stop using the token).
- Delete dead tags promptly (a v0.2 tag that never published cost us a
  confused hour on the gateway).
- **A successful publish is not an installable package.** npm accepts the
  upload and *then* processes it, and the two halves of "published" arrive
  separately. Measured on v0.14.0:

  | | |
  |---|---|
  | `npm publish` returns `+ pkg@version` | T+0 |
  | Metadata live (packument, `dist-tags`) | T+9 min |
  | **Tarball live — `npm install` works** | **T+26 min** |

  So for ~17 minutes `npm view` reported the new version while installing it
  404'd. npm says this itself, in the line right before the success line:
  *"Your package is being processed and may take a few minutes to become
  available."*

  **Verify against the tarball URL, not `npm view`:**

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' \
    https://registry.npmjs.org/<pkg>/-/<pkg>-<version>.tgz
  ```

  Two traps inside this one:

  - **`npm view` is CDN-cached** (`cache-control: max-age=300`), so it can
    report the *old* version for five minutes after the metadata actually
    landed. Cache-bust before believing it:

    ```sh
    curl -H 'Cache-Control: no-cache' \
      "https://registry.npmjs.org/<pkg>?t=$(date +%s)"
    ```

  - **Never re-run the release on a 404.** npm already holds the version, so
    a republish fails with a 403 — and because the tag-reuse check passes
    first (the tag points at the same commit), you get all the way to that
    error before learning anything. Waiting is the only fix.

  Budget half an hour before telling an adopter a release is available, and
  expect provenance-signed publishes to sit at the slow end: the attestation
  adds steps between acceptance and availability.
