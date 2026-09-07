// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Minimal structural types for the Cloudflare bindings this Worker actually
// uses (v1.3.0 TypeScript migration, PR 5). Only the consumed surface is
// declared — today that is the D1 database API (prepare / bind / all / first
// / run / batch). KV affinity uses its own structural type in
// src/scheduler/tier1-affinity.ts.
//
// Why not @cloudflare/workers-types: the package declares the full Workers
// global surface (Request / Response / fetch / …), which collides with the
// DOM lib this project compiles against (see tsconfig.json `lib`). A minimal
// structural declaration keeps the zero-dependency posture and avoids a
// library migration for types the runtime never touches.

export type D1Result<T = unknown> = {
  results?: T[],
  success?: boolean,
  meta?: Record<string, unknown>,
};

export type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement,
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>,
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>,
  run(): Promise<D1Result>,
};

export type D1Database = {
  prepare(query: string): D1PreparedStatement,
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>,
};
