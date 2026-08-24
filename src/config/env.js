// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Small env helpers shared by all config loaders.

export function readEnv(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function getBool(env, name, fallback = false) {
  const raw = readEnv(env, name);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function clampInt(value, min, max, fallback) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? Math.max(min, Math.min(max, num)) : fallback;
}
