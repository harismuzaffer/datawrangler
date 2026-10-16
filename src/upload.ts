import { z } from "zod";
import { MAX_CSV_BYTES } from "./limits";

/** Thrown when an upload is refused. The message is safe to show to the user; `status` is the HTTP status to return. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** File name sent by the browser. It is only shown to the user, never used in a storage key. */
export const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((name) => !/\p{Cc}/u.test(name), "File name has control characters");

/** Agent instance names are user IDs from the browser. They become part of R2 keys, so keep them plain. */
export const userIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/**
 * Reads a request body, stopping as soon as it grows past `maxBytes`.
 * The Content-Length header can be missing or wrong, so the real byte count is what decides.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes = MAX_CSV_BYTES
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes) throw tooLarge(maxBytes);
  if (!request.body) throw new UploadError("The file is empty.", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  if (total === 0) throw new UploadError("The file is empty.", 400);

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function tooLarge(maxBytes: number): UploadError {
  return new UploadError(
    `The file is larger than ${maxBytes / (1024 * 1024)} MB.`,
    413
  );
}

/**
 * Rejects files that are clearly not text, such as Excel workbooks or images.
 * Text files have no zero bytes, except UTF-16, which starts with a byte order mark.
 */
export function assertLooksLikeText(bytes: Uint8Array): void {
  const utf16 =
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (utf16) return;
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) {
    throw new UploadError(
      "This does not look like a CSV file. If it is an Excel file, save it as CSV first.",
      415
    );
  }
}
