import { createElement } from "react";
import { registerRightView } from "../project/rightPanel";
import { PlanNew } from "./PlanNew";
import { PlanPanel } from "./PlanPanel";

/**
 * Plugs plans into a project's right panel: a plan opens there, and so does
 * the sheet that asks for a new one. Imported once, by the app's entry, with
 * the make sheet's. Each export takes its registration back.
 */
export const unplugPlanPanel = registerRightView("plan", (view, ctx) => createElement(PlanPanel, { key: view.planId, planId: view.planId, projectId: ctx.projectId, onClose: ctx.close, onPlanChange: ctx.onPlanChange, onPlay: ctx.onPlay }));
export const unplugPlanNew = registerRightView("planNew", (_view, ctx) => (ctx.ask ? createElement(PlanNew, { projectId: ctx.projectId, sources: ctx.sources, onAsk: ctx.ask, onClose: ctx.close }) : null));
