// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Conversion result contract for the existing Chat <-> Messages fallback.
// This module deliberately does NOT expand the protocol matrix. It wraps the
// established body-only converters with semantic-fidelity diagnostics and a
// conservative structured-output strategy model.

import { convertAnthropicToOpenAIRequest } from './anthropic-to-openai.ts';
import { convertOpenAIChatRequestToAnthropic, DEFAULT_MAX_TOKENS } from './openai-chat-request-to-anthropic.ts';
import { ConversionError, isRecord } from './validation.ts';

export type ConversionFidelity = 'exact' | 'portable' | 'degraded';
export type ConversionDiagnosticAction = 'mapped' | 'dropped' | 'emulated' | 'defaulted';
export type StructuredOutputStrategy = 'native' | 'tool' | 'prompt';

export type ConversionDiagnostic = {
  feature: string,
  action: ConversionDiagnosticAction,
  strategy?: StructuredOutputStrategy,
};

export type StructuredOutputCapabilities = {
  /** The target wire implementation is known to accept native JSON Schema. */
  nativeJsonSchema?: boolean,
  /** The target wire implementation is known to accept function/tool forcing. */
  syntheticToolOutput?: boolean,
  /** The caller can unwrap the reserved synthetic tool back into structured output. */
  syntheticToolResultAdapter?: boolean,
};

export type ConversionOptions = {
  structuredOutput?: StructuredOutputCapabilities,
};

export type ConversionResult = {
  body: Record<string, unknown>,
  fidelity: ConversionFidelity,
  diagnostics: readonly ConversionDiagnostic[],
  structuredOutput?: { strategy: StructuredOutputStrategy },
};

export const SYNTHETIC_STRUCTURED_OUTPUT_TOOL = '__gateway_structured_output';

const TOOL_HINT_FIELDS = [
  'allowed_callers', 'defer_loading', 'strict', 'input_examples', 'eager_input_streaming',
] as const;

function addDiagnostic(
  diagnostics: ConversionDiagnostic[],
  diagnostic: ConversionDiagnostic,
): void {
  if (diagnostics.some((d) => d.feature === diagnostic.feature
    && d.action === diagnostic.action
    && d.strategy === diagnostic.strategy)) return;
  diagnostics.push(diagnostic);
}

function fidelityOf(diagnostics: readonly ConversionDiagnostic[]): ConversionFidelity {
  if (diagnostics.some((d) => d.action === 'dropped' || d.action === 'emulated' || d.action === 'defaulted')) {
    return 'degraded';
  }
  return diagnostics.length > 0 ? 'portable' : 'exact';
}

/**
 * Native is preferred only when the caller has positive capability evidence.
 * Tool emulation additionally requires a response-side adapter; request-side
 * tool forcing without unwrapping would change the client-visible semantics.
 * Unknown targets always remain on the existing prompt fallback.
 */
export function selectStructuredOutputStrategy(
  capabilities: StructuredOutputCapabilities = {},
): StructuredOutputStrategy {
  if (capabilities.nativeJsonSchema === true) return 'native';
  if (capabilities.syntheticToolOutput === true && capabilities.syntheticToolResultAdapter === true) return 'tool';
  return 'prompt';
}

function structuredOutputInstruction(schema: Record<string, unknown>): string {
  return [
    'For the final assistant text response, return only valid JSON matching this JSON Schema.',
    'Do not wrap the JSON in Markdown fences and do not add text outside the JSON value.',
    JSON.stringify(schema),
  ].join('\n');
}

function extractAnthropicStructuredSchema(body: Record<string, unknown>): Record<string, unknown> | null {
  const outputConfig = body.output_config;
  if (!isRecord(outputConfig) || !isRecord(outputConfig.format)) return null;
  const format = outputConfig.format;
  return format.type === 'json_schema' && isRecord(format.schema) ? format.schema : null;
}

function stripAnthropicStructuredFormat(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  if (!isRecord(body.output_config)) return next;
  const outputConfig = { ...body.output_config };
  delete outputConfig.format;
  if (Object.keys(outputConfig).length > 0) next.output_config = outputConfig;
  else delete next.output_config;
  return next;
}

function extractOpenAIChatStructuredSchema(body: Record<string, unknown>): {
  schema: Record<string, unknown>,
  strict: boolean | undefined,
} | null {
  if (body.response_format === undefined || body.response_format === null) return null;
  if (!isRecord(body.response_format)) {
    throw new ConversionError('conversion_not_supported: response_format must be an object');
  }
  const responseFormat = body.response_format;
  for (const key of Object.keys(responseFormat)) {
    if (!['type', 'json_schema'].includes(key) && responseFormat[key] !== undefined) {
      throw new ConversionError(`conversion_not_supported: response_format.${key}`);
    }
  }
  if (responseFormat.type !== 'json_schema' || !isRecord(responseFormat.json_schema)) {
    throw new ConversionError('conversion_not_supported: only response_format type json_schema is supported');
  }
  const jsonSchema = responseFormat.json_schema;
  for (const key of Object.keys(jsonSchema)) {
    if (!['name', 'description', 'schema', 'strict'].includes(key) && jsonSchema[key] !== undefined) {
      throw new ConversionError(`conversion_not_supported: response_format.json_schema.${key}`);
    }
  }
  if (!isRecord(jsonSchema.schema)) {
    throw new ConversionError('conversion_not_supported: response_format.json_schema.schema must be an object');
  }
  if (jsonSchema.strict !== undefined && typeof jsonSchema.strict !== 'boolean') {
    throw new ConversionError('conversion_not_supported: response_format.json_schema.strict must be boolean');
  }
  return { schema: jsonSchema.schema, strict: jsonSchema.strict as boolean | undefined };
}

function stripOpenAIResponseFormat(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  delete next.response_format;
  return next;
}

function appendAnthropicSystemInstruction(
  body: Record<string, unknown>,
  instruction: string,
): Record<string, unknown> {
  const next = { ...body };
  if (body.system === undefined || body.system === null || body.system === '') {
    next.system = instruction;
  } else if (typeof body.system === 'string') {
    next.system = [
      { type: 'text', text: body.system },
      { type: 'text', text: instruction },
    ];
  } else if (Array.isArray(body.system)) {
    next.system = [...body.system, { type: 'text', text: instruction }];
  } else {
    throw new ConversionError('conversion_not_supported: converted Anthropic system shape is invalid');
  }
  return next;
}

function hasClientTools(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

function resolveStructuredStrategy(
  requested: StructuredOutputStrategy,
  body: Record<string, unknown>,
  strict: boolean | undefined = undefined,
): StructuredOutputStrategy {
  // Synthetic-tool forcing cannot safely coexist with a client-forced tool
  // contract in this maintenance release. Keep the existing prompt path.
  if (requested === 'tool' && (hasClientTools(body) || body.tool_choice !== undefined)) return 'prompt';
  // Anthropic native structured output is strict-schema output. Do not silently
  // strengthen an explicit OpenAI strict:false request.
  if (requested === 'native' && strict === false) return 'prompt';
  return requested;
}

function anthropicDiagnostics(body: Record<string, unknown>): ConversionDiagnostic[] {
  const diagnostics: ConversionDiagnostic[] = [];
  if (body.thinking !== undefined) addDiagnostic(diagnostics, { feature: 'thinking_control', action: 'dropped' });
  if (body.context_management !== undefined) addDiagnostic(diagnostics, { feature: 'context_management', action: 'dropped' });
  if (isRecord(body.output_config) && body.output_config.effort !== undefined) {
    addDiagnostic(diagnostics, { feature: 'effort_control', action: 'dropped' });
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isRecord(tool)) continue;
      if (tool.type === 'advisor_20260301') {
        addDiagnostic(diagnostics, { feature: 'provider_native_tool', action: 'dropped' });
        continue;
      }
      addDiagnostic(diagnostics, { feature: 'function_tools', action: 'mapped' });
      if (TOOL_HINT_FIELDS.some((field) => tool[field] !== undefined)) {
        addDiagnostic(diagnostics, { feature: 'tool_hints', action: 'dropped' });
      }
    }
  }
  if (isRecord(body.tool_choice) && body.tool_choice.disable_parallel_tool_use !== undefined) {
    addDiagnostic(diagnostics, { feature: 'parallel_tool_control', action: 'dropped' });
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isRecord(message)) continue;
      if (message.role === 'system') {
        addDiagnostic(diagnostics, { feature: 'mid_conversation_system', action: 'emulated' });
        if (isRecord(message.output_config) && message.output_config.effort !== undefined) {
          addDiagnostic(diagnostics, { feature: 'effort_control', action: 'dropped' });
        }
      }
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_use') addDiagnostic(diagnostics, { feature: 'tool_calls', action: 'mapped' });
        if (block.type === 'tool_result') {
          addDiagnostic(diagnostics, { feature: 'tool_results', action: 'mapped' });
          if (block.is_error !== undefined) {
            addDiagnostic(diagnostics, { feature: 'tool_result_error_marker', action: 'dropped' });
          }
        }
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          addDiagnostic(diagnostics, { feature: 'thinking_history', action: 'dropped' });
        }
        if (block.type === 'server_tool_use' || block.type === 'advisor_tool_result') {
          addDiagnostic(diagnostics, { feature: 'provider_native_tool_history', action: 'dropped' });
        }
      }
    }
  }
  return diagnostics;
}

function openAIDiagnostics(body: Record<string, unknown>): ConversionDiagnostic[] {
  const diagnostics: ConversionDiagnostic[] = [];
  if (body.max_tokens === undefined) {
    addDiagnostic(diagnostics, { feature: 'max_tokens', action: 'defaulted' });
  }
  if (body.system !== undefined) addDiagnostic(diagnostics, { feature: 'system_role', action: 'mapped' });
  if (Array.isArray(body.developer) && body.developer.length > 0) {
    addDiagnostic(diagnostics, { feature: 'developer_role', action: 'emulated' });
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    addDiagnostic(diagnostics, { feature: 'function_tools', action: 'mapped' });
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isRecord(message)) continue;
      if (message.role === 'system') addDiagnostic(diagnostics, { feature: 'system_role', action: 'mapped' });
      if (message.role === 'developer') addDiagnostic(diagnostics, { feature: 'developer_role', action: 'emulated' });
      if (message.role === 'tool') addDiagnostic(diagnostics, { feature: 'tool_results', action: 'mapped' });
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        addDiagnostic(diagnostics, { feature: 'tool_calls', action: 'mapped' });
      }
      if (Array.isArray(message.content)
        && message.content.some((part) => isRecord(part) && part.type === 'image_url')) {
        addDiagnostic(diagnostics, { feature: 'image_url', action: 'mapped' });
      }
    }
  }
  return diagnostics;
}

function finalize(
  body: Record<string, unknown>,
  diagnostics: ConversionDiagnostic[],
  structuredOutput?: { strategy: StructuredOutputStrategy },
): ConversionResult {
  return {
    body,
    fidelity: fidelityOf(diagnostics),
    diagnostics,
    ...(structuredOutput ? { structuredOutput } : {}),
  };
}

export function convertAnthropicToOpenAIResult(
  body: Record<string, unknown>,
  options: ConversionOptions = {},
): ConversionResult {
  // The established converter remains the validation authority. The common
  // default path therefore has exactly the same wire behavior as v1.3.1.
  const promptBody = convertAnthropicToOpenAIRequest(body);
  const schema = extractAnthropicStructuredSchema(body);
  const diagnostics = anthropicDiagnostics(body);
  if (!schema) return finalize(promptBody, diagnostics);

  const requested = selectStructuredOutputStrategy(options.structuredOutput);
  const strategy = resolveStructuredStrategy(requested, body);
  if (strategy === 'prompt') {
    addDiagnostic(diagnostics, { feature: 'structured_output', action: 'emulated', strategy });
    return finalize(promptBody, diagnostics, { strategy });
  }

  // Remove format before reusing the established converter so native/tool
  // paths do not also inject the prompt emulation. The first conversion above
  // already validated the original output_config contract.
  const base = convertAnthropicToOpenAIRequest(stripAnthropicStructuredFormat(body));
  if (strategy === 'native') {
    addDiagnostic(diagnostics, { feature: 'structured_output', action: 'mapped', strategy });
    return finalize({
      ...base,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'structured_output', schema, strict: true },
      },
    }, diagnostics, { strategy });
  }

  const syntheticTool = {
    type: 'function',
    function: {
      name: SYNTHETIC_STRUCTURED_OUTPUT_TOOL,
      description: 'Return the final structured result.',
      parameters: schema,
    },
  };
  addDiagnostic(diagnostics, { feature: 'structured_output', action: 'emulated', strategy });
  return finalize({
    ...base,
    tools: [...(Array.isArray(base.tools) ? base.tools : []), syntheticTool],
    tool_choice: { type: 'function', function: { name: SYNTHETIC_STRUCTURED_OUTPUT_TOOL } },
  }, diagnostics, { strategy });
}

export function convertOpenAIChatToAnthropicResult(
  body: Record<string, unknown>,
  options: ConversionOptions = {},
): ConversionResult {
  const structured = extractOpenAIChatStructuredSchema(body);
  const base = convertOpenAIChatRequestToAnthropic(stripOpenAIResponseFormat(body));
  const diagnostics = openAIDiagnostics(body);
  if (!structured) return finalize(base, diagnostics);

  const requested = selectStructuredOutputStrategy(options.structuredOutput);
  const strategy = resolveStructuredStrategy(requested, body, structured.strict);
  if (strategy === 'native') {
    addDiagnostic(diagnostics, { feature: 'structured_output', action: 'mapped', strategy });
    return finalize({
      ...base,
      output_config: { format: { type: 'json_schema', schema: structured.schema } },
    }, diagnostics, { strategy });
  }

  if (strategy === 'tool') {
    addDiagnostic(diagnostics, { feature: 'structured_output', action: 'emulated', strategy });
    return finalize({
      ...base,
      tools: [
        ...(Array.isArray(base.tools) ? base.tools : []),
        {
          name: SYNTHETIC_STRUCTURED_OUTPUT_TOOL,
          description: 'Return the final structured result.',
          input_schema: structured.schema,
        },
      ],
      tool_choice: { type: 'tool', name: SYNTHETIC_STRUCTURED_OUTPUT_TOOL },
    }, diagnostics, { strategy });
  }

  addDiagnostic(diagnostics, { feature: 'structured_output', action: 'emulated', strategy });
  return finalize(
    appendAnthropicSystemInstruction(base, structuredOutputInstruction(structured.schema)),
    diagnostics,
    { strategy },
  );
}

// Re-exported fact used by diagnostics/tests; this does not change the existing
// v1.3.1 fallback default.
export { DEFAULT_MAX_TOKENS };
