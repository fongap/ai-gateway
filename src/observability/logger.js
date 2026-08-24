// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

const LEVELS = { none: 0, error: 1, info: 2, debug: 3 };

export function getLogger(env) {
  const levelKey = String(env?.LOG_LEVEL || 'info').toLowerCase();
  const level = LEVELS[levelKey] ?? LEVELS.info;
  return {
    error: (...args) => { if (level >= 1) console.error(...args); },
    info: (...args) => { if (level >= 2) console.log(...args); },
    debug: (...args) => { if (level >= 3) console.debug(...args); },
  };
}
