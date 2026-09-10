# ai-gateway — README compatibility link

The canonical English project README is now [README.md](README.md). This file is retained only so older links to `README_EN.md` continue to resolve; it is not a second source of documentation truth.

Current public contract, in brief:

- Native surfaces: OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages.
- Cross-protocol fallback: OpenAI Chat Completions ↔ Anthropic Messages only; OpenAI Responses is Native Only.
- Gateway access uses `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` together with `GATEWAY_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}`.
- Node credentials bind by Tier + node id; Config and Secret shard suffixes are independent.

Start with [README.md](README.md), then use the [documentation index](docs/README.md) for architecture, operations, and governance.
