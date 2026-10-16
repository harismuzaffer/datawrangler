import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import { CsvError, decodeCsvBytes, parseCsv, writeCsv } from "./csv";
import { PipelineError, runPipeline, type Step } from "./pipeline";
import type { CobblerAgent } from "./server";
import { tableFromRecords } from "./table";

export interface RunParams {
  inputKey: string;
  outputKey: string;
  /** The steps as they were when the user started the run; later edits do not change it. */
  steps: Step[];
}

/** Runs a pipeline on a whole uploaded file, writes the result as a new file in R2, and reports back to the agent. */
export class RunWorkflow extends AgentWorkflow<
  CobblerAgent,
  RunParams,
  unknown,
  Env
> {
  async run(event: AgentWorkflowEvent<RunParams>, step: AgentWorkflowStep) {
    const { inputKey, outputKey, steps } = event.payload;

    // Reads one fixed key and writes another, so a retry writes the same file again.
    const report = await step.do("run", async () => {
      const object = await this.env.FILES.get(inputKey);
      if (!object) throw new NonRetryableError("The uploaded file is missing.");
      try {
        const decoded = decodeCsvBytes(
          new Uint8Array(await object.arrayBuffer())
        );
        const { table, report } = runPipeline(
          tableFromRecords(parseCsv(decoded.text).rows),
          steps
        );
        await this.env.FILES.put(outputKey, writeCsv(table), {
          httpMetadata: { contentType: "text/csv; charset=utf-8" }
        });
        return report;
      } catch (error) {
        // The same file and steps fail the same way every time; retrying would only waste time.
        if (error instanceof CsvError || error instanceof PipelineError)
          throw new NonRetryableError(error.message);
        throw error;
      }
    });

    await step.reportComplete(report);
  }
}
