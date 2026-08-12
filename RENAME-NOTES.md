# Repository rename notes

The repository name is not embedded in package metadata or release scripts.

- `package.json.name` controls npm metadata and release archive names.
- GitHub Actions uses `${{ github.repository }}` implicitly and does not contain an owner/repository pair.
- `PROJECT_REPOSITORY_URL` is an optional Worker variable. When set to an HTTPS URL, the dashboard and `/version` expose it. When unset, the dashboard omits the source link.
- `wrangler.jsonc.name` is only the generic direct-deployment name, not a list of connected Workers. Cloudflare Workers Builds selects the Worker connected in its dashboard and overrides the CI deployment target automatically.
- GitHub security reports remain available through the repository's native **Security** tab; no absolute repository URL is stored in the issue template.
