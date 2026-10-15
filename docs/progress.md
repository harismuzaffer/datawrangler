# Progress

## Done

- Architecture, pipeline model, transform list, and LLM tool design agreed. See [decisions.md](decisions.md).
- Vitest set up (`npm test`).
- Fixed streamed tool calls failing on Llama and other Workers AI models (checked by hand in `npm run dev`). See [decisions.md](decisions.md#model-and-streaming-workaround).
- Goal 1: starter turned into DataCobbler. Agent renamed to `CobblerAgent`, project to `datacobbler`. Demo tools removed (weather, timezone, calculator, scheduler, MCP). DataCobbler system prompt added. README rewritten.

## Next

- Goal 2 (in progress): CSV parsing and profiling done; upload to R2, profile workflow, and `getProfile` tool done (checked end to end in `npm run dev`). Next: upload button, per-user ID, and profile panel in the UI.

## Not started

- Per-user agent ID in the UI (all browsers share one agent today).
- Pipeline storage, editing tools, preview.
- Full run workflow and download.
- Pipeline export and import.
- User memory (preferences).
- UI: upload, pipeline panel, preview, download.
