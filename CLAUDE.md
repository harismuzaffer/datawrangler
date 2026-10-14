# Datawrangler

Chat agent that cleans and reshapes messy CSV data. Built on Cloudflare: Agents SDK (`AIChatAgent`), Workers AI, Workflows, Durable Objects. TypeScript. Started from `cloudflare/agents-starter`.

Read `docs/progress.md` first, then the docs the goal touches. If `docs/progress.md`, it means that nothing has been done yet.

## Workflow

- Do not build anything without an explicit goal from the user.
- Build only what the goal needs. No speculative features.
- If a goal is unclear or conflicts with the docs, ask before writing code.
- Work in small steps. Each step is one logical commit. A goal can span several steps; finish and commit one before starting the next.
- Before committing, run the type check, lint, and tests (see `package.json` scripts). Commit only when all pass. Never commit a broken step.
- Commit with the repository git identity. Message: one line, imperative, no body, no trailer, no co-author line.
- **Never run `git push`, `npm run deploy`, or `wrangler deploy`.** Never create branches, tags, pull requests, or Cloudflare resources unless the user asks.
- At the end of each step, give the commit message, the files added or changed, and one line per change on what it does.
- In the chat, do not be too verbose, respond to the point and direct in plain human like english, explain terms only when they are new or definitely need an explanation.

## Cloudflare

- Cloudflare APIs change often. Check the current docs (developers.cloudflare.com/agents, /workers-ai, /workflows) before using an API you are not sure of. Do not guess method names or config keys.
- Add every new binding (AI, Durable Object, Workflow, R2, D1) to `wrangler.jsonc` in the same step, then run `npx wrangler types` to regenerate `Env`.
- A new Durable Object class needs a migration entry. Never rename or remove a Durable Object class without asking: its stored data is lost.
- Secrets go in `.dev.vars` locally and `wrangler secret put` in production. Never commit, log, or print them.
- Treat CSV content and LLM output as untrusted. Validate tool inputs with zod. Never execute generated code.

## Code

- Follow `docs/code.md`. Update it in the same step when structure, main modules, or main flows change.
- Never reference docs from code: no file names, section numbers, or decision IDs. Write the reason in plain words.

## Tests

- Use Vitest. Test only logic with real risk: CSV parsing, issue detection, cleaning transforms, workflow step idempotency, tool input validation.
- Do not test UI glue or unchanged starter code.
- When behavior changes or a bug is fixed, update the related tests. Add a new test for a bug only if it could come back.
- Check by hand in `npm run dev` when a goal reaches something a user can see, or when a change is risky.

## Documentation

- Document in the same step as the code. Plain, short English.
- Do not repeat what is already documented; link to it.
- Revise, do not only append. Delete or rewrite out-of-date text.
- Doc files you will strictly maintain:
  - `README.md`: what it does, architecture, setup, run, deploy, links to docs. Reviewers read it first. The default `README.md` comes from the Cloudflare template. If this is the first time you touching `README.md`, feel free to overhaul and update it for our application.
  - `PROMPTS.md`: Prompt history - For each step, append the user's prompt verbatim with datetime.
  - `docs/code.md`: code conventions, structure, main modules and flows.
  - `docs/decisions.md`: decisions with reasons, known limitations, open questions.
  - `docs/progress.md`: what is done, what is next, what is not started. Read it first.
- Add a new doc file only when no current file fits, and add it to this list.
