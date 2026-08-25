// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Responses SSE framing and event builders.
//
// The Responses wire format is NOT Chat Completions SSE: events are named
// (`response.created`, `response.output_text.delta`, …), carry an ordered
// `sequence_number`, and reference output items by `output_index` / `item_id`.
// These builders are the single source of that framing so every path (stream,
// synthesizer, error) emits byte-compatible events.
//
// Event shapes and sequence numbering follow the OpenAI Responses event
// contract (the same ordering free-claude-code adopts) so Codex / OpenCode
// clients can consume them without a custom parser.

export function formatResponsesSseEvent(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class ResponsesEventBuilder {
  constructor() {
    this._nextSequenceNumber = 0;
  }

  response_created(response) {
    return this._format('response.created', { type: 'response.created', response });
  }

  response_completed(response) {
    return this._format('response.completed', { type: 'response.completed', response });
  }

  response_incomplete(response) {
    return this._format('response.incomplete', { type: 'response.incomplete', response });
  }

  response_failed(response) {
    return this._format('response.failed', { type: 'response.failed', response });
  }

  output_item_added(outputIndex, item) {
    return this._format('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item,
    });
  }

  output_item_done(outputIndex, item) {
    return this._format('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item,
    });
  }

  content_part_added(itemId, outputIndex) {
    return this._format('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  content_part_done(itemId, outputIndex, text) {
    return this._format('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    });
  }

  output_text_delta(itemId, outputIndex, text) {
    return this._format('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      delta: text,
    });
  }

  output_text_done(itemId, outputIndex, text) {
    return this._format('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text,
    });
  }

  reasoning_text_delta(itemId, outputIndex, text) {
    return this._format('response.reasoning_text.delta', {
      type: 'response.reasoning_text.delta',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      delta: text,
    });
  }

  reasoning_text_done(itemId, outputIndex, text) {
    return this._format('response.reasoning_text.done', {
      type: 'response.reasoning_text.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text,
    });
  }

  function_call_arguments_delta(itemId, outputIndex, argumentsJson) {
    return this._format('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: itemId,
      output_index: outputIndex,
      delta: argumentsJson,
    });
  }

  function_call_arguments_done(itemId, outputIndex, argumentsJson) {
    return this._format('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: itemId,
      output_index: outputIndex,
      arguments: argumentsJson,
    });
  }

  _format(eventType, data) {
    data.sequence_number = this._nextSequenceNumber;
    this._nextSequenceNumber += 1;
    return formatResponsesSseEvent(eventType, data);
  }
}

// ---- Error envelope --------------------------------------------------------

export function responsesErrorTypeForStatus(status) {
  if (status === 400 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 415) return 'unsupported_media_type_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 402) return 'billing_error';
  if (status === 529) return 'overloaded_error';
  if (status === 408 || status === 504) return 'timeout_error';
  return 'api_error';
}

// OpenAI-style error envelope used by /v1/responses responses.
export function buildResponsesError(message, errorType) {
  return {
    error: {
      message: String(message || 'Unknown gateway error.'),
      type: errorType || 'api_error',
      param: null,
      code: null,
    },
  };
}
