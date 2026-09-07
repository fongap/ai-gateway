// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Route detection for the gateway surface. Only the allowlisted paths below are
// ever proxied or answered; everything else is a plain 404.

export const TIER_ORDER: readonly [1, 2, 3] = [1, 2, 3];

export type DetectedRoute =
  | 'openai_chat' | 'openai_responses' | 'anthropic_messages' | 'anthropic_count_tokens'
  | 'health' | 'metrics' | 'version' | 'models' | 'other';

export function normalizePath(pathname: string | undefined): string {
  return String(pathname || '/').replace(/\/+$/, '').toLowerCase() || '/';
}

export function detectRoute(method: string, pathname: string): DetectedRoute {
  const verb = String(method).toUpperCase();
  if (verb === 'GET') {
    if (pathname === '/health') return 'health';
    if (pathname === '/metrics') return 'metrics';
    if (pathname === '/version') return 'version';
    if (pathname === '/v1/models' || pathname === '/models') return 'models';
    return 'other';
  }
  if (verb !== 'POST') return 'other';
  if (pathname === '/v1/messages/count_tokens' || pathname === '/messages/count_tokens') return 'anthropic_count_tokens';
  if (pathname === '/v1/messages' || pathname === '/messages') return 'anthropic_messages';
  if (pathname === '/v1/responses' || pathname === '/responses') return 'openai_responses';
  if (pathname === '/v1/chat/completions' || pathname === '/chat/completions') return 'openai_chat';
  return 'other';
}

export function acceptsHtml(request: Request): boolean {
  return (request.headers.get('accept') || '').includes('text/html');
}
