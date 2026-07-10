import { useState, useEffect, useCallback } from "react";

export type ContainerState = "running" | "stopped" | "starting" | "unknown";

interface StatusInfo {
  state: ContainerState;
  containerId: string;
}

export function useContainerStatus(pollInterval = 30_000) {
  const [status, setStatus] = useState<StatusInfo>({
    state: "unknown",
    containerId: "--",
  });

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/status");
      const d: any = await r.json();
      setStatus({
        state: (d.state as ContainerState) || "unknown",
        containerId: d.containerId || "--",
      });
    } catch {
      setStatus((prev) => ({ ...prev, state: "unknown" }));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, pollInterval);
    return () => clearInterval(id);
  }, [refresh, pollInterval]);

  return { ...status, refresh };
}
