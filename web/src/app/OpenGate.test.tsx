import { render, screen } from "@testing-library/react";
import { OpenGate } from "./OpenGate";

const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

test("a browser Open Sourcebook let in sees the app", async () => {
  render(<OpenGate fetchImpl={answering(200, { in: true, as: "browser" })}><p>the app</p></OpenGate>);
  expect(await screen.findByText("the app")).toBeInTheDocument();
});

test("a browser Open Sourcebook did not let in sees one plain page that says how to open it, first without a terminal and then the command, and not the app", async () => {
  render(<OpenGate fetchImpl={answering(401, { error: "not_opened", message: "words for other callers" })}><p>the app</p></OpenGate>);
  expect(await screen.findByRole("heading", { name: "Open this page from Open Sourcebook" })).toBeInTheDocument();
  const said = [...document.querySelectorAll("main p")].map((p) => p.textContent);
  expect(said[0]).toBe("Start Open Sourcebook again, the same way you started it before. It opens the right page for you.");
  expect(said[1]).toBe("If you use a terminal, the command is opensourcebook open, or npm run open in its folder.");
  expect(said.join(" ")).not.toMatch(/\bRe\b|npm start/);
  expect(screen.queryByText("words for other callers")).toBeNull();
  expect(screen.queryByText("the app")).toBeNull();
});

test("a web app that was not started by the launcher shows what the proxy says", async () => {
  render(<OpenGate fetchImpl={answering(503, { error: "not_set_up", message: "Open Sourcebook is not running yet." })}><p>the app</p></OpenGate>);
  expect(await screen.findByText("Open Sourcebook is not running yet.")).toBeInTheDocument();
  expect(screen.queryByText(/the same way you started it before/)).toBeNull();
  expect(screen.queryByText("the app")).toBeNull();
});

test("no answer at all shows the app, whose screens say the server is not reachable", async () => {
  const failing = (async () => {
    throw new TypeError("offline");
  }) as unknown as typeof fetch;
  render(<OpenGate fetchImpl={failing}><p>the app</p></OpenGate>);
  expect(await screen.findByText("the app")).toBeInTheDocument();
});
