import { memo } from "react";
import type { Credential, SessionEntry, TabPane } from "../types";
import { SessionCard } from "./SessionCard";

const MIN_CARD_WIDTH = 260;

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
        className="grid gap-4 content-start"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${MIN_CARD_WIDTH}px, 1fr))`,
        }}
      >
        {overviewSessions.map((s) => {
          const connectedTab = connectedTabsBySessionId.get(s.id);
          return (
            <div key={s.id}>
              <SessionCard
                session={s}
                isOpen={!!connectedTab}
                isConnected={connectedTab?.connected ?? false}
                onOpen={onOpenTab}
                onEdit={onEditSession}
                onRemove={onRemoveSession}
                credentials={credentials}
                darkMode={darkMode}
              />
            </div>
          );
        })}
      </div>
    );
  },
  (prev, next) =>
    prev.overviewSessions === next.overviewSessions &&
    prev.connectedTabsBySessionId === next.connectedTabsBySessionId &&
    prev.onOpenTab === next.onOpenTab &&
    prev.onEditSession === next.onEditSession &&
    prev.onRemoveSession === next.onRemoveSession &&
    prev.credentials === next.credentials &&
    prev.darkMode === next.darkMode,
);
