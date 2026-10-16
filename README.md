# DataCobbler

A chat agent that cleans and reshapes messy CSV files. You upload a CSV and chat with the agent. It finds problems such as extra spaces, mixed date formats, empty rows, and duplicates, and builds a **pipeline**: an ordered list of cleaning steps. You can edit, reorder, and preview the steps, then run the pipeline to get a cleaned CSV. Pipelines are saved so you can reuse them on other files.

Built on Cloudflare: [Agents SDK](https://developers.cloudflare.com/agents/) (`AIChatAgent`), [Workers AI](https://developers.cloudflare.com/workers-ai/), [Workflows](https://developers.cloudflare.com/workflows/), Durable Objects, and R2.

> **Status:** early. Upload a CSV, see its columns, types, and issues, and ask the agent to add, change, reorder, or preview cleaning steps. Ask for the cleaned file, approve the run in the chat, and download the result from the panel. A pipeline panel, pipeline export and import, and memory are not built yet. See [docs/progress.md](docs/progress.md).

## Architecture

```
Browser (React chat UI)
   │ WebSocket (chat)                 │ HTTP (upload / download)
   ▼                                  ▼
Worker entry ───────────────────► R2 (CSV files)
   │                                  ▲
   ▼                                  │
CobblerAgent (Durable Object, SQLite) │
   │  ▲  start / result               │
   │  └──── ProfileWorkflow, RunWorkflow (Workflows)
   ▼
Workers AI (LLM)
```

- **CobblerAgent:** one per user. Holds chat history, datasets, pipelines, and user preferences. Calls the LLM.
- **Workers AI:** reads a summary of the data, explains problems, and builds pipeline steps from a fixed set of transforms. It never runs code.
- **ProfileWorkflow and RunWorkflow:** profile an uploaded file, and run a pipeline on the whole file, with durable, retryable steps.
- **R2:** stores the raw and cleaned CSV files. Each version is kept, so you can go back.

Details and reasons: [docs/decisions.md](docs/decisions.md).

## Setup

Requirements: Node.js 22 or later and a Cloudflare account. The free plan is enough.

```bash
npm install
npx wrangler login
```

You must log in because Workers AI has no local simulator. `npm run dev` calls the real Workers AI on your account and uses its quota. Instead of `wrangler login`, you can set `CLOUDFLARE_API_TOKEN`.

## Run

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

| Command         | What it does                                          |
| --------------- | ----------------------------------------------------- |
| `npm run dev`   | Start the app locally                                 |
| `npm test`      | Run unit tests (Vitest)                               |
| `npm run check` | Format check, lint, and type check                    |
| `npm run types` | Regenerate `env.d.ts` after changing `wrangler.jsonc` |

## Deploy

1. Create the R2 bucket (first deploy only):

   ```bash
   npx wrangler r2 bucket create datacobbler-files
   ```

2. Build and deploy the Worker:

   ```bash
   npm run deploy
   ```

Parsing a 5 MB file needs about 1 s of CPU, so large uploads need the Workers Paid plan. See [docs/decisions.md](docs/decisions.md#risks-and-limitations).

## Docs

- [docs/progress.md](docs/progress.md): what is done and what is next
- [docs/decisions.md](docs/decisions.md): design decisions, transforms, risks
- [docs/code.md](docs/code.md): code conventions, structure, main flows
- [PROMPTS.md](PROMPTS.md): prompt history

## License

MIT. See [LICENSE](LICENSE). Started from the [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter) template.
