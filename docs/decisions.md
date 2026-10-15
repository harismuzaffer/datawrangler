# Decisions

Decisions with reasons, known limitations, and open questions. Rewrite entries when they change.

## Architecture

- **Components.** Chat UI (React) → Worker entry → one agent per user (`AIChatAgent`, a Durable Object with SQLite) → Workers AI. A Workflow does parsing and full pipeline runs. R2 stores CSV bytes.
  Reason: the agent holds conversation and state; the Workflow gives durable, retryable steps for heavy work.
- **The agent is the source of truth.** It stores chat history, datasets and their profiles, pipelines, user preferences (memory), and the status of each workflow run. The Workflow does the work and reports back to the agent.
- **Bytes live only in R2.** Workflow step outputs, agent storage, and WebSocket messages carry R2 keys and small summaries, never file contents.
  Reason: all three have small size limits.
- **Every dataset version is immutable** (`{user}/{dataset}/v0.csv`, `v1.csv`, ...). This gives undo for free.
- **One agent per user,** not one per dataset. Reason: memory and pipelines are shared across all of a user's datasets.
- **CSV in, CSV out.** No other formats in v1.
- **Max upload: 5 MB.** At this size a full run fits in Worker memory.

## Data flow

1. Upload: the Worker writes the file to R2, and the agent records the dataset.
2. Profile: the Workflow parses the file and returns a summary (columns, types, null and distinct counts, sample rows, detected issues).
3. Plan: the LLM reads the profile, never the full file, and builds a pipeline with tools. Safe steps are added automatically.
4. Edit and preview: the user changes steps in the UI or in chat. Preview runs in the agent on a sample.
5. Run: after the user confirms, the Workflow runs the pipeline on the full file and writes a new version to R2. The agent posts a summary.
6. Download: the Worker streams the file from R2.

## Pipelines

- **Terms.** A _pipeline_ is an ordered list of _steps_. A step is one _transform_ with its parameters.
- **Storage.** Pipelines belong to the user and are stored in the agent's own table, not in chat messages. Clearing chat history does not delete them. Each output version stores a snapshot of the pipeline that produced it.
- **Export and import** as JSON with a `format` and a `version` field. An imported file is validated with zod like any other untrusted input. Before running a pipeline on a new CSV, check that every column it uses exists, and ask the user to map or remove the missing ones.
- **Editing.** The user can add, edit, remove, and reorder steps in the UI (direct calls to the agent, no LLM) or in chat (LLM tools).
- **Preview** runs on the first 200 rows. Steps that depend on the whole file (dedupe, window transforms) are labeled "sample only".
- **Run** always needs user confirmation. Only safe steps are added without asking, and the user can still remove them.

## Transforms (v1)

Fixed operations with parameters. No formula language, no regex, no generated code. ✅ = safe, added automatically.

- **Text:** ✅ trim whitespace, ✅ collapse repeated spaces, ✅ remove invisible characters (BOM, zero-width, control), change case, find and replace (plain text).
- **Missing values:** standardize null markers (`N/A`, `-`, `null` → empty; not safe because "NA" can be real data), fill with a constant, fill down.
- **Types and formats:** parse dates to ISO 8601 from a given format, normalize numbers (thousands separators, currency symbols, decimal comma), normalize booleans, map values.
- **Rows:** ✅ drop fully empty rows, remove duplicates (all columns or key columns), drop rows where a column is empty, filter by a simple condition (column, operator, value).
- **Columns:** rename, drop, reorder, split on a delimiter, merge with a separator, use row N as header, skip leading rows.
- **Math:** column ⊕ column or constant (`+ − × ÷`), round/floor/ceil, absolute value, clamp, scale. Non-numeric cells and division by zero give an empty cell and are counted. Output is rounded to a fixed number of decimals by default.
- **Window** (optional group-by and order-by): row number, rank, running total, lag/lead, difference from previous row, moving average over N rows, percent of group total. Sorting is stable so results repeat.

Left out of v1: regex (a bad pattern can lock the CPU), formulas or computed columns (too close to running generated code), joins, pivots, aggregations.

## LLM tools

About 9 tools, grouped by action on the pipeline, not one per transform.
Reason: every tool definition goes into each prompt, and open models choose tools worse when the list is long or the schemas are large.

`getProfile`, `addStep`, `updateStep`, `removeStep`, `moveStep`, `previewPipeline`, `runPipeline` (needs user confirmation), `loadPipeline`, `rememberPreference`.

- `addStep` takes `{ op, params, position? }`. `op` is an enum of transform names. The system prompt holds a one-line catalog of the transforms.
- The server validates `params` with the zod schema for that `op`. On failure, it returns the exact error so the LLM can retry.
- Export, import, and download are UI buttons only.

## Model and streaming workaround

- **Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Reason: it works on the free plan. The starter's Kimi model needs a paid plan.
- **Stream fix (`src/ai-binding.ts`).** `workers-ai-provider` (3.3.1, and still in 4.0.0) duplicates text and tool-call arguments when streaming from models that send each chunk in both OpenAI and native Workers AI formats (Llama, Qwen, Mistral). Tool calls then fail to parse, and the model never answers. We wrap the AI binding and drop the native copies when the OpenAI-style delta is present. Other chunks pass through unchanged, so any model can be used. Tested by hand with Llama 3.3, Llama 4 Scout, Qwen3, Mistral Small 3.1, gpt-oss-120b, and GLM-4.7-flash.
- **Remove the fix** when the provider reads only one format. To check: remove the wrapper and ask the agent for the weather with a Llama model.

## Risks and limitations

- **Prompt injection through CSV cells.** The LLM sees only the profile and samples, marked as data. Its output is limited to validated steps from a closed list.
- **Tool calling on Workers AI models can be unreliable.** Detection is done by code, schemas are kept small, and validation errors are sent back for a retry.
- **CSV edge cases:** BOM, non-UTF-8 encodings, `;` delimiters, quoted newlines, ragged rows. Use a proven parser.
- **Workflow steps can retry.** Each step writes to a fixed R2 key. The agent ignores duplicate reports from the same run and step.
- **No auth.** The user is a random ID kept in the browser. If the browser data is cleared, the user loses access to their data. Pipeline export reduces the impact. Old uploads need an R2 lifecycle rule.
- **Durable Object class rename.** Rename the starter `ChatAgent` before any real data exists. A later rename loses stored data.
- **Dev costs.** The AI binding uses `"remote": true`, so `npm run dev` calls real Workers AI and uses account quota.

## Open questions

- Exact platform limits (workflow step output, SQLite row size, WebSocket message size). Check the current docs before building upload and workflow code.
- The current API of the Agents SDK workflow integration.
