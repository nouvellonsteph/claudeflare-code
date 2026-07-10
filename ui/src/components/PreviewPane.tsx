import { useState, useCallback } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowClockwise, Globe, Play } from "@phosphor-icons/react";

const COMMON_PORTS = [3000, 5173, 5174, 4321, 8000, 8080, 8888];

interface PreviewPaneProps {
  port: number;
  onPortChange: (port: number) => void;
}

export function PreviewPane({ port, onPortChange }: PreviewPaneProps) {
  const [urlInput, setUrlInput] = useState(`/preview/${port}/`);
  const [iframeSrc, setIframeSrc] = useState(`/preview/${port}/`);
  const [key, setKey] = useState(0);

  const handleGo = useCallback(() => {
    setIframeSrc(urlInput);
    setKey((k) => k + 1);
  }, [urlInput]);

  const handleRefresh = useCallback(() => {
    setKey((k) => k + 1);
  }, []);

  const handleCyclePort = useCallback(() => {
    const idx = COMMON_PORTS.indexOf(port);
    const next = COMMON_PORTS[(idx + 1) % COMMON_PORTS.length];
    onPortChange(next);
    const newUrl = `/preview/${next}/`;
    setUrlInput(newUrl);
    setIframeSrc(newUrl);
    setKey((k) => k + 1);
  }, [port, onPortChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleGo();
      }
    },
    [handleGo],
  );

  return (
    <div className="flex h-full flex-col bg-kumo-base">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 border-b border-kumo-default bg-kumo-elevated px-2 py-1">
        <Button variant="ghost" size="sm" onClick={handleRefresh}>
          <ArrowClockwise size={14} />
        </Button>

        <div className="flex min-w-0 flex-1 items-center gap-1">
          <Globe size={14} className="shrink-0 text-kumo-subtle" />
          <Input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-7 flex-1 font-mono text-xs"
          />
        </div>

        <Button variant="secondary" size="sm" onClick={handleGo}>
          <Play size={14} />
        </Button>

        <Button variant="ghost" size="sm" onClick={handleCyclePort}>
          <span className="font-mono text-xs">{port}</span>
        </Button>
      </div>

      {/* Preview iframe */}
      <div className="flex-1">
        <iframe
          key={key}
          src={iframeSrc}
          className="terminal-frame"
          title="Preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      </div>
    </div>
  );
}
