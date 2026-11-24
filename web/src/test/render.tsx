import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { App } from "../App";
import { ApiProvider } from "../app/api";
import { baseRoutes, fakeEngine, type Handler } from "./fakeEngine";

/** Renders the whole app at `path` against a fake engine. */
export function renderApp(path: string, routes: Record<string, Handler>) {
  const engine = fakeEngine({ ...baseRoutes, ...routes });
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <ApiProvider client={engine.client}>
        <App />
      </ApiProvider>
    </MemoryRouter>,
  );
  return { ...utils, ...engine };
}
