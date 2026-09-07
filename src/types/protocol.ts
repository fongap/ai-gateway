// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Cross-module protocol vocabulary. Canonical source for Protocol and Surface
// types, consumed throughout the migrated .ts modules (src/types/domain.d.ts
// has been deleted — see docs/governance/typescript-migration.md).

export type Protocol = 'openai' | 'anthropic';

/**
 *   chat_completions  -> openai /v1/chat/completions
 *   responses         -> openai /v1/responses
 *   messages          -> anthropic /v1/messages
 */
export type Surface = 'chat_completions' | 'responses' | 'messages';
