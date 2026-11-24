import { createElement } from "react";
import { registerRightView } from "../project/rightPanel";
import { MakeSheet } from "./MakeSheet";

/** The make sheet is what the right column shows for "make": a tile, a chat proposal or a plan item opens it. */
registerRightView("make", (view, ctx) =>
  createElement(MakeSheet, {
    key: `${view.shape}:${JSON.stringify(view.prefill ?? null)}`,
    projectId: ctx.projectId,
    shape: view.shape,
    sources: ctx.sources,
    ...(view.prefill ? { prefill: view.prefill } : {}),
    onClose: ctx.close,
    onMade: (made) => {
      ctx.onPlanChange(made);
      ctx.close();
    },
  }),
);
