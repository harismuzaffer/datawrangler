# Progress

## Done

- Architecture, pipeline model, transform list, and LLM tool design agreed. See [decisions.md](decisions.md).
- Vitest set up (`npm test`).
- Fixed streamed tool calls failing on Llama and other Workers AI models (checked by hand in `npm run dev`). See [decisions.md](decisions.md#model-and-streaming-workaround).
- Goal 1: starter turned into DataCobbler. Agent renamed to `CobblerAgent`, project to `datacobbler`. Demo tools removed (weather, timezone, calculator, scheduler, MCP). DataCobbler system prompt added. README rewritten.

## Next

- User checks goal 1 in `npm run dev`.
- Goal 2: upload a CSV (up to 5 MB) to R2, parse it, and show a profile.

## Not started

- Per-user agent ID in the UI (all browsers share one agent today).
- Upload to R2 and dataset records.
- Profile workflow.
- Pipeline storage, editing tools, preview.
- Full run workflow and download.
- Pipeline export and import.
- User memory (preferences).
- UI: upload, pipeline panel, preview, download.
