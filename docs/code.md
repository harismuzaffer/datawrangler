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

- `src/server.ts`: Worker entry and `CobblerAgent` (chat loop, LLM call, tools).
- `src/prompts.ts`: system prompt (and later the tool definitions).
- `src/ai-binding.ts`: wraps the Workers AI binding to fix duplicated fields in streamed responses (a provider bug).
- `src/csv.ts`: decodes file bytes (BOM, UTF-8, UTF-16, Windows-1252 fallback) and parses CSV with Papa Parse (delimiter detection, quoted fields).
- `src/profile.ts`: builds a dataset profile from parsed rows: column types, counts, samples, and detected issues.
- `src/app.tsx`: chat UI.
- `vitest.config.ts`: unit test config. Tests sit next to the code as `*.test.ts` and run in Node.
- `wrangler.jsonc`: bindings and Worker config.

## Main flows

A few steps per flow, once it exists.

- **Chat message:** browser -> WebSocket -> `CobblerAgent.onChatMessage` -> Workers AI (streamed, through the stream fix) -> tool calls if needed -> reply streamed back. Messages persist in the agent's SQLite storage.
