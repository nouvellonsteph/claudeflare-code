import { useMemo } from "react";

interface FileViewerProps {
  content: string;
  language: string;
  path: string;
}

export function FileViewer({ content, language, path }: FileViewerProps) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const gutterWidth = String(lines.length).length;

  return (
    <div className="flex h-full flex-col bg-kumo-base">
      {/* File path header */}
      <div className="flex items-center gap-2 border-b border-kumo-default bg-kumo-elevated px-3 py-1.5">
        <span className="font-mono text-sm text-kumo-subtle">
          {path}
        </span>
        <span className="text-sm text-kumo-subtle">
          — {language}
        </span>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto">
        <div className="flex font-mono text-sm leading-6">
          {/* Line number gutter */}
          <div
            className="sticky left-0 shrink-0 select-none border-r border-kumo-default bg-kumo-elevated px-3 text-right text-kumo-subtle"
            aria-hidden="true"
          >
            {lines.map((_, i) => (
              <div key={i}>
                {String(i + 1).padStart(gutterWidth, "\u00a0")}
              </div>
            ))}
          </div>

          {/* Code content */}
          <pre className="min-w-0 flex-1 overflow-x-auto px-4 text-kumo-default">
            <code>
              {lines.map((line, i) => (
                <div key={i}>{line || "\u00a0"}</div>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
}
