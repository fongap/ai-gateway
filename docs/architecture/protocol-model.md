# Protocol model

ai-gateway supports two protocol families: OpenAI and Anthropic. Protocol is an explicit node property; a provider label does not select a protocol or imply a surface.

## Native surfaces

| Client path | Protocol | Native upstream path |
| --- | --- | --- |
| `/v1/chat/completions` | OpenAI Chat Completions | `/v1/chat/completions` |
| `/v1/responses` | OpenAI Responses | `/v1/responses` |
| `/v1/messages` | Anthropic Messages | `/v1/messages` |
| `/v1/messages/count_tokens` | Anthropic-compatible local utility | local approximate count unless disabled |

Nodes declare `protocol` and `surfaces`; scheduling filters on protocol + surface + model before selecting a node.

## Native First

OpenAI Chat Completions and Anthropic Messages always try native nodes first. Cross-protocol conversion starts only after the native candidate pool has been exhausted and the route is enabled.

The built-in fallback chain is:

```json
{
  "anthropic:messages": ["openai:chat_completions"],
  "openai:chat_completions": ["anthropic:messages"]
}
```

`PROTOCOL_FALLBACKS=disable` disables conversion fallback. An explicit JSON mapping overrides the built-in chain. OpenAI Responses is always Native Only and has no cross-protocol conversion route.

Fallback does not reset the request. Native attempts and conversion fallback share the same `max_attempts`, tier-attempt accounting, dispatch ceiling, and `FAILOVER_BUDGET_MS` wall clock. A hedge twin is chosen only from the current protocol/surface pool; cross-protocol hedge is not allowed.

## Conversion boundary

`src/conversion/` contains direct adapters for the only supported bridge: OpenAI Chat Completions ↔ Anthropic Messages. The project intentionally does not maintain an all-protocol canonical IR and does not expand the conversion matrix merely because another native surface exists.

Conversion is semantic and may be lossy. The result wrapper in `src/conversion/result.ts` reports that explicitly:

```ts
type ConversionResult = {
  body: Record<string, unknown>;
  fidelity: 'exact' | 'portable' | 'degraded';
  diagnostics: readonly ConversionDiagnostic[];
  structuredOutput?: { strategy: 'native' | 'tool' | 'prompt' };
};
```

### Fidelity

| Fidelity | Meaning |
| --- | --- |
| `exact` | No semantic mapping, emulation, default, or drop was recorded |
| `portable` | Semantics were mapped to a target representation without a known loss |
| `degraded` | At least one feature was dropped, emulated, or defaulted |

Diagnostics use fixed categories such as `mapped`, `dropped`, `emulated`, and `defaulted`. They must never include request text, prompts, schemas, credentials, private tool names, or other client-controlled sensitive values.

## Structured output

Structured-output conversion uses a conservative capability order:

```text
Native JSON Schema
        ↓ if positively known unsupported/unavailable
Synthetic Tool
        ↓ if request-side support + response-side unwrap are both proven
Prompt emulation
```

Rules:

- `native` requires positive evidence that the target wire implementation accepts native JSON Schema.
- `tool` requires both synthetic-tool output support and a response adapter that can unwrap the reserved tool back into the client's expected structured result.
- Existing client tool/tool-choice contracts are not overwritten by synthetic-tool emulation.
- An OpenAI `strict:false` schema is not silently strengthened into a strict Anthropic native schema.
- Unknown target capabilities use `prompt` rather than guessing provider compatibility.

The current runtime fallback path does not pass per-node structured-output capability evidence into the conversion wrapper, so unknown targets remain on the conservative Prompt strategy by default. The Native and Tool strategies are capability primitives, not a claim that every configured provider automatically uses them.

## OpenAI Chat → Anthropic Messages

The converter supports the portable subset needed by the gateway's Chat fallback, including normal messages, function tools/calls/results, image URL mapping where supported by the converter, stop controls, and common generation parameters.

Anthropic requires `max_tokens`; when an OpenAI Chat fallback request omits it, the converter applies its current safe default and reports that as `defaulted` fidelity information rather than hiding the semantic choice.

OpenAI system/developer semantics may need mapping or emulation because Anthropic uses a top-level system representation. Unsupported request semantics fail conversion rather than being silently invented.

## Anthropic Messages → OpenAI Chat

Portable function tools and tool call/result history are mapped where representable. Anthropic-specific controls or history that generic Chat cannot safely represent may be dropped or emulated and are surfaced through fidelity diagnostics.

Examples of potentially degraded semantics include Anthropic thinking controls/history, context-management controls, provider-native tools, tool hints, parallel-tool controls, and mid-conversation system instructions.

## Response and stream conversion

Fallback includes the response direction as well as the request direction. A converted upstream response is returned in the **client's original protocol envelope**.

Streaming adapters translate supported events incrementally. The first-event guard still owns the commit boundary: failover is safe before the first meaningful client-visible output is committed; transparent failover after commit is intentionally not attempted.

Protocol-specific completion semantics remain distinct:

- OpenAI Chat commits on meaningful content, reasoning, or tool-call output.
- OpenAI Responses commits on supported response output deltas and remains native.
- Anthropic Messages commits on meaningful text, thinking, or tool-input deltas.

## Error envelopes

A fallback failure must not leak the target upstream's protocol envelope to the original client.

- OpenAI Chat clients receive OpenAI-shaped errors.
- Anthropic Messages clients receive Anthropic-shaped errors.
- Conversion failures are reported as gateway conversion failures before an invalid target request is dispatched.

## Responsibility boundaries

| Layer | Responsibility |
| --- | --- |
| Protocol | Client validation and protocol-specific errors |
| Transport | Upstream path, headers, native wire behavior |
| Conversion | Only the supported Chat ↔ Messages semantic bridge |
| Stream | First-event guard and stream lifecycle |
| Scheduler | Candidate selection; never protocol-event parsing |
| Reliability | Failure state; never request-shape conversion |

See [Routing model](routing-model.md) and [Reliability model](reliability-model.md) for how protocol eligibility interacts with attempts, hedge, and cooldown.
