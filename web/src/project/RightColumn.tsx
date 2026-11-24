import { useCallback, useEffect, useRef } from "react";
import { ScrimClose, ScrimDrawn } from "../design/Sheet";
import { useRightViewRenderer, type RightPanelContext, type RightView } from "./rightPanel";

/**
 * What the right column shows when a view is open in it: the renderer
 * registered for the view's kind (the make sheet and the plan views, plugged in
 * by the app's entry), or a custom view's own node. On a phone it lies over
 * the page as a sheet.
 */
export function RightViewHost({ view, ctx, onFocusPlan }: { view: RightView; ctx: RightPanelContext; /** Shows a plan's card in its chat, with no plan panel. */ onFocusPlan: (planId: string) => void }) {
  const render = useRightViewRenderer(view.kind);
  const lonePlan = !render && view.kind === "plan" ? view.planId : undefined;
  const { close } = ctx;
  // A sheet inside closes the way its own buttons do, so the scrim asks first when the sheet would.
  const sheetClose = useRef<(() => void) | null>(null);
  const handOver = useCallback((own: (() => void) | null) => {
    sheetClose.current = own;
  }, []);
  // A plan with no plan panel to open in opens where it always has, its card in the chat.
  useEffect(() => {
    if (!lonePlan) return;
    onFocusPlan(lonePlan);
    close();
  }, [lonePlan, onFocusPlan, close]);

  let body: React.ReactNode = null;
  if (render) body = render(view as never, ctx);
  else if (view.kind === "custom") body = view.node;
  return (
    <div className="rview" data-kind={view.kind}>
      <div className="rview-scrim" aria-hidden="true" onClick={() => (sheetClose.current ?? close)()} />
      <div className="rview-body">
        <ScrimClose.Provider value={handOver}>
          <ScrimDrawn.Provider value>{body}</ScrimDrawn.Provider>
        </ScrimClose.Provider>
      </div>
    </div>
  );
}
