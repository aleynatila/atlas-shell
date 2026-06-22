import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Grid } from "react-window";
import type { Credential, SessionEntry, TabPane } from "../types";
import { SessionCard } from "./SessionCard";

const MIN_CARD_WIDTH = 260;
const CARD_INTRINSIC_HEIGHT = 148;
const ROW_HEIGHT = 164; // card height (~148) + vertical gap
const GAP = 16;
// Switch to true react-window virtualization above this many sessions.
// Below the threshold we keep the responsive CSS auto-fill grid + per-card
// `content-visibility: auto` so the layout/scroll behavior stays identical
// for typical usage (the browser already skips paint for off-screen cards).
const VIRTUALIZE_THRESHOLD = 100;

interface OverviewCardGridProps {
  overviewSessions: SessionEntry[];
  connectedTabsBySessionId: Map<string, TabPane>;
  onOpenTab: (entry: SessionEntry) => void;
  onEditSession: (session: SessionEntry) => void;
  onRemoveSession: (id: string, e: React.MouseEvent) => void;
  credentials: Credential[];
  darkMode: boolean;
}

interface CellProps {
  overviewSessions: SessionEntry[];
  connectedTabsBySessionId: Map<string, TabPane>;
  onOpenTab: (entry: SessionEntry) => void;
  onEditSession: (session: SessionEntry) => void;
  onRemoveSession: (id: string, e: React.MouseEvent) => void;
  credentials: Credential[];
  darkMode: boolean;
  columnCount: number;
}

function VirtualCell({
  ariaAttributes,
  columnIndex,
  rowIndex,
  style,
  overviewSessions,
  connectedTabsBySessionId,
  onOpenTab,
  onEditSession,
  onRemoveSession,
  credentials,
  darkMode,
  columnCount,
}: {
  ariaAttributes: { "aria-colindex": number; role: "gridcell" };
  columnIndex: number;
  rowIndex: number;
  style: React.CSSProperties;
} & CellProps) {
  const index = rowIndex * columnCount + columnIndex;
  const session = overviewSessions[index];
  if (!session) return null;
  const connectedTab = connectedTabsBySessionId.get(session.id);
  return (
    <div
      {...ariaAttributes}
      style={{
        ...style,
        paddingRight: GAP,
        paddingBottom: GAP,
        boxSizing: "border-box",
      }}
    >
      <SessionCard
        session={session}
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
}

export const OverviewCardGrid = memo(
  function OverviewCardGrid(props: OverviewCardGridProps) {
    const {
      overviewSessions,
      connectedTabsBySessionId,
      onOpenTab,
      onEditSession,
      onRemoveSession,
      credentials,
      darkMode,
    } = props;

    const useVirtualization = overviewSessions.length > VIRTUALIZE_THRESHOLD;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const [size, setSize] = useState<{ width: number; height: number }>({
      width: 0,
      height: 0,
    });

    useLayoutEffect(() => {
      if (!useVirtualization) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    }, [useVirtualization]);

    useEffect(() => {
      if (!useVirtualization) return;
      const el = containerRef.current;
      if (!el || typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
        setSize((prev) =>
          prev.width === width && prev.height === height
            ? prev
            : { width, height },
        );
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [useVirtualization]);

    if (!useVirtualization) {
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
              <div
                key={s.id}
                style={
                  {
                    contentVisibility: "auto",
                    containIntrinsicSize: `0 ${CARD_INTRINSIC_HEIGHT}px`,
                  } as React.CSSProperties
                }
              >
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
    }

    const columnCount = Math.max(1, Math.floor(size.width / MIN_CARD_WIDTH));
    const columnWidth =
      columnCount > 0 ? Math.floor(size.width / columnCount) : MIN_CARD_WIDTH;
    const rowCount = Math.ceil(overviewSessions.length / columnCount);

    return (
      <div ref={containerRef} className="h-full w-full">
        {size.width > 0 && size.height > 0 && (
          <Grid<CellProps>
            cellComponent={VirtualCell}
            cellProps={{
              overviewSessions,
              connectedTabsBySessionId,
              onOpenTab,
              onEditSession,
              onRemoveSession,
              credentials,
              darkMode,
              columnCount,
            }}
            columnCount={columnCount}
            columnWidth={columnWidth}
            rowCount={rowCount}
            rowHeight={ROW_HEIGHT}
            overscanCount={2}
            style={{ width: size.width, height: size.height }}
          />
        )}
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
