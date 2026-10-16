import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Connection } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import { withStreamFix } from "./ai-binding";
import { parseSample, SAMPLE_BYTES } from "./csv";
import { cleanedFileName, contentDisposition } from "./download";
import {
  emptyPipeline,
  safePipeline,
  type Pipeline,
  type RunReport
} from "./pipeline";
import type { DatasetProfile } from "./profile";
import type { ProfileParams } from "./profile-workflow";
import type { RunParams } from "./run-workflow";
import { SYSTEM_PROMPT } from "./prompts";
import { z } from "zod";
import { tableFromRecords, type Table } from "./table";
import { createTools, type ToolHost } from "./tools";
import {
  assertLooksLikeText,
  fileNameSchema,
  readBodyWithLimit,
  UploadError,
  userIdSchema
} from "./upload";

export { ProfileWorkflow } from "./profile-workflow";
export { RunWorkflow } from "./run-workflow";

export type DatasetStatus = "profiling" | "ready" | "failed";
export type RunStatus = "running" | "done" | "failed";

/** What the browser sees about the latest full run of a dataset. */
export interface RunSummary {
  id: string;
  version: number;
  status: RunStatus;
  error: string | null;
  rowCount: number | null;
  columnCount: number | null;
}

/** What the browser sees about one uploaded file. The full profile is fetched separately because it can be large. */
export interface DatasetSummary {
  id: string;
  name: string;
  size: number;
  status: DatasetStatus;
  error: string | null;
  rowCount: number | null;
  columnCount: number | null;
  issueCount: number | null;
  createdAt: number;
  latestRun: RunSummary | null;
}

/** Agent state, synced to every connected browser. */
export interface AgentState {
  datasets: DatasetSummary[];
}

type DatasetRow = {
  id: string;
  name: string;
  size: number;
  r2_key: string;
  status: DatasetStatus;
  error: string | null;
  profile: string | null;
  created_at: number;
};

type PipelineRow = { steps: string; next_step_number: number };

type RunRow = {
  id: string;
  dataset_id: string;
  version: number;
  status: RunStatus;
  r2_key: string;
  report: string | null;
  error: string | null;
};

const runIdSchema = z.uuid();

function countIssues(profile: DatasetProfile): number {
  return (
    profile.issues.length +
    profile.columns.reduce((sum, column) => sum + column.issues.length, 0)
  );
}

/** One chat agent per user. Chat history and datasets persist in the agent's SQLite storage. */
export class CobblerAgent
  extends AIChatAgent<Env, AgentState>
  implements ToolHost
{
  initialState: AgentState = { datasets: [] };
  /** Preview samples by dataset ID. Files never change after upload, so a sample stays valid while the agent is awake. */
  private samples = new Map<string, { table: Table; partial: boolean }>();
  maxPersistedMessages = 100;
  chatRecovery = true;

  // State mirrors the datasets table, so only the agent may change it, never a browser.
  validateStateChange(_nextState: AgentState, source: Connection | "server") {
    if (source !== "server") throw new Error("State is read-only for clients.");
  }

  async onStart() {
    this.sql`create table if not exists datasets (
      id text primary key,
      name text not null,
      size integer not null,
      r2_key text not null,
      status text not null,
      error text,
      profile text,
      created_at integer not null
    )`;
    // One pipeline per dataset for now. It has its own ID so saved, reusable pipelines can be added later.
    this.sql`create table if not exists pipelines (
      id text primary key,
      dataset_id text not null unique,
      steps text not null,
      next_step_number integer not null,
      updated_at integer not null
    )`;
    // Each full run writes a new file version; `steps` keeps the pipeline that made it.
    this.sql`create table if not exists runs (
      id text primary key,
      dataset_id text not null,
      version integer not null,
      status text not null,
      steps text not null,
      r2_key text not null,
      report text,
      error text,
      created_at integer not null,
      finished_at integer,
      unique (dataset_id, version)
    )`;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/download"))
      return this.download(url);
    if (request.method === "POST" && url.pathname.endsWith("/upload")) {
      try {
        return Response.json(await this.upload(request, url));
      } catch (error) {
        if (error instanceof UploadError)
          return Response.json(
            { error: error.message },
            { status: error.status }
          );
        throw error;
      }
    }
    return new Response("Not found", { status: 404 });
  }

  /** Stores an uploaded CSV in R2 and starts profiling it. */
  private async upload(request: Request, url: URL) {
    if (!userIdSchema.safeParse(this.name).success)
      throw new UploadError("Invalid user.", 400);
    const fileName = fileNameSchema.safeParse(url.searchParams.get("name"));
    if (!fileName.success) throw new UploadError("Invalid file name.", 400);

    const bytes = await readBodyWithLimit(request);
    assertLooksLikeText(bytes);

    const id = crypto.randomUUID();
    const r2Key = `${this.name}/${id}/v0.csv`;
    await this.env.FILES.put(r2Key, bytes, {
      httpMetadata: { contentType: "text/csv" }
    });
    this.sql`insert into datasets (id, name, size, r2_key, status, created_at)
      values (${id}, ${fileName.data}, ${bytes.byteLength}, ${r2Key}, 'profiling', ${Date.now()})`;
    this.syncState();

    try {
      // Use the dataset ID as the workflow ID, so callbacks can find the dataset without a lookup table.
      await this.runWorkflow<ProfileParams>(
        "PROFILE_WORKFLOW",
        { datasetId: id, r2Key },
        { id }
      );
    } catch (error) {
      this.markFailed(
        id,
        "Could not start reading the file. Please try again."
      );
      throw error;
    }
    return { id };
  }

  /** Sends the file a finished run wrote, as an attachment. */
  private async download(url: URL): Promise<Response> {
    const runId = runIdSchema.safeParse(url.searchParams.get("run"));
    if (!runId.success) return new Response("Invalid run.", { status: 400 });
    const [run] = this.sql<RunRow & { name: string }>`
      select runs.*, datasets.name from runs join datasets on datasets.id = runs.dataset_id
      where runs.id = ${runId.data} and runs.status = 'done'`;
    if (!run) return new Response("Not found", { status: 404 });
    const object = await this.env.FILES.get(run.r2_key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": String(object.size),
        "Content-Disposition": contentDisposition(
          cleanedFileName(run.name, run.version)
        ),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }

  /**
   * Starts a full run of the dataset's current pipeline. The result becomes the next file version.
   * Returns a message instead when the run cannot start, for the LLM or the UI to show.
   */
  async startRun(
    datasetId: string
  ): Promise<{ runId: string; version: number } | { error: string }> {
    const [dataset] = this
      .sql<DatasetRow>`select * from datasets where id = ${datasetId}`;
    if (dataset?.status !== "ready")
      return { error: "The file is not ready to run yet." };
    const [running] = this
      .sql<RunRow>`select id from runs where dataset_id = ${datasetId} and status = 'running'`;
    if (running) return { error: "A run of this file is already in progress." };

    // No await between reading the last version and inserting the new one, so two runs cannot get the same version.
    const [{ last }] = this.sql<{
      last: number | null;
    }>`select max(version) as last from runs where dataset_id = ${datasetId}`;
    const version = (last ?? 0) + 1;
    const runId = crypto.randomUUID();
    const outputKey = `${this.name}/${datasetId}/v${version}.csv`;
    const { steps } = this.loadPipeline(datasetId);
    this
      .sql`insert into runs (id, dataset_id, version, status, steps, r2_key, created_at)
      values (${runId}, ${datasetId}, ${version}, 'running', ${JSON.stringify(steps)}, ${outputKey}, ${Date.now()})`;
    this.syncState();

    try {
      await this.runWorkflow<RunParams>(
        "RUN_WORKFLOW",
        { inputKey: dataset.r2_key, outputKey, steps },
        { id: runId }
      );
    } catch (error) {
      console.error("Could not start run:", runId, error);
      this.finishRun(runId, {
        error: "Could not start the run. Please try again."
      });
      return { error: "Could not start the run. Please try again." };
    }
    return { runId, version };
  }

  /** Records the end of a run. Only a run still marked running changes, so a repeated callback changes nothing. */
  private finishRun(
    runId: string,
    outcome: { report: RunReport } | { error: string }
  ) {
    if ("report" in outcome)
      this
        .sql`update runs set status = 'done', report = ${JSON.stringify(outcome.report)}, finished_at = ${Date.now()}
        where id = ${runId} and status = 'running'`;
    else
      this
        .sql`update runs set status = 'failed', error = ${outcome.error}, finished_at = ${Date.now()}
        where id = ${runId} and status = 'running'`;
    this.syncState();
  }

  async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown
  ) {
    if (workflowName === "RUN_WORKFLOW") {
      this.finishRun(workflowId, { report: result as RunReport });
      return;
    }
    const profile = result as DatasetProfile;
    // Only a dataset still being profiled is updated, so a repeated callback changes nothing.
    this
      .sql`update datasets set status = 'ready', profile = ${JSON.stringify(profile)}, error = null
      where id = ${workflowId} and status = 'profiling'`;
    const pipeline = safePipeline(profile);
    this
      .sql`insert or ignore into pipelines (id, dataset_id, steps, next_step_number, updated_at)
      values (${crypto.randomUUID()}, ${workflowId}, ${JSON.stringify(pipeline.steps)}, ${pipeline.nextStepNumber}, ${Date.now()})`;
    this.syncState();
  }

  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string
  ) {
    // The workflows mark only user-facing messages as non-retryable; anything else is an internal error.
    const userMessage = /^NonRetryableError: (.+)$/s.exec(error)?.[1];
    if (!userMessage)
      console.error("Workflow failed:", workflowName, workflowId, error);
    if (workflowName === "RUN_WORKFLOW") {
      this.finishRun(workflowId, {
        error:
          userMessage ??
          "Something went wrong while running the pipeline. Please try again."
      });
      return;
    }
    this.markFailed(
      workflowId,
      userMessage ??
        "Something went wrong while reading the file. Please try again."
    );
  }

  private markFailed(id: string, error: string) {
    this
      .sql`update datasets set status = 'failed', error = ${error} where id = ${id} and status = 'profiling'`;
    this.syncState();
  }

  /** Rebuilds the dataset list in the synced state from SQLite. */
  private syncState() {
    const rows = this
      .sql<DatasetRow>`select id, name, size, status, error, profile, created_at
      from datasets order by created_at desc`;
    const latestRuns = new Map<string, RunSummary>();
    // Newest first, so the first run seen for a dataset is its latest.
    for (const run of this
      .sql<RunRow>`select id, dataset_id, version, status, report, error from runs order by version desc`) {
      if (latestRuns.has(run.dataset_id)) continue;
      const report = run.report ? (JSON.parse(run.report) as RunReport) : null;
      latestRuns.set(run.dataset_id, {
        id: run.id,
        version: run.version,
        status: run.status,
        error: run.error,
        rowCount: report?.rowCount ?? null,
        columnCount: report?.columnCount ?? null
      });
    }
    const datasets = rows.map((row): DatasetSummary => {
      const profile = row.profile
        ? (JSON.parse(row.profile) as DatasetProfile)
        : null;
      return {
        id: row.id,
        name: row.name,
        size: row.size,
        status: row.status,
        error: row.error,
        rowCount: profile?.rowCount ?? null,
        columnCount: profile?.columnCount ?? null,
        issueCount: profile ? countIssues(profile) : null,
        createdAt: row.created_at,
        latestRun: latestRuns.get(row.id) ?? null
      };
    });
    this.setState({ ...this.state, datasets });
  }

  latestDataset() {
    const [row] = this
      .sql<DatasetRow>`select * from datasets order by created_at desc limit 1`;
    if (!row) return null;
    const profile = row.profile
      ? (JSON.parse(row.profile) as DatasetProfile)
      : null;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      error: row.error,
      profile
    };
  }

  loadPipeline(datasetId: string): Pipeline {
    const [row] = this
      .sql<PipelineRow>`select steps, next_step_number from pipelines where dataset_id = ${datasetId}`;
    if (!row) return emptyPipeline();
    return {
      steps: JSON.parse(row.steps) as Pipeline["steps"],
      nextStepNumber: row.next_step_number
    };
  }

  savePipeline(datasetId: string, pipeline: Pipeline) {
    this
      .sql`insert into pipelines (id, dataset_id, steps, next_step_number, updated_at)
      values (${crypto.randomUUID()}, ${datasetId}, ${JSON.stringify(pipeline.steps)}, ${pipeline.nextStepNumber}, ${Date.now()})
      on conflict (dataset_id) do update set steps = excluded.steps,
        next_step_number = excluded.next_step_number, updated_at = excluded.updated_at`;
  }

  async loadSample(datasetId: string, profile: DatasetProfile) {
    const cached = this.samples.get(datasetId);
    if (cached) return cached;
    const [row] = this
      .sql<DatasetRow>`select * from datasets where id = ${datasetId}`;
    if (!row) throw new Error(`Dataset ${datasetId} not found`);
    // Only the start of the file is needed, so read a byte range instead of the whole file.
    const object = await this.env.FILES.get(row.r2_key, {
      range: { offset: 0, length: SAMPLE_BYTES }
    });
    if (!object) throw new Error(`File for dataset ${datasetId} is missing`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    const records = parseSample(bytes, {
      encoding: profile.encoding,
      delimiter: profile.delimiter,
      truncated: row.size > bytes.byteLength
    });
    const table = tableFromRecords(records, profile.columnCount);
    const sample = { table, partial: table.rows.length < profile.rowCount };
    this.samples.set(datasetId, sample);
    return sample;
  }

  /** Returns the full profile of a dataset for the UI, or null if it is not ready. */
  @callable()
  getProfile(datasetId: string): DatasetProfile | null {
    const [row] = this
      .sql<DatasetRow>`select profile from datasets where id = ${datasetId}`;
    return row?.profile ? (JSON.parse(row.profile) as DatasetProfile) : null;
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: withStreamFix(this.env.AI) });

    const result = streamText({
      model: workersai("@cf/mistralai/mistral-small-3.1-24b-instruct", {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: createTools(this),
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
