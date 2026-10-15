/**
 * Workaround for a bug in `workers-ai-provider` (seen in 3.3.1 and 4.0.0).
 *
 * When streaming, some Workers AI models (Llama, Qwen, Mistral, ...) send each chunk in two formats at once:
 * OpenAI style in `choices[0].delta`, and a copy in the top-level `response` and `tool_calls` fields.
 * The provider reads both, so text and tool-call arguments arrive twice and tool calls fail to parse.
 * Remove this file once the provider reads only one of them.
 */

/** Returns the SSE `data` payload with the duplicate top-level fields removed, or the payload unchanged. */
export function stripDuplicateFields(data: string): string {
  let chunk: unknown;
  try {
    chunk = JSON.parse(data);
  } catch {
    // Not JSON (for example `[DONE]`): pass it on for the provider to handle.
    return data;
  }
  if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return data;

  // Only drop the copies when the OpenAI-style delta is there to carry the content.
  const first: unknown = chunk.choices[0];
  if (!isRecord(first) || !isRecord(first.delta)) return data;
  if (!("response" in chunk) && !("tool_calls" in chunk)) return data;

  const { response: _response, tool_calls: _toolCalls, ...rest } = chunk;
  return JSON.stringify(rest);
}

/** Returns an SSE byte stream where every `data:` line has gone through `stripDuplicateFields`. */
export function fixDuplicateStreamFields(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  // A network read can end in the middle of a line, so hold the partial line until the rest arrives.
  let pending = "";

  const fixLine = (line: string) => {
    const match = /^data: ?(.*?)(\r?)$/.exec(line);
    if (!match) return line;
    return `data: ${stripDuplicateFields(match[1])}${match[2]}`;
  };

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        pending += decoder.decode(bytes, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        if (lines.length > 0)
          controller.enqueue(
            encoder.encode(lines.map(fixLine).join("\n") + "\n")
          );
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(fixLine(pending)));
      }
    })
  );
}

/** Wraps the Workers AI binding so streamed chat responses no longer carry duplicate fields. */
export function withStreamFix(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === "run" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result: unknown = await value.apply(target, args);
          return result instanceof ReadableStream
            ? fixDuplicateStreamFields(result)
            : result;
        };
      }
      // Binding methods expect the real binding as `this`, not the proxy.
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
