import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";
import type { PlanView } from "../api/types";
import { now } from "../test/fakeEngine";
import { renderApp } from "../test/render";
import { Sheet } from "../design/Sheet";
import { registerRightView, useRightPanel, type RightPanelContext } from "./rightPanel";

const project = { id: "p1", title: "Calculus I", settings: {}, createdAt: now, updatedAt: now };
const source = { id: "s1", projectId: "p1", kind: "pdf", title: "Week 3", status: "ready", createdAt: now, updatedAt: now };
const plan: PlanView = {
  plan: { id: "pl1", projectId: "p1", title: "Unit 1", version: 1, status: "cancelled", createdAt: now, updatedAt: now, kickedOffAt: now },
  stages: [{ level: 1 }],
  items: [{ id: "a", level: 1, ord: 0, type: "quiz", title: "Check", settings: {}, enabled: true, status: "done", outputId: "o1", sources: [], done: false }],
  edges: [],
  counts: { total: 1, done: 0 },
  estimateUsd: 0,
  issues: [],
};
const routes = {
  "GET /v1/projects/:id": { project },
  "GET /v1/projects": { projects: [project] },
  "GET /v1/projects/:id/sources": { sources: [source] },
  "GET /v1/projects/:id/plans": { plans: [{ ...plan.plan, counts: plan.counts }] },
  "GET /v1/projects/:id/outputs": { outputs: [] },
  "GET /v1/plans/:id": plan,
  "GET /v1/projects/:id/chats": { chats: [] },
  "GET /v1/skills": { skills: [], commands: [] },
};
const STUDIO = "Make and Made here";

const undo: Array<() => void> = [];
afterEach(() => undo.splice(0).forEach((u) => u()));

function SheetStandIn({ shape, ctx }: { shape: string; ctx: RightPanelContext }) {
  const panel = useRightPanel();
  return (
    <section aria-label="Sheet">
      <p>
        {shape} from {ctx.sources.join(",")} in {ctx.projectId}
      </p>
      <button type="button" onClick={ctx.close}>
        Done
      </button>
      <button type="button" onClick={() => panel.open({ kind: "custom", node: <p>Anything at all</p> })}>
        Other
      </button>
    </section>
  );
}

function PlanStandIn({ planId, ctx }: { planId: string; ctx: RightPanelContext }) {
  return (
    <section aria-label="Plan panel">
      Plan {planId}
      <button type="button" onClick={ctx.close}>
        Back
      </button>
    </section>
  );
}

test("a Make tile opens the view registered for make, with its shape and what it may read; any part can put its own view there", async () => {
  undo.push(registerRightView("make", (view, ctx) => <SheetStandIn shape={view.shape} ctx={ctx} />));
  renderApp("/projects/p1", routes);
  const studio = await screen.findByRole("region", { name: STUDIO });
  await userEvent.click(await within(within(studio).getByRole("group", { name: "Make" })).findByRole("button", { name: "quiz" }));
  const sheet = await screen.findByRole("region", { name: "Sheet" });
  expect(sheet).toHaveTextContent("quiz from s1 in p1");
  // The column shows the sheet in place of Make.
  expect(screen.queryByRole("region", { name: STUDIO })).not.toBeInTheDocument();
  expect(sheet.closest("main")).toHaveClass("rv-open");
  await userEvent.click(within(sheet).getByRole("button", { name: "Other" }));
  expect(await screen.findByText("Anything at all")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Sheet" })).not.toBeInTheDocument();
});

test("closing a registered view brings Make and Made here back", async () => {
  undo.push(registerRightView("make", (view, ctx) => <SheetStandIn shape={view.shape} ctx={ctx} />));
  renderApp("/projects/p1", routes);
  const studio = await screen.findByRole("region", { name: STUDIO });
  await userEvent.click(await within(studio).findByRole("button", { name: "flashcards" }));
  await userEvent.click(within(await screen.findByRole("region", { name: "Sheet" })).getByRole("button", { name: "Done" }));
  expect(await screen.findByRole("region", { name: STUDIO })).toBeInTheDocument();
  expect(screen.getByRole("main")).not.toHaveClass("rv-open");
});

test("Plan a whole subject opens the view registered for a new plan", async () => {
  undo.push(registerRightView("planNew", () => <section aria-label="New plan">A new plan</section>));
  renderApp("/projects/p1", routes);
  const studio = await screen.findByRole("region", { name: STUDIO });
  await userEvent.click(within(studio).getByRole("button", { name: /^Plan a whole subject/ }));
  expect(await screen.findByRole("region", { name: "New plan" })).toBeInTheDocument();
});

test("a plan's Open shows the plan panel when one is registered, not the card in the chat", async () => {
  undo.push(registerRightView("plan", (view, ctx) => <PlanStandIn planId={view.planId} ctx={ctx} />));
  renderApp("/projects/p1", routes);
  const studio = await screen.findByRole("region", { name: STUDIO });
  await userEvent.click(await within(studio).findByRole("button", { name: "Open Unit 1" }));
  const panel = await screen.findByRole("region", { name: "Plan panel" });
  expect(panel).toHaveTextContent("Plan pl1");
  expect(screen.queryByRole("article", { name: "Plan: Unit 1" })).not.toBeInTheDocument();
  await userEvent.click(within(panel).getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("region", { name: STUDIO })).toBeInTheDocument();
});

test("a view registered while the project is open is used at once, and taking it back leaves no stale view", async () => {
  renderApp("/projects/p1", routes);
  const studio = await screen.findByRole("region", { name: STUDIO });
  await userEvent.click(await within(studio).findByRole("button", { name: "quiz" }));
  expect(screen.queryByRole("region", { name: "Sheet" })).not.toBeInTheDocument();
  const take = registerRightView("make", (view, ctx) => <SheetStandIn shape={view.shape} ctx={ctx} />);
  expect(await screen.findByRole("region", { name: "Sheet" })).toBeInTheDocument();
  take();
  await waitFor(() => expect(screen.queryByRole("region", { name: "Sheet" })).not.toBeInTheDocument());
});

test("a sheet in the right column draws no scrim of its own: the page behind is dimmed once, by the column's", async () => {
  undo.push(registerRightView("make", (_view, ctx) => <Sheet title="Make a quiz" onClose={ctx.close} primary={{ label: "Make the quiz", onClick: () => {} }}>body</Sheet>));
  renderApp("/projects/p1", routes);
  const studio = await screen.findByRole("region", { name: STUDIO });
  await userEvent.click(await within(studio).findByRole("button", { name: "quiz" }));
  expect(await screen.findByRole("region", { name: "Make a quiz" })).toBeInTheDocument();
  expect(document.querySelectorAll(".rview-scrim")).toHaveLength(1);
  expect(document.querySelectorAll(".sheet-scrim")).toHaveLength(0);
  // The column's scrim still closes it.
  await userEvent.click(document.querySelector(".rview-scrim")!);
  expect(await screen.findByRole("region", { name: STUDIO })).toBeInTheDocument();
});

function Offerer() {
  const panel = useRightPanel();
  return (
    <>
      <button type="button" onClick={() => panel.offer({ kind: "plan", planId: "pl1" })}>
        Offer
      </button>
      <button type="button" onClick={() => panel.hold(true)}>
        Hold
      </button>
      <button type="button" onClick={() => panel.open({ kind: "make", shape: "quiz" })}>
        Make
      </button>
      <p>Showing {panel.view ? panel.view.kind : "nothing"}</p>
    </>
  );
}

test("an offered plan opens only while the column is free: not over a make sheet, not while a player holds it", async () => {
  const { RightPanelProvider } = await import("./rightPanel");
  const { render } = await import("@testing-library/react");
  const one = render(
    <RightPanelProvider>
      <Offerer />
    </RightPanelProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Offer" }));
  expect(screen.getByText("Showing plan")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Make" }));
  await userEvent.click(screen.getByRole("button", { name: "Offer" }));
  expect(screen.getByText("Showing make")).toBeInTheDocument();
  one.unmount();
  render(
    <RightPanelProvider>
      <Offerer />
    </RightPanelProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Hold" }));
  await userEvent.click(screen.getByRole("button", { name: "Offer" }));
  expect(screen.getByText("Showing nothing")).toBeInTheDocument();
});
