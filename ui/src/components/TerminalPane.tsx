import { useCallback, useRef, useState } from "react";

interface TerminalPaneProps {
  splitActive: boolean;
}

export function TerminalPane({ splitActive }: TerminalPaneProps) {
  const [splitRatio, setSplitRatio] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitRatio(Math.max(20, Math.min(80, pct)));
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  if (!splitActive) {
    return (
      <div className="flex h-full w-full bg-kumo-base">
        <iframe
          src="/terminal/"
          className="terminal-frame"
          title="Terminal"
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full w-full bg-kumo-base">
      <div style={{ width: `${splitRatio}%` }} className="h-full min-w-0">
        <iframe
          src="/terminal/"
          className="terminal-frame"
          title="Terminal 1"
        />
      </div>
      <div
        className={`splitter vertical ${dragging.current ? "dragging" : ""}`}
        onMouseDown={onMouseDown}
      />
      <div
        style={{ width: `${100 - splitRatio}%` }}
        className="h-full min-w-0"
      >
        <iframe
          src="/terminal/"
          className="terminal-frame"
          title="Terminal 2"
        />
      </div>
    </div>
  );
}
