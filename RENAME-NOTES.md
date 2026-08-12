# Repository rename notes

The repository name is not embedded in package metadata or release scripts.

- `package.json.name` controls npm metadata and release archive names.
- GitHub Actions uses `${{ github.repository }}` implicitly and does not contain an owner/repository pair.
- `PROJECT_REPOSITORY_URL` is an optional Worker variable. When set to an HTTPS URL, the dashboard and `/version` expose it. When unset, the dashboard omits the source link.
- `wrangler.jsonc.name` is the deployable Worker's default name, not the GitHub repository name. Override it per Worker or Wrangler environment when one repository deploys multiple Workers.
- GitHub security reports remain available through the repository's native **Security** tab; no absolute repository URL is stored in the issue template.
