import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { ArrowClockwise, Trash, Play, Globe } from "@phosphor-icons/react";
import type { ContainerState } from "../hooks/useContainerStatus";

interface ContainerPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: string;
  state: ContainerState;
  containerId: string;
  onRestart: () => void;
  onDestroy: () => void;
  onRefresh: () => void;
  onTestProxy: () => void;
}

const STATE_VARIANT: Record<
  ContainerState,
  "success" | "error" | "warning" | "neutral"
> = {
  running: "success",
  stopped: "error",
  starting: "warning",
  unknown: "neutral",
};

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-kumo-subtle">
        {label}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function ContainerPanel({
  open,
  onOpenChange,
  user,
  state,
  containerId,
  onRestart,
  onDestroy,
  onRefresh,
  onTestProxy,
}: ContainerPanelProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg">
        <Dialog.Title>Container</Dialog.Title>
        <Dialog.Close />

        {/* Info */}
        <div className="divide-y divide-kumo-default px-4">
          <InfoRow label="User">
            <span className="font-mono text-sm text-kumo-default">
              {user}
            </span>
          </InfoRow>
          <InfoRow label="State">
            <Badge variant={STATE_VARIANT[state]}>{state}</Badge>
          </InfoRow>
          <InfoRow label="Container ID">
            <span className="max-w-[200px] truncate font-mono text-sm text-kumo-default">
              {containerId}
            </span>
          </InfoRow>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 border-t border-kumo-default px-4 py-3">
          <Button variant="secondary" size="sm" onClick={onRestart}>
            <Play size={14} />
            <span>Restart</span>
          </Button>
          <Button variant="destructive" size="sm" onClick={onDestroy}>
            <Trash size={14} />
            <span>Destroy</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <ArrowClockwise size={14} />
            <span>Refresh Status</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={onTestProxy}>
            <Globe size={14} />
            <span>Test Proxy</span>
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
