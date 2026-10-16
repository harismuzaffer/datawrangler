# Progress

## Done

- Architecture, pipeline model, transform list, and LLM tool design agreed. See [decisions.md](decisions.md).
- Vitest set up (`npm test`).
- Fixed streamed tool calls failing on Llama and other Workers AI models (checked by hand in `npm run dev`). See [decisions.md](decisions.md#model-and-streaming-workaround).
- Goal 3: pipeline core. 35 transforms (text, missing values, formats, rows, columns, math, window), a pipeline per upload stored in the agent with safe steps added automatically, and the `addStep`, `updateStep`, `removeStep`, `moveStep`, and `previewPipeline` tools. Tools checked with real models. Llama 3.3 tool calls failed because of the AI SDK's tool schema conversion; fixed and confirmed through the agent. Llama still leaks some multi-call replies and guesses step IDs (see decisions).
- Goal 2: upload a CSV (up to 5 MB) to R2, profile it in a workflow, show the profile in a panel, and let the LLM read it with `getProfile`. Each browser has its own agent (user ID in local storage).
- Goal 1: starter turned into DataCobbler. Agent renamed to `CobblerAgent`, project to `datacobbler`. Demo tools removed (weather, timezone, calculator, scheduler, MCP). DataCobbler system prompt added. README rewritten.

## Next

- Decide the default model, and whether to send the current pipeline with each chat turn (see open questions in decisions).
- Goal 4: full run in a workflow and download.

## Not started

- Full run workflow and download.
- Pipeline export and import.
- User memory (preferences).
- UI: pipeline panel, preview, download.
