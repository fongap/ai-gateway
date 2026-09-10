# Dependency policy

ai-gateway keeps the Worker runtime dependency surface intentionally small. Dependency changes are treated as behavior-risk changes when they affect bundling, protocol semantics, network behavior, or deployment tooling.

## Dependabot

`.github/dependabot.yml` currently checks:

- npm dependencies monthly, with at most 5 open PRs;
- GitHub Actions monthly, with at most 5 open PRs.

Security updates are not deferred merely to preserve the monthly cadence.

## Update policy

### Patch and minor updates

A patch/minor dependency update may be merged when:

- required CI passes;
- the update does not introduce a known breaking behavior;
- Worker bundle and deployment dry-run remain valid;
- security impact is acceptable.

Automatic merge is a repository-setting choice, not an assumption made by this policy.

### Major updates

Major updates require explicit review of breaking changes, Worker/runtime compatibility, configuration changes, and release impact. If public or operational behavior changes, update the relevant canonical documentation and `CHANGELOG.md`.

## Runtime dependencies

Prefer no runtime dependency when the Web Platform or a small local implementation is sufficient. A new runtime package needs a concrete reason such as security, protocol correctness, or substantial maintenance reduction.

Avoid adding general frameworks, validation stacks, HTTP wrappers, or utility libraries for convenience alone.

## Lockfile

- `package-lock.json` is committed.
- CI uses `npm ci` for deterministic installation.
- Do not hand-edit the lockfile.

## GitHub Actions

Actions used by required workflows should be pinned to immutable commit SHAs. Updating an Action pin requires the same review discipline as other build/deployment dependencies.

## Wrangler

Wrangler is invoked as a pinned CLI rather than installed as a production dependency. The canonical deploy wrapper is `scripts/cloudflare-wrangler.mjs`, which owns the pinned Wrangler version and the local deploy/migration behavior.

When the Wrangler pin changes:

1. review Cloudflare breaking changes;
2. update every intentionally duplicated CLI pin in repository tooling/scripts;
3. run `npm run validate:merge`, `npm run validate:deploy`, and `npm run check:deploy` as applicable;
4. update operator documentation if behavior or requirements changed.

Do not document `package.json` as the Wrangler version source unless Wrangler is actually moved there.
