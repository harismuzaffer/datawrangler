# Progress

## Done

- Architecture, pipeline model, transform list, and LLM tool design agreed. See [decisions.md](decisions.md).
- Vitest set up (`npm test`).
- Fixed streamed tool calls failing on Llama and other Workers AI models (checked by hand in `npm run dev`). See [decisions.md](decisions.md#model-and-streaming-workaround).
- Goal 4: full run and download. `RunWorkflow` runs the pipeline on the whole file and writes a new version to R2. The `runPipeline` tool needs the user's approval in the chat. The panel shows the run and a Download CSV button. Checked by hand: in the browser (upload, ask, approve, download), by script (approve and reject through the agent), and with a 5 MB file.
- Goal 3: pipeline core. 35 transforms (text, missing values, formats, rows, columns, math, window), a pipeline per upload stored in the agent with safe steps added automatically, and the `addStep`, `updateStep`, `removeStep`, `moveStep`, and `previewPipeline` tools. Tools checked with real models. Llama 3.3 tool calls failed because of the AI SDK's tool schema conversion; fixed and confirmed through the agent. Llama still leaks some multi-call replies and guesses step IDs, so the agent now uses Mistral Small 3.1 (see decisions).
- Goal 2: upload a CSV (up to 5 MB) to R2, profile it in a workflow, show the profile in a panel, and let the LLM read it with `getProfile`. Each browser has its own agent (user ID in local storage).
- Goal 1: starter turned into DataCobbler. Agent renamed to `CobblerAgent`, project to `datacobbler`. Demo tools removed (weather, timezone, calculator, scheduler, MCP). DataCobbler system prompt added. README rewritten.

## Next

- Goal 5: UI pipeline panel (see and edit steps, preview, run without the chat).

## Not started

- Pipeline export and import.
- User memory (preferences).
- UI: pipeline panel and preview. The download button exists.
