import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import { CsvError, decodeCsvBytes, parseCsv } from "./csv";
import { profileCsv } from "./profile";
import type { CobblerAgent } from "./server";

export interface ProfileParams {
  datasetId: string;
  r2Key: string;
}

/** Reads an uploaded CSV from R2, profiles it, and reports the profile back to the agent. */
export class ProfileWorkflow extends AgentWorkflow<
  CobblerAgent,
  ProfileParams,
  unknown,
  Env
> {
  async run(event: AgentWorkflowEvent<ProfileParams>, step: AgentWorkflowStep) {
    const { r2Key } = event.payload;

    // Reads a fixed key and has no side effects, so a retry gives the same result.
    const profile = await step.do("profile", async () => {
      const object = await this.env.FILES.get(r2Key);
      if (!object) throw new NonRetryableError("The uploaded file is missing.");
      const decoded = decodeCsvBytes(
        new Uint8Array(await object.arrayBuffer())
      );
      try {
        return profileCsv(parseCsv(decoded.text), decoded);
      } catch (error) {
        // A broken file stays broken; retrying would only waste time.
        if (error instanceof CsvError)
          throw new NonRetryableError(error.message);
        throw error;
      }
    });

    await step.reportComplete(profile);
  }
}
