import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Terminal, X } from "@phosphor-icons/react";
import { getFileIconInfo } from "../lib/fileIcons";

export interface TabItem {
  id: string;
  label: string;
  path?: string;
  closable: boolean;
}

interface EditorTabsProps {
  tabs: TabItem[];
  activeTab: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

export function EditorTabs({
  tabs,
  activeTab,
  onActivate,
  onClose,
}: EditorTabsProps) {
  const tabsDef = tabs.map((t) => ({
    value: t.id,
    label: (
      <span className="flex items-center gap-1.5">
        {t.id === "terminal" ? (
          <Terminal size={14} className="text-kumo-primary" />
        ) : (
          (() => {
            const filename = t.path?.split("/").pop() ?? t.label;
            const icon = getFileIconInfo(filename);
            return (
              <span
                className={`font-mono text-[10px] font-bold leading-none ${icon.colorClass}`}
              >
                {icon.label}
              </span>
            );
          })()
        )}
        <span>{t.label}</span>
        {t.closable && (
          <Tooltip content="Close" side="bottom">
            <button
              className="ml-1 rounded p-0.5 text-kumo-subtle opacity-0 hover:bg-kumo-elevated hover:text-kumo-default group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <X size={12} />
            </button>
          </Tooltip>
        )}
      </span>
    ),
  }));

  return (
    <div className="border-b border-kumo-default bg-kumo-elevated">
      <Tabs
        tabs={tabsDef}
        value={activeTab}
        onValueChange={onActivate}
        variant="underline"
      />
    </div>
  );
}
