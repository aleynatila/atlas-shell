import { memo } from "react";
import type { TabPane } from "../types";

interface StatusBarProps {
  activeTab: TabPane | undefined;
  isOverview: boolean;
  sessionCount: number;
}

export const StatusBar = memo(function StatusBar({
  activeTab,
  isOverview,
  sessionCount,
}: StatusBarProps) {
  return (
    <div
      className="flex items-center gap-4 px-4 py-1 border-t border-hx-border text-[10px] text-hx-dim shrink-0 font-mono select-none"
      style={{ background: "#080A12" }}
    >
      {activeTab?.connected ? (
        <>
          <span
            className="flex items-center gap-1.5"
            style={{ color: "#00FF88" }}
          >
            <div
              className="w-1.5 h-1.5 rotate-45 bg-current"
              style={{ boxShadow: "0 0 4px #00FF88" }}
            />
            CONNECTED
          </span>
          <span>
            {activeTab.sessionEntry.user}@{activeTab.sessionEntry.host}
          </span>
          <span>
            {activeTab.sessionEntry.keyPath ? "KEY AUTH" : "PASS AUTH"}
          </span>
          <span>UTF-8</span>
        </>
      ) : isOverview ? (
        <span>◆ {sessionCount} sessions</span>
      ) : (
        <span>NOT CONNECTED</span>
      )}
      <div className="flex-1" />
      <span
        className="flex items-center gap-1.5"
        style={{ color: "#00E5FF66" }}
      >
        <span
          className="w-1.5 h-1.5 rotate-45 inline-block"
          style={{ background: "#00E5FF", boxShadow: "0 0 6px #00E5FF" }}
        />
        <span
          className="font-black tracking-[0.2em] text-xs uppercase"
          style={{ textShadow: "0 0 10px #00E5FF55" }}
        >
          Atlas
        </span>
        <span
          className="text-[9px] font-mono ml-1.5"
          style={{ color: "#00E5FF99" }}
        >
          by Aleyna Atila
        </span>
      </span>
    </div>
  );
});
