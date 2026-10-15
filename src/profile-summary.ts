import type { DatasetProfile, Issue } from "./profile";

// The model's context window is small, so the profile sent to it has a size budget.
const MAX_CHARS = 12_000;

interface LlmIssue {
  code: string;
  message: string;
  count: number;
  rows?: number[];
  examples?: string[];
}

function toLlmIssue(issue: Issue): LlmIssue {
  return {
    code: issue.code,
    message: issue.message,
    count: issue.count,
    ...(issue.rows.length > 0 ? { rows: issue.rows } : {}),
    ...(issue.examples.length > 0 ? { examples: issue.examples } : {})
  };
}

/**
 * Returns a compact version of a profile for the LLM.
 * Columns with issues keep their details; clean columns keep only name and type.
 * If it is still too large, later columns are left out and the result says how many.
 */
export function profileForLlm(profile: DatasetProfile) {
  const columns = profile.columns.map((column) =>
    column.issues.length > 0
      ? {
          name: column.name,
          type: column.type,
          filled: column.filled,
          empty: column.empty,
          distinct: column.distinct,
          samples: column.samples.slice(0, 3),
          issues: column.issues.map(toLlmIssue)
        }
      : { name: column.name, type: column.type }
  );

  const summary = {
    rows: profile.rowCount,
    columns: profile.columnCount,
    delimiter: profile.delimiter,
    encoding: profile.encoding,
    fileIssues: profile.issues.map(toLlmIssue),
    sampleRows: profile.sampleRows.slice(0, 3),
    columnDetails: columns,
    columnsNotShown: 0
  };

  while (
    JSON.stringify(summary).length > MAX_CHARS &&
    summary.columnDetails.length > 1
  ) {
    summary.columnDetails = summary.columnDetails.slice(
      0,
      Math.floor(summary.columnDetails.length * 0.8)
    );
    summary.columnsNotShown = columns.length - summary.columnDetails.length;
  }
  if (JSON.stringify(summary).length > MAX_CHARS) summary.sampleRows = [];
  return summary;
}
