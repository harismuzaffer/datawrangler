import { useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import type { TransformInfo } from "./pipeline-actions";

/** The parts of JSON Schema that transform parameters use. */
interface Schema {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  default?: unknown;
  additionalProperties?: Schema | boolean;
}

const COLUMN_FIELDS = new Set(["column", "otherColumn"]);
const COLUMN_LIST_FIELDS = new Set(["columns", "groupBy"]);

/** "decimalSeparator" -> "Decimal separator". */
export function humanize(name: string): string {
  const words = name.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The part of a transform's usage line after "name(params): ". */
export function transformDescription(transform: TransformInfo): string {
  return transform.usage.replace(/^[^:]*\):\s*/, "");
}

const inputClass =
  "w-full rounded-md bg-kumo-control px-2 py-1 text-xs text-kumo-default ring ring-kumo-line focus:outline-none focus:ring-kumo-brand";

/** Starting values: the step's parameters when editing, else each field's default. */
function initialValues(
  schema: Schema,
  params: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (params) return { ...params };
  const values: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.properties ?? {}))
    if (field.default !== undefined) values[name] = field.default;
  return values;
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}

/** Drops optional fields the user left empty. Required fields are always sent, so the agent can say what is missing. */
function toParams(
  schema: Schema,
  values: Record<string, unknown>
): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(values).filter(
      ([name, value]) => required.has(name) || !isEmpty(value)
    )
  );
}

/** Column checkboxes, in the order the user ticks them. "All columns" is offered when the field allows "*". */
function ColumnList({
  value,
  columns,
  allowAll,
  onChange
}: {
  value: unknown;
  columns: string[];
  allowAll: boolean;
  onChange: (value: unknown) => void;
}) {
  const all = value === "*";
  const picked = Array.isArray(value) ? (value as string[]) : [];
  // Keep a column the step names even if the sample no longer has it, so the user can see and untick it.
  const options = [...columns, ...picked.filter((c) => !columns.includes(c))];
  return (
    <div className="space-y-1">
      {allowAll && (
        <label className="flex items-center gap-2 text-xs text-kumo-default">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => onChange(e.target.checked ? "*" : [])}
          />
          All columns
        </label>
      )}
      {!all && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {options.map((column) => {
            const order = picked.indexOf(column);
            return (
              <label
                key={column}
                className="flex items-center gap-1 text-xs text-kumo-default"
              >
                <input
                  type="checkbox"
                  checked={order !== -1}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...picked, column]
                        : picked.filter((c) => c !== column)
                    )
                  }
                />
                <span className="break-all">{column}</span>
                {order !== -1 && picked.length > 1 && (
                  <span className="text-kumo-subtle">({order + 1})</span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ColumnSelect({
  value,
  columns,
  optional,
  onChange
}: {
  value: unknown;
  columns: string[];
  optional: boolean;
  onChange: (value: unknown) => void;
}) {
  const current = typeof value === "string" ? value : "";
  const options =
    current && !columns.includes(current) ? [...columns, current] : columns;
  return (
    <select
      className={inputClass}
      value={current}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">{optional ? "None" : "Pick a column"}</option>
      {options.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

/** Rows of "from → to" pairs for value mappings. */
function MappingEditor({
  value,
  onChange
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [rows, setRows] = useState<[string, string][]>(() => {
    const entries = Object.entries(
      (value as Record<string, string> | undefined) ?? {}
    );
    return entries.length > 0 ? entries : [["", ""]];
  });
  const update = (next: [string, string][]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([from]) => from !== "")));
  };
  return (
    <div className="space-y-1">
      {rows.map(([from, to], i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className={inputClass}
            placeholder="Value"
            value={from}
            onChange={(e) =>
              update(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))
            }
          />
          <span className="text-kumo-subtle text-xs">→</span>
          <input
            className={inputClass}
            placeholder="New value"
            value={to}
            onChange={(e) =>
              update(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))
            }
          />
        </div>
      ))}
      <Button
        size="xs"
        variant="secondary"
        onClick={() => update([...rows, ["", ""]])}
      >
        Add value
      </Button>
    </div>
  );
}

/** One form field, chosen from the parameter's name and JSON Schema. */
function Field({
  name,
  schema,
  optional,
  value,
  columns,
  onChange
}: {
  name: string;
  schema: Schema;
  optional: boolean;
  value: unknown;
  columns: string[];
  onChange: (value: unknown) => void;
}) {
  const arrayOf = schema.anyOf?.find((s) => s.type === "array") ?? schema;
  const allowAll = schema.anyOf?.some((s) => s.const === "*") ?? false;

  if (COLUMN_LIST_FIELDS.has(name) && arrayOf.type === "array")
    return (
      <ColumnList
        value={value}
        columns={columns}
        allowAll={allowAll}
        onChange={onChange}
      />
    );
  if (COLUMN_FIELDS.has(name) && schema.type === "string")
    return (
      <ColumnSelect
        value={value}
        columns={columns}
        optional={optional}
        onChange={onChange}
      />
    );
  if (schema.type === "array" && schema.items?.enum) {
    const picked = Array.isArray(value) ? (value as unknown[]) : [];
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {schema.items.enum.map((option) => (
          <label
            key={String(option)}
            className="flex items-center gap-1 text-xs text-kumo-default"
          >
            <input
              type="checkbox"
              checked={picked.includes(option)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...picked, option]
                    : picked.filter((p) => p !== option)
                )
              }
            />
            {String(option)}
          </label>
        ))}
      </div>
    );
  }
  if (schema.type === "array")
    return (
      <textarea
        className={inputClass}
        rows={3}
        placeholder="One per line"
        value={Array.isArray(value) ? value.join("\n") : ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? [] : e.target.value.split("\n"))
        }
      />
    );
  if (schema.type === "object" && schema.properties) {
    // Only orderBy has this shape: a column and a direction.
    const current = (value as Record<string, unknown> | undefined) ?? {};
    return (
      <div className="flex gap-2">
        <ColumnSelect
          value={current.column}
          columns={columns}
          optional
          onChange={(column) =>
            onChange(column ? { ...current, column } : undefined)
          }
        />
        {typeof current.column === "string" && (
          <select
            className={inputClass}
            value={String(current.direction ?? "asc")}
            onChange={(e) =>
              onChange({ ...current, direction: e.target.value })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        )}
      </div>
    );
  }
  if (schema.type === "object")
    return <MappingEditor value={value} onChange={onChange} />;
  if (schema.enum)
    return (
      <select
        className={inputClass}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        {(optional || value === undefined) && <option value="">—</option>}
        {schema.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  if (schema.type === "boolean")
    return (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  if (schema.type === "number" || schema.type === "integer")
    return (
      <input
        className={inputClass}
        type="number"
        step={schema.type === "integer" ? 1 : "any"}
        value={typeof value === "number" ? value : ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : Number(e.target.value))
        }
      />
    );
  return (
    <input
      className={inputClass}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * A form for one transform's parameters, built from its JSON Schema.
 * The agent validates the result again, so the form only needs to make valid input easy.
 */
export function StepForm({
  transform,
  columns,
  params,
  error,
  busy,
  submitLabel,
  onSubmit,
  onCancel
}: {
  transform: TransformInfo;
  columns: string[];
  params?: Record<string, unknown>;
  error: string | null;
  busy: boolean;
  submitLabel: string;
  onSubmit: (params: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const schema = transform.schema as Schema;
  const [values, setValues] = useState(() => initialValues(schema, params));
  const [missing, setMissing] = useState<string[]>([]);
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {});

  return (
    <form
      className="space-y-2 rounded-lg bg-kumo-base p-3 ring ring-kumo-line"
      onSubmit={(e) => {
        e.preventDefault();
        // An empty text can be a real value (replace with nothing), so only unset fields and empty lists count as missing.
        const unset = [...required].filter(
          (name) =>
            values[name] === undefined ||
            (Array.isArray(values[name]) && values[name].length === 0)
        );
        setMissing(unset);
        if (unset.length === 0) onSubmit(toParams(schema, values));
      }}
    >
      <Text size="xs" variant="secondary">
        {transformDescription(transform)}
      </Text>
      {fields.length === 0 && (
        <Text size="xs" variant="secondary">
          This step has no settings.
        </Text>
      )}
      {fields.map(([name, field]) => (
        <div key={name} className="grid grid-cols-[9rem_1fr] gap-2 items-start">
          <span className="text-xs text-kumo-default pt-1">
            {humanize(name)}
            {!required.has(name) && (
              <span className="text-kumo-subtle"> (optional)</span>
            )}
          </span>
          <Field
            name={name}
            schema={field}
            optional={!required.has(name)}
            value={values[name]}
            columns={columns}
            onChange={(value) =>
              setValues((current) => ({ ...current, [name]: value }))
            }
          />
        </div>
      ))}
      {missing.length > 0 ? (
        <Text size="xs" variant="error">
          Fill in: {missing.map(humanize).join(", ")}.
        </Text>
      ) : (
        error && (
          <Text size="xs" variant="error">
            {error}
          </Text>
        )
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={busy}>
          {submitLabel}
        </Button>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
