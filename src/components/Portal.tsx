import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOverlayStore } from "../stores/webStores";

/**
 * Escapes the React tree entirely to render into document.body. Toolbar and
 * Sidebar use backdrop-filter (.glass), which creates a CSS stacking context
 * at effective z-index:0 — any menu nested inside them gets trapped in that
 * context and can be painted beneath later-DOM-order siblings (e.g. the
 * gallery grid's transformed rows) no matter what z-index the menu itself
 * uses. Portal-ing floating overlays sidesteps the whole stacking hierarchy.
 */
export function Portal({ children }: { children: ReactNode }) {
  // The embedded browser is a native view above all HTML: while any overlay is
  // open it hides itself so the overlay is not painted underneath it.
  const push = useOverlayStore((s) => s.push);
  const pop = useOverlayStore((s) => s.pop);
  useEffect(() => {
    push();
    return pop;
  }, [push, pop]);
  return createPortal(children, document.body);
}
