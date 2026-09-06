// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Small env helpers shared by all config loaders.

export function readEnv(env: Record<string, unknown>, name: string): string | undefined {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function getBool(env: Record<string, unknown>, name: string, fallback: boolean = false): boolean {
  const raw = readEnv(env, name);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const num = parseInt(value ?? '', 10);
  return Number.isFinite(num) ? Math.max(min, Math.min(max, num)) : fallback;
}
