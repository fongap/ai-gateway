# Release policy

## Version authority

The software version has one primary source:

```text
package.json.version
```

The Node.js runtime requirement is owned by:

```text
package.json.engines.node
```

Generated or synchronized copies must agree when a version changes, including `package-lock.json`, `src/config/version.ts`, `CHANGELOG.md`, and the version shown in the canonical README when present.

## Version changes

The project follows Semantic Versioning as an external compatibility convention:

- **Major** — incompatible public/API/configuration change.
- **Minor** — backward-compatible capability addition.
- **Patch** — backward-compatible correction or hardening.

A documentation-only correction does not require a version bump. A maintenance cycle may also keep the existing patch version while hardening that same release line, provided no already-published immutable release contract is being rewritten.

## CHANGELOG

`CHANGELOG.md` records historical release changes. It is not a place for current architecture or governance rules.

A release entry should contain the release version/date and concise Added/Changed/Fixed/Removed notes that matter to users or operators.

## Deployment and release are different

Production deployment and GitHub Release are separate events:

- **Deployment** publishes a Worker build from `main` after the production gate.
- **Release** publishes a versioned repository snapshot using a Git tag plus a GitHub Release.

A deployed source version may temporarily exist before a corresponding GitHub Release is published. Documentation must not conflate “source version”, “deployed build”, and “latest published release”.

## Formal release lifecycle

The repository uses squash merge. A release tag therefore must point to the accepted commit on `main`, not to a pre-merge PR-head commit.

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
        ↓
create GitHub Release for vX.Y.Z
```

## Tag rules

1. Do not create a formal release tag before the release commit is on `main`.
2. The tag must point to the final `main` commit that passed the required production evidence.
3. Do not point a release tag at the PR branch merely because PR CI is green.
4. Once a GitHub Release has been published for a tag, treat that tag as immutable external history. Corrections require a new version rather than moving the published tag.
5. If an unpublished tag was created on the wrong commit, delete and recreate it before publishing the GitHub Release.

Tag format: `vX.Y.Z`.

## GitHub Release

The current repository does **not** define an automatic tag-triggered Release workflow. Creating a Git tag does not by itself satisfy the formal release contract; the maintainer explicitly creates the GitHub Release.

A release should include concise notes derived from the corresponding `CHANGELOG.md` entry or the accepted PR history. GitHub automatically exposes source ZIP/TAR archives for tagged releases.

Custom release assets or checksum manifests are required only if a real repository workflow builds, validates, and publishes those artifacts. Do not document a non-existent asset pipeline as a release requirement.

## Release evidence

The external evidence of a formal release is:

```text
Git tag vX.Y.Z
+
GitHub Release for vX.Y.Z
```

The internal evidence should include:

- the tag target is reachable from `main`;
- required CI passed for that commit;
- version synchronization passed;
- production verification passed when the change was deployable;
- release notes accurately describe the shipped behavior.

## Build identity

Release identity and deployment identity are deliberately separate:

- `version` — SemVer release identity from `package.json` / generated version metadata.
- `build` — deployed commit SHA injected by CI/Deploy and exposed by `/version`.

This allows operators to identify the exact deployed commit without inventing extra version numbers for every deployment.
