import { z } from "zod";

/** Most preferences a user can keep. Every one goes into each chat request, so the list stays short. */
export const MAX_PREFERENCES = 30;

/** A preference is one short sentence, such as "My dates are day first (DD/MM/YYYY)". */
export const preferenceTextSchema = z
  .string()
  .trim()
  .min(3, "A preference needs at least 3 characters.")
  .max(300, "A preference can have at most 300 characters.")
  .refine(
    (text) => !/\p{Cc}/u.test(text),
    "A preference cannot have line breaks or control characters."
  );

export interface Preference {
  id: string;
  text: string;
  createdAt: number;
}

/** What the memory tools need from the agent. */
export interface MemoryHost {
  preferences(): Preference[];
  /** Saves a preference, or returns the same one if it is already saved. */
  addPreference(text: string): Preference | { error: string };
  removePreference(id: string): boolean;
}
