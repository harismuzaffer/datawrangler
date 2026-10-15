import { useEffect, useState } from "react";
import { Badge, Surface, Text } from "@cloudflare/kumo";
import {
  CaretDownIcon,
  CircleNotchIcon,
  FileCsvIcon,
  WarningIcon
} from "@phosphor-icons/react";
import type { ColumnProfile, DatasetProfile, Issue } from "./profile";
import type { DatasetSummary } from "./server";

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function IssueLine({ issue }: { issue: Issue }) {
  const where =
    issue.rows.length > 0
      ? ` Rows: ${issue.rows.join(", ")}${issue.count > issue.rows.length ? ", …" : ""}.`
      : "";
  const examples =
    issue.examples.length > 0
      ? ` Examples: ${issue.examples.map((e) => JSON.stringify(e)).join(", ")}`
      : "";
  return (
    <li className="flex gap-2 text-xs text-kumo-default">
      <WarningIcon size={14} className="text-kumo-warning shrink-0 mt-0.5" />
      <span>
        {issue.message}
        <span className="text-kumo-subtle">
          {where}
          {examples}
        </span>
      </span>
    </li>
  );
}

function ColumnRow({ column }: { column: ColumnProfile }) {
  return (
    <tr className="border-t border-kumo-line align-top">
      <td className="py-1.5 pr-3 font-medium text-kumo-default break-all">
        {column.name}
      </td>
      <td className="py-1.5 pr-3 text-kumo-subtle">{column.type}</td>
      <td className="py-1.5 pr-3 text-kumo-subtle tabular-nums">
        {column.filled} / {column.empty}
      </td>
      <td className="py-1.5 pr-3 text-kumo-subtle tabular-nums">
        {column.distinct}
        {column.distinctCapped ? "+" : ""}
      </td>
      <td className="py-1.5">
        {column.issues.length === 0 ? (
          <span className="text-kumo-subtle">—</span>
        ) : (
          <ul className="space-y-1">
            {column.issues.map((issue) => (
              <IssueLine key={issue.code} issue={issue} />
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

/** Shows the latest upload: its status while it is read, then its columns, types, and detected issues. */
export function ProfilePanel({
  dataset,
  loadProfile
}: {
  dataset: DatasetSummary;
  loadProfile: (datasetId: string) => Promise<DatasetProfile | null>;
}) {
  const [profile, setProfile] = useState<DatasetProfile | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setProfile(null);
    if (dataset.status !== "ready") return;
    let cancelled = false;
    loadProfile(dataset.id)
      .then((result) => {
        if (!cancelled) setProfile(result);
      })
      .catch((error: unknown) =>
        console.error("Could not load profile:", error)
      );
    return () => {
      cancelled = true;
    };
  }, [dataset.id, dataset.status, loadProfile]);

  return (
    <Surface className="rounded-xl ring ring-kumo-line">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <FileCsvIcon size={18} className="text-kumo-brand shrink-0" />
        <Text size="sm" bold>
          <span className="break-all">{dataset.name}</span>
        </Text>
        <Text size="xs" variant="secondary">
          {formatSize(dataset.size)}
          {dataset.rowCount !== null &&
            ` · ${dataset.rowCount} rows · ${dataset.columnCount} columns`}
        </Text>
        <span className="ml-auto flex items-center gap-2">
          {dataset.status === "profiling" && (
            <Badge variant="secondary">
              <CircleNotchIcon size={12} className="mr-1 animate-spin" />
              Reading
            </Badge>
          )}
          {dataset.status === "failed" && (
            <Badge variant="destructive">Could not read</Badge>
          )}
          {dataset.status === "ready" && (
            <Badge variant={dataset.issueCount ? "secondary" : "primary"}>
              {dataset.issueCount
                ? `${dataset.issueCount} issues`
                : "No issues"}
            </Badge>
          )}
          <CaretDownIcon
            size={14}
            className={`text-kumo-inactive transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && dataset.status === "failed" && (
        <div className="px-4 pb-3">
          <Text size="xs" variant="secondary">
            {dataset.error}
          </Text>
        </div>
      )}

      {open && profile && (
        <div className="px-4 pb-4 space-y-3 max-h-80 overflow-auto">
          {profile.issues.length > 0 && (
            <div>
              <Text size="xs" variant="secondary" bold>
                File
              </Text>
              <ul className="mt-1 space-y-1">
                {profile.issues.map((issue) => (
                  <IssueLine key={issue.code} issue={issue} />
                ))}
              </ul>
            </div>
          )}
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-kumo-subtle">
                <th className="pb-1 pr-3 font-medium">Column</th>
                <th className="pb-1 pr-3 font-medium">Type</th>
                <th className="pb-1 pr-3 font-medium">Filled / empty</th>
                <th className="pb-1 pr-3 font-medium">Distinct</th>
                <th className="pb-1 font-medium">Issues</th>
              </tr>
            </thead>
            <tbody>
              {profile.columns.map((column) => (
                <ColumnRow key={column.index} column={column} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Surface>
  );
}
