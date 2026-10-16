# DataCobbler

A chat agent that cleans and reshapes messy CSV files. You upload a CSV and chat with the agent. It finds problems such as extra spaces, mixed date formats, empty rows, and duplicates, and builds a **pipeline**: an ordered list of cleaning steps. You can edit, reorder, and preview the steps, then run the pipeline to get a cleaned CSV. Pipelines are saved so you can reuse them on other files.

Built on Cloudflare: [Agents SDK](https://developers.cloudflare.com/agents/) (`AIChatAgent`), [Workers AI](https://developers.cloudflare.com/workers-ai/), [Workflows](https://developers.cloudflare.com/workflows/), Durable Objects, and R2.

> **Status:** early. Upload a CSV, see its columns, types, and issues, and build a pipeline of cleaning steps in the chat or in the pipeline panel: add, edit, reorder, remove, and preview steps. Run it on the whole file (the chat asks for approval; the panel asks to confirm) and download the result. Export a pipeline as JSON and import it into another file, or ask the agent to reuse the steps of an earlier upload; missing columns are mapped first. The agent remembers your preferences (such as how your dates are written) after you approve them, and you can see and delete them under Memory. See [docs/progress.md](docs/progress.md).

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

Requirements: Node.js 22 or later and a Cloudflare account. The free plan is enough for local use; a deploy needs Workers Paid (see [Deploy](#deploy)).

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

Requirements: the Workers Paid plan. `wrangler.jsonc` sets `limits.cpu_ms` to 60 s, because profiling a 5 MB file needs about 1 s of CPU and the free plan allows 10 ms. See [docs/decisions.md](docs/decisions.md#risks-and-limitations).

1. Create the R2 bucket (first deploy only):

   ```bash
   npx wrangler r2 bucket create datacobbler-files
   ```

2. Check the build without deploying:

   ```bash
   npx vite build && npx wrangler deploy --dry-run
   ```

   The output lists five bindings: `CobblerAgent`, `PROFILE_WORKFLOW`, `RUN_WORKFLOW`, `FILES`, and `AI`.

3. Build and deploy the Worker:

   ```bash
   npm run deploy
   ```

   Wrangler prints the URL, like `https://datacobbler.<your-subdomain>.workers.dev`.

4. Protect the URL with [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/). The app has no login of its own, so without Access anyone with the URL can use it and your Workers AI quota.
   1. In the Cloudflare dashboard, go to **Workers & Pages** and select `datacobbler`.
   2. Go to **Settings** > **Domains & Routes**.
   3. On the `workers.dev` row, enable **Cloudflare Access**.
   4. Open **Manage Cloudflare Access** and set the policy to allow only your email addresses.
   5. Open the URL in a private window. Check that it asks you to sign in, and that chat, upload, and download work after you sign in.

## Docs

- [docs/progress.md](docs/progress.md): what is done and what is next
- [docs/decisions.md](docs/decisions.md): design decisions, transforms, risks
- [docs/code.md](docs/code.md): code conventions, structure, main flows
- [PROMPTS.md](PROMPTS.md): prompt history

## License

MIT. See [LICENSE](LICENSE). Started from the [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter) template.
