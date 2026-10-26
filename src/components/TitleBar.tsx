import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "../assets/logo.png";
import { useRootStore } from "../stores/rootStore";

const win = getCurrentWindow();

function WindowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className="no-drag flex h-8 w-11 items-center justify-center text-text-secondary/70 transition-colors hover:bg-white/10 hover:text-text-primary active:bg-white/15"
    >
      {children}
    </button>
  );
}

export function TitleBar() {
  const root = useRootStore((s) => s.root);

  return (
    <div
      className="drag glass relative z-50 flex h-9 w-full shrink-0 items-center border-b border-hairline px-3"
      onDoubleClick={() => win.toggleMaximize()}
    >
      <div className="pointer-events-none flex flex-1 items-center justify-center gap-2 text-[12px] font-medium tracking-wide text-text-secondary">
        <img src={logo} alt="" draggable={false} className="h-4 w-4 rounded-[4px]" />
        <span className="text-text-primary/80">Quin Gallery</span>
        {root && (
          <>
            <span className="text-text-tertiary">·</span>
            <span className="text-text-tertiary">{root.displayName}</span>
          </>
        )}
      </div>
      <div className="absolute right-0 top-0 flex h-9 items-center">
        <WindowButton label="Minimize" onClick={() => win.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </WindowButton>
        <WindowButton label="Maximize" onClick={() => win.toggleMaximize()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        </WindowButton>
        <WindowButton label="Close" onClick={() => win.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" />
            <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" />
          </svg>
        </WindowButton>
      </div>
    </div>
  );
}
