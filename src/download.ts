/** Name for the cleaned file: the upload's name without its extension, plus the version, like `sales-cleaned-v2.csv`. */
export function cleanedFileName(uploadName: string, version: number): string {
  const base = uploadName.replace(/\.(csv|tsv|txt)$/i, "") || "data";
  return `${base}-cleaned-v${version}.csv`;
}

/**
 * Builds a Content-Disposition header that makes the browser save the file under `fileName`.
 * The name comes from the user, so the plain `filename` keeps only safe ASCII characters (a quote would end it early),
 * and `filename*` carries the full name percent-encoded for browsers that read it.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^A-Za-z0-9._ -]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
