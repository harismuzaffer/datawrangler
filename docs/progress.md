# Progress

## Done

- Architecture, pipeline model, transform list, and LLM tool design agreed. See [decisions.md](decisions.md).
- Vitest set up (`npm test`).
- Fixed streamed tool calls failing on Llama and other Workers AI models (checked by hand in `npm run dev`). See [decisions.md](decisions.md#model-and-streaming-workaround).
- Goal 2: upload a CSV (up to 5 MB) to R2, profile it in a workflow, show the profile in a panel, and let the LLM read it with `getProfile`. Each browser has its own agent (user ID in local storage).
- Goal 1: starter turned into DataCobbler. Agent renamed to `CobblerAgent`, project to `datacobbler`. Demo tools removed (weather, timezone, calculator, scheduler, MCP). DataCobbler system prompt added. README rewritten.

## Next

- User checks goal 2 in `npm run dev`.
- Goal 3: pipeline core (pipeline storage, transforms, editing tools, preview).

## Not started

- Pipeline storage, editing tools, preview.
- Full run workflow and download.
- Pipeline export and import.
- User memory (preferences).
- UI: pipeline panel, preview, download.
