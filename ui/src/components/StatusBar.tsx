import { Badge } from "@cloudflare/kumo/components/badge";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import type { ContainerState } from "../hooks/useContainerStatus";

interface StatusBarProps {
  state: ContainerState;
  user: string;
  activeTab: string;
  onToggleSidebar: () => void;
  onToggleSplit: () => void;
  onTogglePreview: () => void;
  onOpenLogs: () => void;
  onOpenContainer: () => void;
}

const STATE_CONFIG: Record<
  ContainerState,
  { dotClass: string; variant: "success" | "error" | "warning" | "neutral" }
> = {
  running: { dotClass: "bg-green-400", variant: "success" },
  stopped: { dotClass: "bg-red-400", variant: "error" },
  starting: { dotClass: "bg-yellow-400", variant: "warning" },
  unknown: { dotClass: "bg-gray-400", variant: "neutral" },
};

function ShortcutHint({
  keys,
  label,
  onClick,
}: {
  keys: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip content={keys} side="top">
      <button
        onClick={onClick}
        className="rounded px-1.5 py-0.5 font-mono text-[11px] text-kumo-subtle hover:bg-kumo-elevated hover:text-kumo-default"
      >
        {label}
      </button>
    </Tooltip>
  );
}

export function StatusBar({
  state,
  user,
  activeTab,
  onToggleSidebar,
  onToggleSplit,
  onTogglePreview,
  onOpenLogs,
  onOpenContainer,
}: StatusBarProps) {
  const cfg = STATE_CONFIG[state];

  return (
    <div className="flex h-6 w-full items-center justify-between border-t border-kumo-default bg-kumo-elevated px-2 text-xs">
      {/* Left section */}
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenContainer}
          className="flex items-center gap-1.5 hover:text-kumo-default"
        >
          <span className={`inline-block h-2 w-2 rounded-full ${cfg.dotClass}`} />
          <Badge variant={cfg.variant} className="text-[10px]">
            {state}
          </Badge>
        </button>

        <span className="text-kumo-subtle">{user}</span>
      </div>

      {/* Center section */}
      <div className="flex items-center gap-1 text-kumo-subtle">
        {activeTab !== "terminal" && (
          <span className="font-mono text-[11px]">{activeTab}</span>
        )}
      </div>

      {/* Right section — shortcut hints */}
      <div className="flex items-center gap-0.5">
        <ShortcutHint
          keys="Ctrl+Shift+E"
          label="Explorer"
          onClick={onToggleSidebar}
        />
        <ShortcutHint
          keys="Ctrl+Shift+`"
          label="Split"
          onClick={onToggleSplit}
        />
        <ShortcutHint
          keys="Ctrl+Shift+P"
          label="Preview"
          onClick={onTogglePreview}
        />
        <ShortcutHint keys="Ctrl+L" label="Logs" onClick={onOpenLogs} />
        <ShortcutHint
          keys="Ctrl+K"
          label="Container"
          onClick={onOpenContainer}
        />
      </div>
    </div>
  );
}
