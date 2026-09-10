# GitHub repository settings

This document defines the **intended repository configuration**. GitHub Settings/API is the authority for the settings that are actually active at any moment; this file is the reviewable target state.

## About

Use a short description that explains the operational value rather than repeating every supported endpoint.

**Description**

> Resilient AI API gateway for Cloudflare Workers — multi-provider routing, multi-key load balancing, rate limiting, tiered failover, and OpenAI/Anthropic compatibility.

**Topics**

Topics should balance project identity, high-traffic ecosystem discovery, and high-intent capability searches. Avoid filling all 20 slots with synonyms or generic infrastructure terms.

Recommended set:

```text
ai-gateway
llm-gateway
llm-router
cloudflare-workers
claude-code
openai-api
openai-compatible
anthropic-api
load-balancing
rate-limiting
```

The set deliberately keeps overlapping gateway/router terms only where they represent distinct real search habits. Broad or redundant terms such as `ai`, `llm`, `proxy`, `serverless`, `api-gateway`, `llm-proxy`, `openai-proxy`, and `llmops` are omitted from the canonical set unless repository positioning changes.

Topics should reflect implemented behavior, not aspirational features.

**Homepage**

> https://api.135468.xyz/

The homepage is the public live gateway dashboard. It exposes model availability, traffic/token activity, and client quick-start information without exposing private operator configuration.

These values are the canonical About metadata recommendation. Update this document when the project positioning materially changes.

## Main branch Ruleset

Target: `main`.

Intended controls:

- require a Pull Request before merging;
- require review-thread resolution;
- require the `validate-merge` status check;
- require linear history;
- block force pushes;
- block branch deletion.

The solo-project review count should be set by the actual Ruleset rather than hard-coded in governance prose. Quality is primarily enforced by executable checks and focused review.

## Pull Request merge strategy

Intended repository settings:

- allow squash merge;
- disable merge commits;
- disable rebase merge;
- delete merged branches automatically when practical.

This keeps one accepted commit per PR on `main` and makes stable-tag targeting unambiguous.

## Required checks

| Check/workflow | When | Role |
| --- | --- | --- |
| `validate-merge` | PR + push | required PR merge gate |
| `validate-deploy` | main push, scheduled/manual CI | full production validation; not a PR required check |
| Deploy workflow | after successful eligible main CI or manual Deploy | production action; not a PR required check |

Do not configure Deploy as a pre-merge required check: it runs after the accepted change has reached `main`.

## GitHub Actions

Workflow permissions should remain minimal. Required actions should be pinned to immutable commit SHAs where practical.

The deployment workflow owns production mutation. CI workflows should remain read/validation oriented and must not silently deploy nightly/manual test runs.

## Dependabot

`.github/dependabot.yml` is the source of truth for dependency update cadence. Current policy tracks npm and GitHub Actions monthly, with security fixes handled promptly.

## Security reporting

Keep GitHub private vulnerability reporting / Security Advisories available. Public Issues must not contain live credentials, authorization headers, private upstream URLs, request bodies, or exploit details that should be reported privately.

See [SECURITY.md](../../SECURITY.md).

## Discussions and Issues

Discussions may remain enabled for general project conversation. Issues should be used for reproducible defects and focused feature requests, with the provided templates preferred.

## Repository metadata maintenance

When changing the About description/topics/homepage:

1. update GitHub repository metadata;
2. update the canonical block in this file in the same maintenance change;
3. keep `package.json` description/keywords and public README terminology semantically aligned where relevant.

About metadata is product positioning, not a substitute for architecture documentation.
