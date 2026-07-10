import { useRef, useEffect } from "react";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Button } from "@cloudflare/kumo/components/button";
import { Trash } from "@phosphor-icons/react";
import type { LogEntry } from "../hooks/useLogs";

interface LogsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: LogEntry[];
  onClear: () => void;
}

export function LogsPanel({
  open,
  onOpenChange,
  entries,
  onClear,
}: LogsPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries.length]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg">
        <Dialog.Title>Logs</Dialog.Title>
        <Dialog.Close />

        {/* Header actions */}
        <div className="flex items-center justify-end border-b border-kumo-default px-4 py-2">
          <Button variant="ghost" size="sm" onClick={onClear}>
            <Trash size={14} />
            <span>Clear</span>
          </Button>
        </div>

        {/* Log entries */}
        <div
          ref={listRef}
          className="max-h-[50vh] flex-1 overflow-y-auto p-2 font-mono text-xs"
        >
          {entries.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-kumo-subtle">
              No log entries
            </div>
          ) : (
            entries.map((entry, i) => (
              <div
                key={i}
                className="flex gap-2 border-b border-kumo-default px-2 py-1 last:border-b-0"
              >
                <span className="shrink-0 text-kumo-subtle">
                  {entry.ts}
                </span>
                <span
                  className={
                    entry.level === "error"
                      ? "font-semibold text-red-400"
                      : "text-kumo-default"
                  }
                >
                  {entry.msg}
                </span>
              </div>
            ))
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
