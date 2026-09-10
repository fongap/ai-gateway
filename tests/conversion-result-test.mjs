#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import assert from 'node:assert/strict';
import {
  SYNTHETIC_STRUCTURED_OUTPUT_TOOL,
  convertAnthropicToOpenAIResult,
  convertOpenAIChatToAnthropicResult,
  selectStructuredOutputStrategy,
} from '../src/conversion/result.ts';
import { ConversionError } from '../src/conversion/validation.ts';

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

// Plain text can cross the existing Chat <-> Messages bridge without a
// material semantic downgrade.
{
  const result = convertAnthropicToOpenAIResult({
    model: 'Code-Max',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(result.fidelity, 'exact');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.structuredOutput, undefined);
  assert.equal(result.body.messages[0].content, 'hello');
}

// Portable function-tool mapping is visible but is not classified as loss.
{
  const result = convertAnthropicToOpenAIResult({
    model: 'Code-Max',
    max_tokens: 128,
    tools: [{
      name: 'Read',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }],
    messages: [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'README.md' } }],
    }],
  });
  assert.equal(result.fidelity, 'portable');
  assert.ok(result.diagnostics.some((d) => d.feature === 'function_tools' && d.action === 'mapped'));
  assert.ok(result.diagnostics.some((d) => d.feature === 'tool_calls' && d.action === 'mapped'));
}

// Claude Code controls/history that generic Chat cannot represent are
// classified explicitly. Diagnostic values must remain fixed categories.
{
  const privatePrompt = 'PRIVATE_PROMPT_MUST_NOT_APPEAR_IN_DIAGNOSTICS';
  const privateToolName = 'PRIVATE_TOOL_NAME_MUST_NOT_APPEAR_IN_DIAGNOSTICS';
  const result = convertAnthropicToOpenAIResult({
    model: 'Code-Max',
    max_tokens: 256,
    thinking: { type: 'enabled', budget_tokens: 128 },
    context_management: { edits: [] },
    output_config: { effort: 'high' },
    tools: [{
      name: privateToolName,
      input_schema: { type: 'object' },
      strict: true,
    }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages: [
      { role: 'user', content: privatePrompt },
      { role: 'system', content: 'updated instructions' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'sig' }],
      },
    ],
  });
  assert.equal(result.fidelity, 'degraded');
  const features = new Set(result.diagnostics.map((d) => d.feature));
  for (const feature of [
    'thinking_control', 'context_management', 'effort_control', 'tool_hints',
    'parallel_tool_control', 'mid_conversation_system', 'thinking_history',
  ]) assert.ok(features.has(feature), `missing diagnostic feature ${feature}`);
  const diagnosticJson = JSON.stringify(result.diagnostics);
  assert.equal(diagnosticJson.includes(privatePrompt), false);
  assert.equal(diagnosticJson.includes(privateToolName), false);
  assert.equal(diagnosticJson.includes('private reasoning'), false);
}

// Strategy order is explicit and conservative. Tool is not considered usable
// until both request-side support and a response-side unwrap adapter are known.
assert.equal(selectStructuredOutputStrategy({}), 'prompt');
assert.equal(selectStructuredOutputStrategy({ syntheticToolOutput: true }), 'prompt');
assert.equal(selectStructuredOutputStrategy({
  syntheticToolOutput: true,
  syntheticToolResultAdapter: true,
}), 'tool');
assert.equal(selectStructuredOutputStrategy({
  nativeJsonSchema: true,
  syntheticToolOutput: true,
  syntheticToolResultAdapter: true,
}), 'native');

// Anthropic structured output keeps the v1.3.1 prompt path for an unknown
// OpenAI-compatible target.
{
  const result = convertAnthropicToOpenAIResult({
    model: 'Code-Max',
    max_tokens: 256,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: 'answer' }],
  });
  assert.equal(result.fidelity, 'degraded');
  assert.equal(result.structuredOutput.strategy, 'prompt');
  assert.equal(result.diagnostics.some((d) =>
    d.feature === 'structured_output' && d.action === 'emulated' && d.strategy === 'prompt'), true);
  assert.equal(result.body.messages[0].role, 'system');
  assert.match(result.body.messages[0].content, /return only valid JSON/i);
  assert.ok(result.body.messages[0].content.includes(JSON.stringify(schema)));
  assert.equal(Object.hasOwn(result.body, 'response_format'), false);
}

// A caller with positive native capability evidence can request native OpenAI
// JSON Schema without also retaining the prompt emulation.
{
  const result = convertAnthropicToOpenAIResult({
    model: 'Code-Max',
    max_tokens: 256,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: 'answer' }],
  }, { structuredOutput: { nativeJsonSchema: true } });
  assert.equal(result.fidelity, 'portable');
  assert.equal(result.structuredOutput.strategy, 'native');
  assert.equal(result.body.response_format.type, 'json_schema');
  assert.deepEqual(result.body.response_format.json_schema.schema, schema);
  assert.equal(result.body.messages.some((m) =>
    typeof m.content === 'string' && /return only valid JSON/i.test(m.content)), false);
}

// Synthetic-tool strategy is modeled but requires the response adapter proof.
// It is also never forced over an existing client tool contract.
{
  const toolResult = convertAnthropicToOpenAIResult({
    model: 'Code-Max',
    max_tokens: 256,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: 'answer' }],
  }, {
    structuredOutput: {
      syntheticToolOutput: true,
      syntheticToolResultAdapter: true,
    },
  });
  assert.equal(toolResult.structuredOutput.strategy, 'tool');
  assert.equal(toolResult.fidelity, 'degraded');
  assert.equal(toolResult.body.tools[0].function.name, SYNTHETIC_STRUCTURED_OUTPUT_TOOL);
  assert.equal(toolResult.body.tool_choice.function.name, SYNTHETIC_STRUCTURED_OUTPUT_TOOL);

  const conflict = convertAnthropicToOpenAIResult({
    model: 'Code-Max',
    max_tokens: 256,
    output_config: { format: { type: 'json_schema', schema } },
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'answer' }],
  }, {
    structuredOutput: {
      syntheticToolOutput: true,
      syntheticToolResultAdapter: true,
    },
  });
  assert.equal(conflict.structuredOutput.strategy, 'prompt');
  assert.equal(conflict.body.tools.some((t) => t.function?.name === SYNTHETIC_STRUCTURED_OUTPUT_TOOL), false);
}

// OpenAI -> Anthropic keeps the existing 1024 default observable as semantic
// degradation rather than silently hiding the default policy.
{
  const result = convertOpenAIChatToAnthropicResult({
    model: 'gpt-compatible',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(result.fidelity, 'degraded');
  assert.equal(result.body.max_tokens, 1024);
  assert.ok(result.diagnostics.some((d) => d.feature === 'max_tokens' && d.action === 'defaulted'));
}

// OpenAI response_format is now accepted by the result wrapper. Unknown
// Anthropic-compatible targets use prompt emulation, preserving portability.
{
  const result = convertOpenAIChatToAnthropicResult({
    model: 'gpt-compatible',
    max_tokens: 256,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema, strict: true },
    },
    messages: [{ role: 'user', content: 'answer' }],
  });
  assert.equal(result.fidelity, 'degraded');
  assert.equal(result.structuredOutput.strategy, 'prompt');
  assert.equal(typeof result.body.system, 'string');
  assert.match(result.body.system, /return only valid JSON/i);
  assert.ok(result.body.system.includes(JSON.stringify(schema)));
  assert.equal(Object.hasOwn(result.body, 'output_config'), false);
}

// Positive capability evidence enables native Anthropic output_config.format.
{
  const result = convertOpenAIChatToAnthropicResult({
    model: 'gpt-compatible',
    max_tokens: 256,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema, strict: true },
    },
    messages: [{ role: 'user', content: 'answer' }],
  }, { structuredOutput: { nativeJsonSchema: true } });
  assert.equal(result.fidelity, 'portable');
  assert.equal(result.structuredOutput.strategy, 'native');
  assert.deepEqual(result.body.output_config, { format: { type: 'json_schema', schema } });
  assert.equal(result.body.system, undefined);
}

// strict:false must not be silently strengthened by a native Anthropic schema.
{
  const result = convertOpenAIChatToAnthropicResult({
    model: 'gpt-compatible',
    max_tokens: 256,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema, strict: false },
    },
    messages: [{ role: 'user', content: 'answer' }],
  }, { structuredOutput: { nativeJsonSchema: true } });
  assert.equal(result.structuredOutput.strategy, 'prompt');
  assert.equal(result.fidelity, 'degraded');
}

assert.throws(
  () => convertOpenAIChatToAnthropicResult({
    model: 'gpt-compatible',
    max_tokens: 256,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: 'invalid' },
    },
    messages: [{ role: 'user', content: 'answer' }],
  }),
  (error) => error instanceof ConversionError
    && /response_format\.json_schema\.schema must be an object/.test(error.message),
);

// Schema data is allowed in the converted outbound request but never in the
// diagnostics channel that fallback.ts logs.
{
  const privateSchema = {
    type: 'object',
    properties: { PRIVATE_SCHEMA_FIELD_DO_NOT_LOG: { type: 'string' } },
  };
  const result = convertAnthropicToOpenAIResult({
    model: 'Code-Max',
    max_tokens: 256,
    output_config: { format: { type: 'json_schema', schema: privateSchema } },
    messages: [{ role: 'user', content: 'PRIVATE_BODY_DO_NOT_LOG' }],
  });
  const diagnosticJson = JSON.stringify(result.diagnostics);
  assert.equal(diagnosticJson.includes('PRIVATE_SCHEMA_FIELD_DO_NOT_LOG'), false);
  assert.equal(diagnosticJson.includes('PRIVATE_BODY_DO_NOT_LOG'), false);
}

console.log('conversion result / fidelity / structured-output strategy contract passed');
