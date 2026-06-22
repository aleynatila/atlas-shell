import { useCallback, useRef, useState } from "react";

export type ViewKind = "overview" | "settings" | "new-session";

export interface ViewRouter {
  activeView: string;
  setActiveView: React.Dispatch<React.SetStateAction<string>>;
  openViews: Set<ViewKind>;
  setOpenViews: React.Dispatch<React.SetStateAction<Set<ViewKind>>>;
  openView: (kind: ViewKind) => void;
  closeView: (kind: ViewKind) => void;
}

/**
 * Manages the top-level navigation between fixed views (Overview, Settings,
 * New Session) and per-tab views. When closing the active fixed view, falls
 * back first to another open fixed view, then to the most recently opened tab
 * (via `getTabIds`), then to the empty string.
 */
export function useViewRouter(getTabIds: () => string[]): ViewRouter {
  const [activeView, setActiveView] = useState<string>("overview");
  const [openViews, setOpenViews] = useState<Set<ViewKind>>(
    () => new Set(["overview"] as const),
  );

  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const openViewsRef = useRef(openViews);
  openViewsRef.current = openViews;
  const getTabIdsRef = useRef(getTabIds);
  getTabIdsRef.current = getTabIds;

  const openView = useCallback((kind: ViewKind) => {
    setOpenViews((prev) => {
      if (prev.has(kind)) return prev;
      return new Set([...prev, kind]);
    });
    setActiveView((prev) => (prev === kind ? prev : kind));
  }, []);

  const closeView = useCallback((kind: ViewKind) => {
    setOpenViews((prev) => {
      const next = new Set(prev);
      next.delete(kind);
      return next;
    });
    if (activeViewRef.current === kind) {
      const other = [...openViewsRef.current].find((v) => v !== kind);
      if (other) {
        setActiveView(other);
      } else {
        const tabIds = getTabIdsRef.current();
        if (tabIds.length > 0) setActiveView(tabIds[tabIds.length - 1]!);
        else setActiveView("");
      }
    }
  }, []);

  return {
    activeView,
    setActiveView,
    openViews,
    setOpenViews,
    openView,
    closeView,
  };
}
