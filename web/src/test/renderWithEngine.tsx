import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { ApiProvider } from "../app/api";
import { baseRoutes, fakeEngine, redesignRoutes, type Handler } from "./fakeEngine";

/** Renders a picker inside the app's data, against the redesign's sample engine. */
export function renderWithEngine(ui: ReactNode, routes: Record<string, Handler> = {}) {
  const engine = fakeEngine({ ...baseRoutes, ...redesignRoutes, ...routes });
  const utils = render(
    <MemoryRouter>
      <ApiProvider client={engine.client}>{ui}</ApiProvider>
    </MemoryRouter>,
  );
  return { ...utils, ...engine };
}
