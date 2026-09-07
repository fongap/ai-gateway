// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

const LEVELS: Record<string, number> = { none: 0, error: 1, info: 2, debug: 3 };

export type GatewayLogger = {
  error: (...args: unknown[]) => void,
  info: (...args: unknown[]) => void,
  debug: (...args: unknown[]) => void,
};

export function getLogger(env: Record<string, unknown>): GatewayLogger {
  const levelKey = String(env?.LOG_LEVEL || 'info').toLowerCase();
  const level = LEVELS[levelKey] ?? LEVELS.info;
  return {
    error: (...args: unknown[]) => { if (level >= 1) console.error(...args); },
    info: (...args: unknown[]) => { if (level >= 2) console.log(...args); },
    debug: (...args: unknown[]) => { if (level >= 3) console.debug(...args); },
  };
}
