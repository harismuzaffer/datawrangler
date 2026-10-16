# DataCobbler — Code

How the code is organized and how to write it. Read this before changing code. Update it in the same step as the code.

## Conventions

### General

- Keep code simple and easy to read. Prefer plain functions, plain objects, and types over classes, patterns, and layers. Use a class only where the framework needs one (Agent, Workflow, Durable Object).
- Keep `src/` flat. Add a subfolder only when a group of files has a clear shared purpose.
- TypeScript strict mode. No `any`; use `unknown` and narrow it.
- Validate external input (tool arguments, uploads, requests) with zod at the boundary. Trust typed data inside.
- Use async/await. Handle an error where you can act on it; never swallow it silently.
- Use named exports. One main concern per file. Match the starter's file naming.
- Write invisible or special characters as brace escapes (`\u{200B}`, with the `u` flag in regexes). The formatter turns `\u200B`-style escapes into the literal, invisible character.
- Use the project's formatter and linter. Lines up to 120 characters. Do not reformat unrelated code.
- User-facing text, including agent replies: short, plain, and human. No jargon.

### LLM prompts and tools

- Keep system prompts and tool definitions together in one file so they are easy to review.
- A tool description says when to use the tool, not how it works.

### Doc comments

- Every exported function, class, and type has a TSDoc comment (`/** ... */`), unless its name and signature already say everything.
- One sentence on what it does or returns. Add more only for what a caller must know: side effects, errors thrown, retries, limits, units.

### Inline comments

- Explain why, not what.
- No comments on obvious code. No commented-out code.

## Structure

One line per file or module. Keep this list current.

- `src/server.ts`: Worker entry and `CobblerAgent`: chat loop and LLM call, upload and download routes, `datasets`, `pipelines`, and `runs` tables, preview sample loading, starting full runs, synced state, workflow callbacks, and the callables the UI uses (profile, transform catalog, pipeline view, step edits, run).
- `src/prompts.ts`: system prompt (with the transform catalog, plus the user's preferences per request) and the tool descriptions and input schemas.
- `src/pipeline-actions.ts`: pipeline edits, checks on the sample, replacing a pipeline from file steps, and starting a checked run, shared by the LLM tools and the pipeline panel. They reach the agent through the `PipelineHost` interface. `pipelineEditSchema` validates edits that come from the browser.
- `src/pipeline-file.ts`: the pipeline file format: export, parse and check an imported file, find columns a file lacks, apply the user's column mapping, and build a pipeline from file steps.
- `src/tools.ts`: the LLM tools, built on `src/pipeline-actions.ts`. They work on the latest upload. Tool input schemas are converted with zod (see `toolSchema`), not by the AI SDK.
- `src/upload.ts`: upload checks: body size limit while reading, binary-file check, file name and user ID schemas.
- `src/profile-workflow.ts`: `ProfileWorkflow`: reads a CSV from R2, profiles it, reports the profile to the agent.
- `src/run-workflow.ts`: `RunWorkflow`: runs a pipeline on a whole file from R2 and writes the result as a new file version.
- `src/download.ts`: the cleaned file's name and the `Content-Disposition` header for downloads.
- `src/profile-summary.ts`: shrinks a profile to fit the LLM's context.
- `src/ai-binding.ts`: wraps the Workers AI binding to fix duplicated fields in streamed responses (a provider bug).
- `src/csv.ts`: decodes file bytes (BOM, UTF-8, UTF-16, Windows-1252 fallback) and parses CSV with Papa Parse (delimiter detection, quoted fields); writes a table back to CSV bytes.
- `src/profile.ts`: builds a dataset profile from parsed rows: column types, counts, samples, and detected issues.
- `src/table.ts`: the `Table` the pipeline works on (unique column names, padded rows) and number helpers.
- `src/transforms/`: one file per transform group (`text`, `values`, `rows`, `columns`, `math`, `window`). `core.ts` has the step context that looks up columns and records changes; `index.ts` is the registry of all transforms.
- `src/pipeline.ts`: pipeline model: validate, add, update, remove, and move steps; run steps on a table; run the whole pipeline for a full run; build a preview; pick the safe steps for a profile.
- `src/app.tsx`: chat UI: per-browser user ID, CSV upload (button and drag and drop), profile and pipeline panels (capped at half the window), messages, tool approval cards.
- `src/profile-panel.tsx`: shows the latest upload's status, file issues, a table of columns with types, counts, and issues, and its latest run with a download button.
- `src/pipeline-panel.tsx`: the pipeline panel: steps with their results on the preview rows, move, remove, edit, add, preview up to a step, the result table, Run with a confirm step, and Export and Import with a column mapping form.
- `src/step-form.tsx`: the add and edit form for one step, built from the transform's JSON Schema, with column pickers.
- `src/memory.ts`: preference limits, the text check, and the `MemoryHost` interface the memory tools use.
- `src/memory-panel.tsx`: the Memory panel (opened from the header): saved preferences, add, and delete.
- `src/limits.ts`: upload size and column limits, shared by the Worker and the browser (kept apart so the browser does not bundle the parser).
- `vitest.config.ts`: unit test config. Tests sit next to the code as `*.test.ts` and run in Node.
- `wrangler.jsonc`: bindings and Worker config.

## Main flows

A few steps per flow, once it exists.

- **Upload and profile:** browser (user ID from local storage) `POST /agents/cobbler-agent/{userId}/upload?name=…` -> `CobblerAgent.onRequest` checks size and type -> R2 `{userId}/{datasetId}/v0.csv` -> `datasets` row with status `profiling` -> `ProfileWorkflow` (instance ID = dataset ID) -> `onWorkflowComplete` stores the profile, or `onWorkflowError` stores the error -> state sync tells the browser -> the panel fetches the full profile with the `getProfile` callable.
- **Pipeline edit (tool call):** `addStep` / `updateStep` / `removeStep` / `moveStep` -> load the preview sample (cached, or first 512 KB from R2) -> apply the edit to the stored pipeline -> run all steps on the sample -> refuse if the edited step fails, else save to `pipelines` -> return each step's summary to the LLM.
- **Full run:** the LLM calls `runPipeline` -> the user approves in the chat -> the tool checks the steps on the preview rows -> `startRun` checks the dataset is ready and no run is in progress -> `runs` row (next version, status `running`, a copy of the steps) -> `RunWorkflow` (instance ID = run ID) reads `v0.csv`, runs every step, writes `{userId}/{datasetId}/v{n}.csv` -> `onWorkflowComplete` stores the report, or `onWorkflowError` stores the error -> state sync shows the latest run per dataset.
- **Download:** browser `GET /agents/cobbler-agent/{userId}/download?run={runId}` -> `CobblerAgent.onRequest` finds a finished run -> streams the file from R2 as an attachment named like `sales-cleaned-v2.csv`.
- **Pipeline edit (panel):** browser -> `editPipelineStep(datasetId, edit)` callable -> zod checks the dataset ID and the edit -> the same flow as a tool edit -> the save bumps `pipelineUpdatedAt` in synced state -> every open panel reloads its view with `getPipelineView`. Chat edits reach the panel the same way.
- **Import and reuse:** panel `importPipeline(datasetId, text, mapping?)` or the `loadPipeline` tool -> `parsePipelineFile` (import only) -> `replacePipeline` finds missing columns -> if any are unmapped, return them so the user can map or remove them -> apply the mapping, build new steps, check them on the sample -> save.
- **Profile ready:** `onWorkflowComplete` also creates the dataset's pipeline with the safe steps the profile calls for.
- **Chat message:** browser -> WebSocket -> `CobblerAgent.onChatMessage` (system prompt with the user's preferences; old results of large tools pruned) -> Workers AI (streamed, through the stream fix) -> tool calls if needed -> reply streamed back. Messages persist in the agent's SQLite storage.
