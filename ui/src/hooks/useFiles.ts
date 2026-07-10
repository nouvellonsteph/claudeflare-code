import { useState, useCallback, useRef } from "react";

export interface FileEntry {
  name: string;
  type: "directory" | "file" | "symlink";
  size: number;
  permissions: string;
}

export interface FileContent {
  path: string;
  content: string;
  language: string;
  size: number;
}

export function useFiles() {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    new Set(["/workspace"]),
  );
  const cache = useRef<Record<string, FileEntry[]>>({});

  const listDir = useCallback(async (path: string): Promise<FileEntry[]> => {
    if (cache.current[path]) return cache.current[path];
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      const d: any = await r.json();
      const entries = (d.entries || []) as FileEntry[];
      cache.current[path] = entries;
      return entries;
    } catch {
      return [];
    }
  }, []);

  const readFile = useCallback(
    async (path: string): Promise<FileContent | null> => {
      try {
        const r = await fetch(
          `/api/files/read?path=${encodeURIComponent(path)}`,
        );
        const d: any = await r.json();
        if (d.error) return null;
        return d as FileContent;
      } catch {
        return null;
      }
    },
    [],
  );

  const toggleDir = useCallback(
    async (path: string) => {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          // Pre-fetch dir contents
          listDir(path);
        }
        return next;
      });
    },
    [listDir],
  );

  const collapseAll = useCallback(() => {
    setExpandedDirs(new Set(["/workspace"]));
  }, []);

  const invalidateCache = useCallback(() => {
    cache.current = {};
  }, []);

  return {
    expandedDirs,
    listDir,
    readFile,
    toggleDir,
    collapseAll,
    invalidateCache,
  };
}
