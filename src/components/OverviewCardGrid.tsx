import { memo } from "react";
import type { Credential, SessionEntry, TabPane } from "../types";
import { SessionCard } from "./SessionCard";

interface OverviewCardGridProps {
  overviewSessions: SessionEntry[];
  connectedTabsBySessionId: Map<string, TabPane>;
  onOpenTab: (entry: SessionEntry) => void;
  onEditSession: (session: SessionEntry) => void;
  onRemoveSession: (id: string, e: React.MouseEvent) => void;
  credentials: Credential[];
  darkMode: boolean;
}

export const OverviewCardGrid = memo(
  function OverviewCardGrid({
    overviewSessions,
    connectedTabsBySessionId,
    onOpenTab,
    onEditSession,
    onRemoveSession,
    credentials,
    darkMode,
  }: OverviewCardGridProps) {
    return (
      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        }}
      >
        {overviewSessions.map((s) => {
          const connectedTab = connectedTabsBySessionId.get(s.id);
          return (
            <SessionCard
              key={s.id}
              session={s}
              isOpen={!!connectedTab}
              isConnected={connectedTab?.connected ?? false}
              onOpen={onOpenTab}
              onEdit={onEditSession}
              onRemove={onRemoveSession}
              credentials={credentials}
              darkMode={darkMode}
            />
          );
        })}
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.overviewSessions === next.overviewSessions &&
      prev.connectedTabsBySessionId === next.connectedTabsBySessionId &&
      prev.onOpenTab === next.onOpenTab &&
      prev.onEditSession === next.onEditSession &&
      prev.onRemoveSession === next.onRemoveSession &&
      prev.credentials === next.credentials &&
      prev.darkMode === next.darkMode
    );
  },
);
