import { useState } from "react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import { BrainIcon, TrashIcon } from "@phosphor-icons/react";
import type { Preference } from "./memory";

/** The agent calls the Memory panel uses. */
export interface MemoryApi {
  savePreference(text: string): Promise<Preference | { error: string }>;
  deletePreference(
    id: string
  ): Promise<{ deleted: boolean } | { error: string }>;
}

/** Lists the preferences DataCobbler remembers for this user, and lets the user add or delete them. */
export function MemoryPanel({
  preferences,
  api
}: {
  preferences: Preference[];
  api: MemoryApi;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.savePreference(text);
      if ("error" in result) setError(result.error);
      else setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface className="rounded-xl ring ring-kumo-line px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <BrainIcon size={18} className="text-kumo-brand shrink-0" />
        <Text size="sm" bold>
          Memory
        </Text>
        <Text size="xs" variant="secondary">
          Preferences used with all your files. The agent asks before it saves
          one.
        </Text>
      </div>
      {preferences.length === 0 ? (
        <Text size="xs" variant="secondary">
          Nothing saved yet. Tell the agent something like “my dates are day
          first”, or add it here.
        </Text>
      ) : (
        <ul className="space-y-1">
          {preferences.map((p) => (
            <li key={p.id} className="flex items-start gap-2">
              <span className="text-xs text-kumo-default flex-1 break-words pt-0.5">
                {p.text}
              </span>
              <Button
                size="xs"
                variant="ghost"
                shape="square"
                aria-label={`Delete preference: ${p.text}`}
                icon={<TrashIcon size={14} />}
                onClick={() =>
                  void api
                    .deletePreference(p.id)
                    .catch((e: unknown) =>
                      console.error("Could not delete preference:", e)
                    )
                }
              />
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className="flex-1 rounded-md bg-kumo-control px-2 py-1 text-xs text-kumo-default ring ring-kumo-line focus:outline-none focus:ring-kumo-brand"
          placeholder="Add a preference, like “Empty means N/A in my files”"
          aria-label="New preference"
          maxLength={300}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={busy || text.trim() === ""}
        >
          Add
        </Button>
      </form>
      {error && (
        <Text size="xs" variant="error">
          {error}
        </Text>
      )}
    </Surface>
  );
}
