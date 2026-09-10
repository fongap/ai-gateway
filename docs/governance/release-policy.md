# Version and tag policy

## Distribution model

ai-gateway is deployed as a service on Cloudflare Workers. The repository does not currently distribute versioned software artifacts for users to download and install.

Git tags remain useful as immutable, human-readable boundaries for stable source states. GitHub Releases are **not** part of the current version lifecycle. Existing GitHub Releases are retained as historical records; they do not need to be deleted merely to match the current policy.

If the project later starts shipping packaged artifacts, installers, or other versioned deliverables, this policy must be updated before GitHub Releases are reintroduced as a required mechanism.

## Version authority

The source version has one primary owner:

```text
package.json.version
```

The Node.js runtime requirement is owned by:

```text
package.json.engines.node
```

Synchronized copies must agree when a version changes, including `package-lock.json`, `src/config/version.ts`, and the corresponding `CHANGELOG.md` section.

## Version changes

The project follows Semantic Versioning:

- **Major** — incompatible public/API/configuration change.
- **Minor** — backward-compatible capability addition.
- **Patch** — backward-compatible correction or hardening.

A documentation-only correction does not require a version bump. Maintenance may keep the existing patch version when no externally meaningful compatibility boundary has changed.

## CHANGELOG

`CHANGELOG.md` records version history. It is not a source for current architecture or governance rules.

A version entry should contain the version/date and concise Added/Changed/Fixed/Removed notes that matter to users or operators.

## Version, tag, deployment, and build

These identities are deliberately separate:

- **Source version** — SemVer from `package.json.version`.
- **Git tag** — immutable stable-source boundary such as `vX.Y.Z`.
- **Deployment** — a Worker build published from `main` after the production gate.
- **Build identity** — the exact deployed commit SHA exposed by `/version` as `build`.

Do not use “latest Release” as a synonym for the current source version or deployed build.

## Stable tag lifecycle

The repository uses squash merge. A stable version tag must therefore point to the accepted commit on `main`, not to a pre-merge PR head.

```text
version / changelog change, when required
        ↓
Pull Request
        ↓
squash merge to main
        ↓
main validate-merge + validate-deploy succeed
        ↓
production deploy and verification succeed for deployable changes
        ↓
identify the final main commit SHA
        ↓
create tag vX.Y.Z on that SHA
```

## Tag rules

1. Do not create a stable version tag before the intended commit is on `main`.
2. The tag must point to the final `main` commit that passed the required production evidence.
3. Do not tag a PR branch merely because PR CI is green.
4. Published stable tags are immutable historical boundaries; corrections use a new version instead of moving an existing tag.
5. If an unpublished tag was created on the wrong commit, delete and recreate it before it becomes an external reference.

Tag format: `vX.Y.Z`.

## GitHub Releases

No new GitHub Release is required for normal ai-gateway versioning because the project is operated as a deployed service rather than distributed as release artifacts.

Existing GitHub Releases remain historical evidence for earlier repository states. Their presence does not make GitHub Releases part of the current lifecycle.

## Version evidence

For a stable version boundary, the expected evidence is:

- `package.json.version` and synchronized version metadata agree;
- the corresponding `CHANGELOG.md` section exists;
- the tag target is reachable from `main`;
- required CI passed for that commit;
- production verification passed when the change was deployable.

## Build identity

`/version` separates:

- `version` — source/version identity generated from `package.json`;
- `build` — deployed commit SHA injected by CI/Deploy.

This allows operators to identify the exact live commit without inventing a new semantic version for every deployment.
