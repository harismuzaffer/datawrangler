import { describe, expect, it } from "vitest";
import {
  fixDuplicateStreamFields,
  stripDuplicateFields,
  withStreamFix
} from "./ai-binding";

// Shape taken from a real Llama 3.3 stream on Workers AI.
const dualChunk = {
  id: "x",
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [{ index: 0, function: { arguments: '{"city": "' } }]
      }
    }
  ],
  tool_calls: [{ arguments: '{"city": "' }],
  response: null,
  usage: { total_tokens: 8 }
};

describe("stripDuplicateFields", () => {
  it("drops top-level copies when the OpenAI-style delta is present", () => {
    const out = JSON.parse(stripDuplicateFields(JSON.stringify(dualChunk)));
    expect(out).not.toHaveProperty("tool_calls");
    expect(out).not.toHaveProperty("response");
    expect(out.choices).toEqual(dualChunk.choices);
    expect(out.usage).toEqual(dualChunk.usage);
  });

  it("keeps native-format chunks that have no choices", () => {
    const native = JSON.stringify({
      response: "Hi",
      tool_calls: [],
      usage: { total_tokens: 1 }
    });
    expect(stripDuplicateFields(native)).toBe(native);
  });

  it("keeps chunks with an empty choices list", () => {
    const empty = JSON.stringify({ choices: [], response: "", usage: {} });
    expect(stripDuplicateFields(empty)).toBe(empty);
  });

  it("keeps OpenAI-only chunks unchanged", () => {
    const openai = JSON.stringify({ choices: [{ delta: { content: "Hi" } }] });
    expect(stripDuplicateFields(openai)).toBe(openai);
  });

  it("passes non-JSON payloads through", () => {
    expect(stripDuplicateFields("[DONE]")).toBe("[DONE]");
    expect(stripDuplicateFields("{broken")).toBe("{broken");
  });
});

async function runStream(parts: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    }
  });
  return new Response(fixDuplicateStreamFields(source)).text();
}

describe("fixDuplicateStreamFields", () => {
  const sse = `data: ${JSON.stringify(dualChunk)}\n\ndata: [DONE]\n\n`;
  const expected = `data: ${stripDuplicateFields(JSON.stringify(dualChunk))}\n\ndata: [DONE]\n\n`;

  it("fixes every data line", async () => {
    expect(await runStream([sse])).toBe(expected);
  });

  it("handles a line split across reads", async () => {
    const parts = [sse.slice(0, 7), sse.slice(7, 40), sse.slice(40)];
    expect(await runStream(parts)).toBe(expected);
  });

  it("handles a multi-byte character split across reads", async () => {
    const text = `data: ${JSON.stringify({ choices: [{ delta: { content: "café" } }], response: "café" })}\n\n`;
    const bytes = new TextEncoder().encode(text);
    const cut = bytes.indexOf(0xc3) + 1;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      }
    });
    const out = await new Response(fixDuplicateStreamFields(source)).text();
    expect(out).toBe(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "café" } }] })}\n\n`
    );
  });

  it("keeps CRLF line endings and a last line with no newline", async () => {
    const native = JSON.stringify({ response: "Hi" });
    expect(await runStream([`data: ${native}\r\n\r\ndata: [DONE]`])).toBe(
      `data: ${native}\r\n\r\ndata: [DONE]`
    );
  });
});

describe("withStreamFix", () => {
  it("fixes streamed results and leaves other results alone", async () => {
    const fake = {
      run: async (_model: string, inputs: { stream?: boolean }) =>
        inputs.stream
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(dualChunk)}\n\n`
                  )
                );
                controller.close();
              }
            })
          : { response: "plain" },
      models: () => "models"
    } as unknown as Ai;
    const ai = withStreamFix(fake);

    const streamed = await ai.run(
      "@cf/any" as never,
      { stream: true } as never
    );
    const text = await new Response(streamed as ReadableStream).text();
    expect(text).not.toContain('"tool_calls":[{"arguments"');
    expect(await ai.run("@cf/any" as never, {} as never)).toEqual({
      response: "plain"
    });
    expect((ai as unknown as { models: () => string }).models()).toBe("models");
  });
});
