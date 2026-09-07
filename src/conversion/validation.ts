// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

export class ConversionError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = 'ConversionError';
    this.code = code;
  }
}


export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertFields(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) && value[key] !== undefined) {
      throw new ConversionError(`conversion_not_supported: ${context}.${key}`);
    }
  }
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined || value === '') return {};
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch {
      throw new ConversionError('conversion_not_supported: tool arguments must be a JSON object');
    }
  }
  if (!isRecord(parsed)) throw new ConversionError('conversion_not_supported: tool arguments must be a JSON object');
  return parsed;
}

export function assertSampling(body: Record<string, unknown>): void {
  if (body.temperature !== undefined && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 1)) {
    throw new ConversionError('conversion_not_supported: temperature must be between 0 and 1');
  }
  if (body.top_p !== undefined && (typeof body.top_p !== 'number' || body.top_p < 0 || body.top_p > 1)) {
    throw new ConversionError('conversion_not_supported: top_p must be between 0 and 1');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new ConversionError('conversion_not_supported: stream must be boolean');
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new ConversionError('conversion_not_supported: tools must be an array');
  }
}
