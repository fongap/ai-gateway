// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Cross-module protocol vocabulary. Module successor of the ambient
// declarations in src/types/domain.d.ts — the ambient copies remain only
// for checkJs consumers of not-yet-migrated .js modules and are deleted
// together with domain.d.ts in PR 7 (see docs/governance/typescript-migration.md).

export type Protocol = 'openai' | 'anthropic';

/**
 *   chat_completions  -> openai /v1/chat/completions
 *   responses         -> openai /v1/responses
 *   messages          -> anthropic /v1/messages
 */
export type Surface = 'chat_completions' | 'responses' | 'messages';
