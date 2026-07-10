import { useEffect, useState } from "react";
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { CloudflareLogo } from "@cloudflare/kumo/components/cloudflare-logo";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import {
  FolderSimple,
  CaretRight,
  CaretDown,
  ArrowClockwise,
  ListBullets,
} from "@phosphor-icons/react";
import { getFileIconInfo } from "../lib/fileIcons";
import type { FileEntry } from "../hooks/useFiles";

interface FileExplorerProps {
  expandedDirs: Set<string>;
  listDir: (path: string) => Promise<FileEntry[]>;
  toggleDir: (path: string) => Promise<void>;
  collapseAll: () => void;
  invalidateCache: () => void;
  onOpenFile: (path: string) => void;
}

const ROOT = "/workspace";

function DirNode({
  path,
  name,
  depth,
  expandedDirs,
  listDir,
  toggleDir,
  onOpenFile,
}: {
  path: string;
  name: string;
  depth: number;
  expandedDirs: Set<string>;
  listDir: (p: string) => Promise<FileEntry[]>;
  toggleDir: (p: string) => Promise<void>;
  onOpenFile: (p: string) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const isExpanded = expandedDirs.has(path);

  useEffect(() => {
    if (isExpanded) {
      listDir(path).then(setEntries);
    }
  }, [isExpanded, path, listDir]);

  const dirs = entries
    .filter((e) => e.type === "directory")
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter((e) => e.type === "file" || e.type === "symlink")
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Sidebar.Collapsible
      open={isExpanded}
      onOpenChange={() => toggleDir(path)}
    >
      <Sidebar.CollapsibleTrigger
        render={
          <Sidebar.MenuButton icon={isExpanded ? CaretDown : CaretRight}>
            <span className="flex items-center gap-1 truncate">
              <FolderSimple
                size={16}
                weight="fill"
                className="shrink-0 text-kumo-primary"
              />
              <span className="truncate text-kumo-default">{name}</span>
            </span>
            <Sidebar.MenuChevron />
          </Sidebar.MenuButton>
        }
      />
      <Sidebar.CollapsibleContent>
        {dirs.map((d) => (
          <DirNode
            key={d.name}
            path={`${path}/${d.name}`}
            name={d.name}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            listDir={listDir}
            toggleDir={toggleDir}
            onOpenFile={onOpenFile}
          />
        ))}
        {files.map((f) => {
          const icon = getFileIconInfo(f.name);
          return (
            <Sidebar.MenuButton
              key={f.name}
              onClick={() => onOpenFile(`${path}/${f.name}`)}
            >
              <span className="flex items-center gap-1.5 truncate">
                <span
                  className={`shrink-0 font-mono text-[10px] font-bold leading-none ${icon.colorClass}`}
                >
                  {icon.label}
                </span>
                <span className="truncate text-kumo-default">{f.name}</span>
              </span>
            </Sidebar.MenuButton>
          );
        })}
      </Sidebar.CollapsibleContent>
    </Sidebar.Collapsible>
  );
}

export function FileExplorer({
  expandedDirs,
  listDir,
  toggleDir,
  collapseAll,
  invalidateCache,
  onOpenFile,
}: FileExplorerProps) {
  const handleRefresh = () => {
    invalidateCache();
    // Re-trigger listing of currently expanded dirs
    for (const dir of expandedDirs) {
      listDir(dir);
    }
  };

  return (
    <Sidebar.Content>
      <Sidebar.Group>
        <Sidebar.GroupLabel>
          <span className="flex w-full items-center justify-between">
            <span className="flex items-center gap-1.5">
              <CloudflareLogo className="h-4 w-4" />
              <span className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
                Explorer
              </span>
            </span>
            <span className="flex items-center gap-0.5">
              <Tooltip content="Refresh files" side="top">
                <button
                  onClick={handleRefresh}
                  className="rounded p-0.5 text-kumo-subtle hover:bg-kumo-elevated hover:text-kumo-default"
                >
                  <ArrowClockwise size={14} />
                </button>
              </Tooltip>
              <Tooltip content="Collapse all" side="top">
                <button
                  onClick={collapseAll}
                  className="rounded p-0.5 text-kumo-subtle hover:bg-kumo-elevated hover:text-kumo-default"
                >
                  <ListBullets size={14} />
                </button>
              </Tooltip>
            </span>
          </span>
        </Sidebar.GroupLabel>
        <Sidebar.Menu>
          <DirNode
            path={ROOT}
            name="workspace"
            depth={0}
            expandedDirs={expandedDirs}
            listDir={listDir}
            toggleDir={toggleDir}
            onOpenFile={onOpenFile}
          />
        </Sidebar.Menu>
      </Sidebar.Group>
      <Sidebar.Footer>
        <Sidebar.Trigger />
      </Sidebar.Footer>
    </Sidebar.Content>
  );
}
