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
import { emptyPipeline, safePipeline, type Pipeline } from "./pipeline";
import type { DatasetProfile } from "./profile";
import type { ProfileParams } from "./profile-workflow";
import { SYSTEM_PROMPT } from "./prompts";
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

export type DatasetStatus = "profiling" | "ready" | "failed";

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
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
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

  async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: unknown
  ) {
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
    _workflowName: string,
    workflowId: string,
    error: string
  ) {
    // The workflow marks only user-facing messages as non-retryable; anything else is an internal error.
    const userMessage = /^NonRetryableError: (.+)$/s.exec(error)?.[1];
    if (!userMessage)
      console.error("Profile workflow failed:", workflowId, error);
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
        createdAt: row.created_at
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
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
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
