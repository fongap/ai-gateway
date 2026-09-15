#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Post-header processing failures must describe WHAT failed in the transport
// layer and let reliability/classify.ts decide HOW the node is treated.

import assert from 'node:assert/strict';
import {
  classifyPostHeadersFailure,
  KIND,
} from '../src/reliability/classify.ts';
import {
  UPSTREAM_PROCESSING_ERROR,
  upstreamProcessingError,
  upstreamProcessingErrorCode,
} from '../src/transport/processing-error.ts';
import { collectOpenAIStreamObject } from '../src/stream/assemble.ts';

const cases = [
  [UPSTREAM_PROCESSING_ERROR.DEADLINE, KIND.FIRST_EVENT_TIMEOUT],
  [UPSTREAM_PROCESSING_ERROR.MALFORMED, KIND.NON_JSON_BODY],
  [UPSTREAM_PROCESSING_ERROR.TOO_LARGE, KIND.NON_JSON_BODY],
  [UPSTREAM_PROCESSING_ERROR.TRUNCATED, KIND.STREAM_INTERRUPTED],
  [UPSTREAM_PROCESSING_ERROR.EMPTY, KIND.EMPTY_200],
  [UPSTREAM_PROCESSING_ERROR.TERMINAL, KIND.SERVER],
];

for (const [code, expectedKind] of cases) {
  const error = upstreamProcessingError(code, `test:${code}`);
  assert.equal(upstreamProcessingErrorCode(error), code);
  assert.equal(
    classifyPostHeadersFailure(error).kind,
    expectedKind,
    `${code} must map to ${expectedKind}`,
  );
}

assert.equal(
  classifyPostHeadersFailure(new SyntaxError('bad json')).kind,
  KIND.NON_JSON_BODY,
  'plain JSON.parse failures are structural upstream-body failures',
);

// Integration guard: the OpenAI stream assembler must emit a typed malformed
// error instead of a generic Error whose message callers would need to parse.
const malformed = new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {not-json}\n\n'));
    controller.close();
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

await assert.rejects(
  () => collectOpenAIStreamObject(malformed, null, Date.now() + 1000),
  (error) => upstreamProcessingErrorCode(error) === UPSTREAM_PROCESSING_ERROR.MALFORMED,
  'malformed SSE JSON must preserve a typed processing reason',
);

console.log('upstream processing classification tests passed.');
