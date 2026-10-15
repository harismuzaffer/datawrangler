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

- `src/server.ts`: Worker entry and `CobblerAgent`: chat loop, LLM call and tools, upload route, `datasets` table, synced state, workflow callbacks.
- `src/prompts.ts`: system prompt.
- `src/upload.ts`: upload checks: body size limit while reading, binary-file check, file name and user ID schemas.
- `src/profile-workflow.ts`: `ProfileWorkflow`: reads a CSV from R2, profiles it, reports the profile to the agent.
- `src/profile-summary.ts`: shrinks a profile to fit the LLM's context.
- `src/ai-binding.ts`: wraps the Workers AI binding to fix duplicated fields in streamed responses (a provider bug).
- `src/csv.ts`: decodes file bytes (BOM, UTF-8, UTF-16, Windows-1252 fallback) and parses CSV with Papa Parse (delimiter detection, quoted fields).
- `src/profile.ts`: builds a dataset profile from parsed rows: column types, counts, samples, and detected issues.
- `src/table.ts`: the `Table` the pipeline works on (unique column names, padded rows) and number helpers.
- `src/transforms/`: one file per transform group (`text`, `values`, `rows`, `columns`). `core.ts` has the step context that looks up columns and records changes; `index.ts` is the registry of all transforms.
- `src/app.tsx`: chat UI: per-browser user ID, CSV upload (button and drag and drop), profile panel, messages.
- `src/profile-panel.tsx`: shows the latest upload's status, file issues, and a table of columns with types, counts, and issues.
- `src/limits.ts`: upload size and column limits, shared by the Worker and the browser (kept apart so the browser does not bundle the parser).
- `vitest.config.ts`: unit test config. Tests sit next to the code as `*.test.ts` and run in Node.
- `wrangler.jsonc`: bindings and Worker config.

## Main flows

A few steps per flow, once it exists.

- **Upload and profile:** browser (user ID from local storage) `POST /agents/cobbler-agent/{userId}/upload?name=…` -> `CobblerAgent.onRequest` checks size and type -> R2 `{userId}/{datasetId}/v0.csv` -> `datasets` row with status `profiling` -> `ProfileWorkflow` (instance ID = dataset ID) -> `onWorkflowComplete` stores the profile, or `onWorkflowError` stores the error -> state sync tells the browser -> the panel fetches the full profile with the `getProfile` callable.
- **Chat message:** browser -> WebSocket -> `CobblerAgent.onChatMessage` -> Workers AI (streamed, through the stream fix) -> tool calls if needed (`getProfile` reads the latest profile from SQLite) -> reply streamed back. Messages persist in the agent's SQLite storage.
