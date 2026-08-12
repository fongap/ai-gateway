# ai-gateway rename patch

Copy this directory over the repository root. Existing files not included here remain unchanged.

The patch intentionally removes fixed GitHub owner/repository URLs:

- `package.json` no longer carries `repository`, `homepage`, or `bugs` fields. GitHub already knows the repository URL, while these fields become stale after a rename.
- README CI and release badges should use repository-relative workflow links, or be omitted. Avoid embedding `owner/repository` in badge image services.
- Worker source uses optional `PROJECT_REPOSITORY_URL`. If it is unset, the dashboard omits its source link and `/version` omits the `repository` field.
- Release archive names come from `package.json.name` and `package.json.version`.
- Interactive installation reads the default Worker name from `wrangler.jsonc`.

For the current repository, `package.json.name` and the default Worker name are `ai-gateway`. Cloudflare Workers Builds can override the Worker name for each connected project while keeping the default `npx wrangler deploy` command.
