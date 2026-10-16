// Kept apart from the parser so the browser can import the limits without bundling it.

/** Largest CSV a user can upload, in bytes. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** Most columns we profile. Wider files are rejected so the profile stays small. */
export const MAX_COLUMNS = 500;

/** Largest pipeline file accepted for import. A full pipeline of 100 steps is far smaller. */
export const MAX_PIPELINE_FILE_BYTES = 256 * 1024;
