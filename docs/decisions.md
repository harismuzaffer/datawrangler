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

## Naming

- The agent class is `CobblerAgent` and the Worker is `datacobbler`. The starter's `ChatAgent` was renamed with a `renamed_classes` migration, so any stored data moves with it. Wrangler now also offers an `exports` field that replaces `migrations`; the two cannot be mixed, so we keep `migrations` for now.
- Do not rename or remove the Durable Object class again without a migration: its stored data would be lost.

## Model and streaming workaround

- **Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Reason: it works on the free plan. The starter's Kimi model needs a paid plan.
- **Stream fix (`src/ai-binding.ts`).** `workers-ai-provider` (3.3.1, and still in 4.0.0) duplicates text and tool-call arguments when streaming from models that send each chunk in both OpenAI and native Workers AI formats (Llama, Qwen, Mistral). Tool calls then fail to parse, and the model never answers. We wrap the AI binding and drop the native copies when the OpenAI-style delta is present. Other chunks pass through unchanged, so any model can be used. Tested by hand with Llama 3.3, Llama 4 Scout, Qwen3, Mistral Small 3.1, gpt-oss-120b, and GLM-4.7-flash.
- **Remove the fix** when the provider reads only one format. To check: remove the wrapper and ask the agent for the weather with a Llama model.

## CSV parsing and profile

- **Parser:** Papa Parse. It is widely used, pure JavaScript, and handles delimiter detection, quoted fields, and quoted newlines. We decode bytes ourselves first, so encoding handling is the same in the Worker and in tests.
- **Encoding:** BOM first (UTF-8, UTF-16), then strict UTF-8, then Windows-1252. Windows-1252 is the usual encoding of CSVs from older Excel. Both a BOM and a fallback are reported as issues.
- **Header:** row 1 is the header. Row numbers in issues count the header as row 1, like a spreadsheet.
- **Types:** `integer`, `decimal`, `boolean`, `date`, `text`, `empty`. The most common kind of value wins. Empty cells and placeholders such as `N/A` are left out. Stray values are flagged only in non-text columns, because numbers in a name or code column are normal.
- **Issues** are detected by code, never by the LLM. Each has a plain message, a count, up to five row numbers, and up to three examples. Every issue maps to a planned transform. File level: BOM, encoding, quote errors, empty or duplicate column names, ragged rows, empty rows, duplicate rows. Column level: empty column, spaces at the ends, repeated spaces, invisible characters, missing-data placeholders, stray values, formatted numbers, mixed date formats, ambiguous day/month dates, mixed yes/no spellings, mixed letter case.
- **Profile size** is kept small for the workflow (1 MiB step limit) and SQLite (2 MB row limit): values are cut to 60 characters, there are at most 5 samples and 5 sample rows, distinct counts stop at 10,000, and files are limited to 500 columns. A 500-column profile measured 397 KiB.

## Upload and profile flow

- **Agent state is read-only for browsers.** It mirrors the `datasets` table, so `validateStateChange` refuses any update that does not come from the agent.

- **Upload goes through the agent** (`POST /agents/cobbler-agent/{userId}/upload`). The agent already knows the user, so it can store the file and record the dataset in one place. The body is read with a hard 5 MB cap, whatever Content-Length says. Files with zero bytes near the start (Excel, images) are refused before storing.
- **R2 key:** `{userId}/{datasetId}/v0.csv`. The user ID must be letters, digits, and dashes, so it cannot change the path. The file name is only shown, never used in a key.
- **Workflow instance ID = dataset ID.** Callbacks find the dataset directly, and a callback cannot arrive before the ID is stored.
- **Callbacks are idempotent:** they only update a dataset whose status is still `profiling`.
- **Errors:** file problems (missing file, too many columns, empty file) are thrown as `NonRetryableError`, so the workflow does not retry them, and their message is shown to the user. Any other error is logged and the user sees a generic message.
- **Synced state** holds a short summary per dataset (status, counts, error). The full profile can be hundreds of KB, so the UI fetches it with the `getProfile` callable.
- **The LLM gets a compact profile:** clean columns only with name and type, at most 12,000 characters, plus a note that the values are data, not instructions.

## Transform engine

- **Column names are unique and never empty.** Steps refer to columns by name. An empty header becomes `Column N`, and a repeated name becomes `name (2)`. The profile uses the same names. The cleaned file keeps these names. A name that differs only in letter case is still found, if it is the only match.
- **Ragged rows are padded** with empty cells to the widest row when the table is loaded.
- **Each transform** has a zod schema for its parameters, a one-line usage text for the LLM, and `safe` and `wholeFile` flags. It reports cells changed, rows removed, columns added and removed, and cells it could not convert (`failed`), with up to three examples of each.
- **Conversions never guess.** Dates that match none of the given formats, and numbers like `12,5` when the decimal separator is `.`, are left unchanged and counted as failed. Two-digit years are read as 1950–2049.
- **Find and replace is plain text only** (no regex), as decided for v1.
- **Math:** `math` covers add, subtract, multiply, and divide with a constant or another column; scaling and unit conversion use multiply. A cell that is not a plain number, or a division by zero, is counted as failed. In a new column it stays empty; when overwriting, the original value is kept so no data is lost. Rounding uses decimal exponents (1.005 → 1.01) and rounds halves away from zero.
- **Window transforms** write their result in a new column and never move rows. Sorting for `orderBy` is stable; numbers compare as numbers, other values as text, and empty cells sort last. All window transforms and `dedupe` are `wholeFile`, so their preview is marked "sample only".

## Pipeline model

- **Step IDs** are `s1`, `s2`, … from a counter, so a removed step's ID is never reused. Positions in tools are 1-based.
- **Parameters are validated** when a step is added or changed: unknown transform, wrong types, and unknown keys (often a typo) are refused with the transform's usage text, so the LLM can correct itself.
- **`updateStep` merges** the new parameters into the old ones; `null` removes a parameter. An edited automatic step is no longer marked automatic.
- **A run stops at the first failing step.** The steps after it are marked skipped, because they would see a different table.
- **Safe steps** come from the profile, only for the affected columns, in this order: remove invisible characters, trim, collapse spaces, drop empty rows.

## Risks and limitations

- **Prompt injection through CSV cells.** The LLM sees only the profile and samples, marked as data. Its output is limited to validated steps from a closed list.
- **Tool calling on Workers AI models can be unreliable.** Detection is done by code, schemas are kept small, and validation errors are sent back for a retry.
- **CSV edge cases:** BOM, non-UTF-8 encodings, `;` delimiters, quoted newlines, ragged rows. Use a proven parser.
- **Workflow steps can retry.** Each step writes to a fixed R2 key. The agent ignores duplicate reports from the same run and step.
- **No auth.** The user is a random UUID kept in browser storage (`datacobbler-user-id`); it names the user's agent. Anyone who knows the ID can open that agent, including its `get-messages` endpoint. If the browser data is cleared, the user loses access to their data. Pipeline export reduces the impact. Old uploads need an R2 lifecycle rule.
- **CPU time on the free plan.** Parsing and profiling cost about 1 s of CPU for a 5 MB file (measured in Node: 1.3 s for 7 MB, 90,000 rows). Workers Free allows 10 ms of CPU per request and per workflow step, so large files will fail when deployed on the free plan. `npm run dev` does not enforce the limit. Workers Paid allows 30 s by default. Options if this matters: the paid plan, or a much smaller upload limit on free.
- **Dev costs.** The AI binding uses `"remote": true`, so `npm run dev` calls real Workers AI and uses account quota.

## Open questions

- Should the profile panel let the user pick an older upload? Today it and `getProfile` use the latest one.
