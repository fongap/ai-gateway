// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Typed failures raised while consuming an already-started upstream response.
// This is deliberately transport-level data, not a reliability decision: the
// response parser/assembler describes WHAT failed, while reliability/classify
// decides HOW that failure affects rotation/cooldown/circuit state.

export const UPSTREAM_PROCESSING_ERROR = Object.freeze({
  DEADLINE: 'deadline',
  MALFORMED: 'malformed',
  TOO_LARGE: 'too_large',
  TRUNCATED: 'truncated',
  EMPTY: 'empty',
  TERMINAL: 'terminal',
} as const);

export type UpstreamProcessingErrorCode = typeof UPSTREAM_PROCESSING_ERROR[keyof typeof UPSTREAM_PROCESSING_ERROR];

export class UpstreamProcessingError extends Error {
  readonly code: UpstreamProcessingErrorCode;

  constructor(code: UpstreamProcessingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'UpstreamProcessingError';
    this.code = code;
  }
}

export function upstreamProcessingError(
  code: UpstreamProcessingErrorCode,
  message: string,
  cause?: unknown,
): UpstreamProcessingError {
  return new UpstreamProcessingError(code, message, cause === undefined ? undefined : { cause });
}

export function upstreamProcessingErrorCode(error: unknown): UpstreamProcessingErrorCode | null {
  return error instanceof UpstreamProcessingError ? error.code : null;
}
