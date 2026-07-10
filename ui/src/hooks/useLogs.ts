import { useState, useCallback } from "react";

export interface LogEntry {
  ts: string;
  level: "log" | "error";
  msg: string;
}

const MAX_LOGS = 200;

export function useLogs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  const addLog = useCallback((level: LogEntry["level"], msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setEntries((prev) => {
      const next = [...prev, { ts, level, msg }];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  }, []);

  const clearLogs = useCallback(() => setEntries([]), []);

  return { entries, addLog, clearLogs };
}
