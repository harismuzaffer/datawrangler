import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  EyeIcon,
  FlowArrowIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon
} from "@phosphor-icons/react";
import type {
  PipelineEdit,
  PipelineView,
  TransformInfo
} from "./pipeline-actions";
import type { DatasetSummary } from "./server";
import { humanize, StepForm, transformDescription } from "./step-form";

/** The agent calls the panel uses. */
export interface PipelineApi {
  getTransformCatalog(): Promise<TransformInfo[]>;
  getPipelineView(
    datasetId: string,
    upToStepId?: string
  ): Promise<PipelineView | { error: string }>;
  editPipelineStep(
    datasetId: string,
    edit: PipelineEdit
  ): Promise<{ saved: true; warning?: string } | { error: string }>;
  runPipelineNow(
    datasetId: string
  ): Promise<{ runId: string; version: number } | { error: string }>;
}

type ViewStep = PipelineView["steps"][number];

/** A step's parameters in one short line, like "columns: name, city · case: title". */
function paramsLine(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([key, value]) => {
      const text =
        value === "*"
          ? "all columns"
          : Array.isArray(value)
            ? value.join(", ")
            : typeof value === "object" && value !== null
              ? JSON.stringify(value)
              : String(value);
      return `${humanize(key).toLowerCase()}: ${text}`;
    })
    .join(" · ");
}

function StepRow({
  step,
  index,
  count,
  previewing,
  busy,
  onEdit,
  onMove,
  onRemove,
  onPreview
}: {
  step: ViewStep;
  index: number;
  count: number;
  previewing: boolean;
  busy: boolean;
  onEdit: () => void;
  onMove: (position: number) => void;
  onRemove: () => void;
  onPreview: () => void;
}) {
  return (
    <li
      className={`rounded-lg px-3 py-2 ring ${step.status === "error" ? "ring-kumo-danger" : previewing ? "ring-kumo-brand" : "ring-kumo-line"}`}
    >
      <div className="flex items-start gap-2">
        <span className="text-xs text-kumo-subtle tabular-nums pt-0.5 w-5 shrink-0">
          {index + 1}.
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Text size="xs" bold>
              {humanize(step.op)}
            </Text>
            {step.auto && <Badge variant="secondary">auto</Badge>}
            {step.sampleOnly && <Badge variant="secondary">sample only</Badge>}
            {step.status === "skipped" && (
              <Badge variant="secondary">skipped</Badge>
            )}
          </div>
          {Object.keys(step.params).length > 0 && (
            <p className="text-xs text-kumo-subtle break-all">
              {paramsLine(step.params)}
            </p>
          )}
          <p
            className={`text-xs ${step.status === "error" ? "text-kumo-danger" : "text-kumo-default"}`}
          >
            {step.summary}
          </p>
          {step.examples && (
            <ul className="mt-0.5 space-y-0.5">
              {step.examples.map((e, i) => (
                <li key={i} className="text-xs text-kumo-subtle break-all">
                  Row {e.row}, {e.column}: {JSON.stringify(e.before)} →{" "}
                  {JSON.stringify(e.after)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 gap-0.5">
          <Button
            size="xs"
            variant="ghost"
            shape="square"
            aria-label="Preview up to this step"
            icon={<EyeIcon size={14} />}
            onClick={onPreview}
          />
          <Button
            size="xs"
            variant="ghost"
            shape="square"
            aria-label="Move up"
            icon={<ArrowUpIcon size={14} />}
            disabled={busy || index === 0}
            onClick={() => onMove(index)}
          />
          <Button
            size="xs"
            variant="ghost"
            shape="square"
            aria-label="Move down"
            icon={<ArrowDownIcon size={14} />}
            disabled={busy || index === count - 1}
            onClick={() => onMove(index + 2)}
          />
          <Button
            size="xs"
            variant="ghost"
            shape="square"
            aria-label="Edit step"
            icon={<PencilSimpleIcon size={14} />}
            disabled={busy}
            onClick={onEdit}
          />
          <Button
            size="xs"
            variant="ghost"
            shape="square"
            aria-label="Remove step"
            icon={<TrashIcon size={14} />}
            disabled={busy}
            onClick={onRemove}
          />
        </div>
      </div>
    </li>
  );
}

function ResultTable({ view }: { view: PipelineView }) {
  return (
    <div className="overflow-auto max-h-64 rounded-lg ring ring-kumo-line">
      <table className="text-xs w-full">
        <thead className="bg-kumo-control sticky top-0">
          <tr>
            {view.columns.map((column) => (
              <th
                key={column}
                className="px-2 py-1 text-left font-medium text-kumo-default whitespace-nowrap"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row, r) => (
            <tr key={r} className="border-t border-kumo-line">
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="px-2 py-1 text-kumo-default whitespace-nowrap"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Editing =
  | { kind: "add"; transform: TransformInfo | null }
  | { kind: "edit"; stepId: string };

/** Shows the latest upload's pipeline: each step and what it did on the preview rows, with editing, a result preview, and a run button. */
export function PipelinePanel({
  dataset,
  api
}: {
  dataset: DatasetSummary;
  api: PipelineApi;
}) {
  const [open, setOpen] = useState(true);
  const [catalog, setCatalog] = useState<TransformInfo[]>([]);
  const [view, setView] = useState<PipelineView | null>(null);
  const [upToStepId, setUpToStepId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);

  useEffect(() => {
    api
      .getTransformCatalog()
      .then(setCatalog)
      .catch((e: unknown) => console.error("Could not load transforms:", e));
  }, [api]);

  // Reload when the pipeline changes, from this panel or from the chat.
  useEffect(() => {
    let cancelled = false;
    api
      .getPipelineView(dataset.id, upToStepId ?? undefined)
      .then((result) => {
        if (cancelled) return;
        if ("error" in result) {
          // The step being previewed was removed: show the whole pipeline again.
          if (upToStepId) setUpToStepId(null);
          else setError(result.error ?? "Could not load the pipeline.");
          return;
        }
        setView(result);
      })
      .catch((e: unknown) => console.error("Could not load pipeline:", e));
    return () => {
      cancelled = true;
    };
  }, [api, dataset.id, dataset.pipelineUpdatedAt, upToStepId]);

  const edit = useCallback(
    async (change: PipelineEdit) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await api.editPipelineStep(dataset.id, change);
        if ("error" in result) {
          setError(result.error);
          return false;
        }
        if (result.warning) setNotice(result.warning);
        return true;
      } finally {
        setBusy(false);
      }
    },
    [api, dataset.id]
  );

  const run = async () => {
    setConfirmRun(false);
    setBusy(true);
    setError(null);
    try {
      const result = await api.runPipelineNow(dataset.id);
      if ("error" in result) setError(result.error);
    } finally {
      setBusy(false);
    }
  };

  const transformOf = (op: string) => catalog.find((t) => t.name === op);
  const steps = view?.steps ?? [];
  const running = dataset.latestRun?.status === "running";

  return (
    <Surface className="rounded-xl ring ring-kumo-line">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <FlowArrowIcon size={18} className="text-kumo-brand shrink-0" />
        <Text size="sm" bold>
          Pipeline
        </Text>
        <Text size="xs" variant="secondary">
          {steps.length === 1 ? "1 step" : `${steps.length} steps`}
          {view &&
            ` · preview on the first ${view.sampleRows} rows${view.partial ? "" : " (the whole file)"}`}
        </Text>
        <CaretDownIcon
          size={14}
          className={`ml-auto text-kumo-inactive transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 max-h-[28rem] overflow-auto">
          {steps.length === 0 && (
            <Text size="xs" variant="secondary">
              No steps yet. Add one here, or ask in the chat.
            </Text>
          )}
          <ol className="space-y-1.5">
            {steps.map((step, index) => {
              const transform = transformOf(step.op);
              if (
                editing?.kind === "edit" &&
                editing.stepId === step.id &&
                transform
              )
                return (
                  <li key={step.id}>
                    <StepForm
                      transform={transform}
                      columns={step.columnsBefore ?? []}
                      params={step.params}
                      error={error}
                      busy={busy}
                      submitLabel="Save"
                      onSubmit={async (params) => {
                        if (
                          await edit({
                            type: "replace",
                            stepId: step.id,
                            params
                          })
                        )
                          setEditing(null);
                      }}
                      onCancel={() => {
                        setEditing(null);
                        setError(null);
                      }}
                    />
                  </li>
                );
              return (
                <StepRow
                  key={step.id}
                  step={step}
                  index={index}
                  count={steps.length}
                  previewing={upToStepId === step.id}
                  busy={busy}
                  onEdit={() => {
                    setError(null);
                    setEditing({ kind: "edit", stepId: step.id });
                  }}
                  onMove={(position) =>
                    void edit({ type: "move", stepId: step.id, position })
                  }
                  onRemove={() =>
                    void edit({ type: "remove", stepId: step.id })
                  }
                  onPreview={() =>
                    setUpToStepId(upToStepId === step.id ? null : step.id)
                  }
                />
              );
            })}
          </ol>

          {editing?.kind === "add" ? (
            <div className="space-y-2">
              <select
                className="w-full rounded-md bg-kumo-control px-2 py-1 text-xs text-kumo-default ring ring-kumo-line"
                aria-label="Transform"
                value={editing.transform?.name ?? ""}
                onChange={(e) => {
                  setError(null);
                  setEditing({
                    kind: "add",
                    transform: transformOf(e.target.value) ?? null
                  });
                }}
              >
                <option value="">Choose a step to add…</option>
                {catalog.map((t) => (
                  <option key={t.name} value={t.name}>
                    {humanize(t.name)}: {transformDescription(t)}
                  </option>
                ))}
              </select>
              {editing.transform ? (
                <StepForm
                  key={editing.transform.name}
                  transform={editing.transform}
                  columns={view?.endColumns ?? []}
                  error={error}
                  busy={busy}
                  submitLabel="Add step"
                  onSubmit={async (params) => {
                    if (
                      editing.transform &&
                      (await edit({
                        type: "add",
                        op: editing.transform.name,
                        params
                      }))
                    )
                      setEditing(null);
                  }}
                  onCancel={() => {
                    setEditing(null);
                    setError(null);
                  }}
                />
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
              )}
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon={<PlusIcon size={14} />}
              disabled={busy || catalog.length === 0}
              onClick={() => {
                setError(null);
                setEditing({ kind: "add", transform: null });
              }}
            >
              Add step
            </Button>
          )}

          {error && !editing && (
            <Text size="xs" variant="error">
              {error}
            </Text>
          )}
          {notice && (
            <Text size="xs" variant="secondary">
              {notice}
            </Text>
          )}

          {view && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Text size="xs" variant="secondary" bold>
                  {/* From the loaded view, so the label always matches the rows below it. */}
                  {view.upToStepId
                    ? `Result up to step ${steps.findIndex((s) => s.id === view.upToStepId) + 1}`
                    : "Result"}
                </Text>
                <Text size="xs" variant="secondary">
                  first {view.rows.length} of {view.rowCount} preview rows
                </Text>
                {upToStepId && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setUpToStepId(null)}
                  >
                    Show all steps
                  </Button>
                )}
              </div>
              <ResultTable view={view} />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {confirmRun ? (
              <>
                <Text size="xs">
                  Run the pipeline on the whole file and make a cleaned copy?
                  Your original file is kept.
                </Text>
                <Button size="sm" variant="primary" onClick={() => void run()}>
                  Run
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setConfirmRun(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={<PlayIcon size={14} />}
                disabled={busy || running}
                onClick={() => setConfirmRun(true)}
              >
                {running ? "Running…" : "Run on whole file"}
              </Button>
            )}
          </div>
        </div>
      )}
    </Surface>
  );
}
