import { useState, useCallback, useEffect } from "react";
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { useIdentity } from "../hooks/useIdentity";
import { useContainerStatus } from "../hooks/useContainerStatus";
import { useFiles } from "../hooks/useFiles";
import { useLogs } from "../hooks/useLogs";
import { getLanguageFromPath } from "../lib/fileIcons";
import { FileExplorer } from "./FileExplorer";
import { EditorTabs, type TabItem } from "./EditorTabs";
import { TerminalPane } from "./TerminalPane";
import { PreviewPane } from "./PreviewPane";
import { FileViewer } from "./FileViewer";
import { StatusBar } from "./StatusBar";
import { LogsPanel } from "./LogsPanel";
import { ContainerPanel } from "./ContainerPanel";
import type { FileContent } from "../hooks/useFiles";

type SecondaryPane = null | "terminal" | "preview";

export function App() {
  const email = useIdentity();
  const { state, containerId, refresh } = useContainerStatus();
  const files = useFiles();
  const logs = useLogs();

  // --- UI state ---
  const [activeTab, setActiveTab] = useState("terminal");
  const [openFiles, setOpenFiles] = useState<
    { id: string; path: string; content: string; language: string }[]
  >([]);
  const [secondaryPane, setSecondaryPane] = useState<SecondaryPane>(null);
  const [previewPort, setPreviewPort] = useState(3000);
  const [logsOpen, setLogsOpen] = useState(false);
  const [containerOpen, setContainerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // --- File opening ---
  const handleOpenFile = useCallback(
    async (path: string) => {
      // If already open, just activate
      const existing = openFiles.find((f) => f.path === path);
      if (existing) {
        setActiveTab(existing.id);
        return;
      }
      // Read the file
      const result: FileContent | null = await files.readFile(path);
      if (!result) {
        logs.addLog("error", `Failed to read file: ${path}`);
        return;
      }
      const id = `file:${path}`;
      setOpenFiles((prev) => [
        ...prev,
        {
          id,
          path,
          content: result.content,
          language: result.language || getLanguageFromPath(path),
        },
      ]);
      setActiveTab(id);
    },
    [openFiles, files, logs],
  );

  const handleCloseTab = useCallback(
    (id: string) => {
      setOpenFiles((prev) => prev.filter((f) => f.id !== id));
      if (activeTab === id) {
        setActiveTab("terminal");
      }
    },
    [activeTab],
  );

  // --- Toggle handlers ---
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => !v);
  }, []);

  const toggleSplit = useCallback(() => {
    setSecondaryPane((p) => (p === "terminal" ? null : "terminal"));
  }, []);

  const togglePreview = useCallback(() => {
    setSecondaryPane((p) => (p === "preview" ? null : "preview"));
  }, []);

  // --- Container actions ---
  const handleRestart = useCallback(async () => {
    try {
      await fetch("/api/restart", { method: "POST" });
      logs.addLog("log", "Container restart requested");
      refresh();
    } catch {
      logs.addLog("error", "Failed to restart container");
    }
  }, [logs, refresh]);

  const handleDestroy = useCallback(async () => {
    try {
      await fetch("/api/destroy", { method: "POST" });
      logs.addLog("log", "Container destroy requested");
      refresh();
    } catch {
      logs.addLog("error", "Failed to destroy container");
    }
  }, [logs, refresh]);

  const handleTestProxy = useCallback(async () => {
    try {
      const r = await fetch("/api/proxy-test");
      const d = await r.json();
      logs.addLog("log", `Proxy test: ${JSON.stringify(d)}`);
    } catch {
      logs.addLog("error", "Proxy test failed");
    }
  }, [logs]);

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

      if (e.shiftKey && e.key === "E") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.shiftKey && e.key === "`") {
        e.preventDefault();
        toggleSplit();
      } else if (e.shiftKey && e.key === "P") {
        e.preventDefault();
        togglePreview();
      } else if (e.key === "l") {
        e.preventDefault();
        setLogsOpen((v) => !v);
      } else if (e.key === "k") {
        e.preventDefault();
        setContainerOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar, toggleSplit, togglePreview]);

  // --- Build tab list ---
  const tabs: TabItem[] = [
    { id: "terminal", label: "Claude Code", closable: false },
    ...openFiles.map((f) => ({
      id: f.id,
      label: f.path.split("/").pop() ?? f.path,
      path: f.path,
      closable: true,
    })),
  ];

  // --- Determine active content ---
  const activeFile = openFiles.find((f) => f.id === activeTab);

  return (
    <Sidebar.Provider
      defaultOpen={sidebarOpen}
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
    >
      <div className="flex h-screen w-screen flex-col bg-kumo-base">
        {/* Main layout */}
        <div className="flex min-h-0 flex-1">
          {/* Sidebar */}
          <Sidebar>
            <FileExplorer
              expandedDirs={files.expandedDirs}
              listDir={files.listDir}
              toggleDir={files.toggleDir}
              collapseAll={files.collapseAll}
              invalidateCache={files.invalidateCache}
              onOpenFile={handleOpenFile}
            />
          </Sidebar>

          {/* Main content area */}
          <div className="flex min-w-0 flex-1 flex-col">
            <EditorTabs
              tabs={tabs}
              activeTab={activeTab}
              onActivate={setActiveTab}
              onClose={handleCloseTab}
            />

            {/* Pane container */}
            <div className="flex min-h-0 flex-1">
              {/* Primary pane */}
              <div className="min-w-0 flex-1">
                {activeTab === "terminal" ? (
                  <TerminalPane splitActive={false} />
                ) : activeFile ? (
                  <FileViewer
                    content={activeFile.content}
                    language={activeFile.language}
                    path={activeFile.path}
                  />
                ) : (
                  <TerminalPane splitActive={false} />
                )}
              </div>

              {/* Secondary pane (split) */}
              {secondaryPane && (
                <>
                  <div className="splitter vertical" />
                  <div className="min-w-0 flex-1">
                    {secondaryPane === "terminal" ? (
                      <TerminalPane splitActive={false} />
                    ) : (
                      <PreviewPane
                        port={previewPort}
                        onPortChange={setPreviewPort}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Status bar */}
        <StatusBar
          state={state}
          user={email}
          activeTab={activeTab}
          onToggleSidebar={toggleSidebar}
          onToggleSplit={toggleSplit}
          onTogglePreview={togglePreview}
          onOpenLogs={() => setLogsOpen(true)}
          onOpenContainer={() => setContainerOpen(true)}
        />
      </div>

      {/* Dialogs */}
      <LogsPanel
        open={logsOpen}
        onOpenChange={setLogsOpen}
        entries={logs.entries}
        onClear={logs.clearLogs}
      />
      <ContainerPanel
        open={containerOpen}
        onOpenChange={setContainerOpen}
        user={email}
        state={state}
        containerId={containerId}
        onRestart={handleRestart}
        onDestroy={handleDestroy}
        onRefresh={refresh}
        onTestProxy={handleTestProxy}
      />
    </Sidebar.Provider>
  );
}
