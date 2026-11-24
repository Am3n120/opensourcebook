import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { now } from "../test/fakeEngine";
import { renderApp } from "../test/render";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><rect width="29" height="29" fill="#fff"/><path d="M4 4h7v7H4z"/></svg>';
const iphone = { id: "ab12", name: "iPhone, Safari", pairedAt: now, lastSeenAt: now };
const on = { on: true, address: "http://192.168.1.23:5180", code: { url: "http://192.168.1.23:5180/pair#abc", expiresAt: "2026-11-12T10:10:00.000Z", svg }, devices: [iphone] };

test("the footer link opens a dialog with the real code, the three steps, the caution and the paired count", async () => {
  renderApp("/", { "GET /v1/projects": { projects: [] }, "GET /phone": on });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(within(screen.getByRole("contentinfo")).getByRole("button", { name: "Open on your phone" }));
  const dialog = await screen.findByRole("dialog", { name: "Open on your phone" });
  const qr = await within(dialog).findByRole("img", { name: "QR code to open Open Sourcebook on your phone" });
  expect(decodeURIComponent(qr.getAttribute("src")!)).toContain("<path");
  expect(within(dialog).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
    "Be on the same Wi-Fi as this computer.",
    "Point your phone's camera at the code and open the link.",
    "Your phone opens your projects, then the Library tab to watch what you made.",
  ]);
  expect(dialog).toHaveTextContent("The code works once, until");
  expect(dialog).toHaveTextContent("Each phone pairs once and stays paired.");
  expect(dialog).toHaveTextContent("Plain HTTP on your home network");
  expect(dialog).toHaveTextContent("1 phone paired");
  expect(within(dialog).getByRole("link", { name: "Paired phones in Settings" })).toHaveAttribute("href", "/settings#phone");
  // The pairing code itself is only in the picture.
  expect(dialog.textContent).not.toContain("pair#abc");
});

test("New code and Stop listening call the phone control; Escape closes without changing anything", async () => {
  const { calls } = renderApp("/", {
    "GET /v1/projects": { projects: [] },
    "GET /phone": on,
    "POST /phone/code": on,
    "POST /phone/off": { on: false, devices: [] },
  });
  await userEvent.click(within(screen.getByRole("contentinfo")).getByRole("button", { name: "Open on your phone" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(await within(dialog).findByRole("button", { name: "New code" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/phone/code")).toBe(true);
  await userEvent.click(within(dialog).getByRole("button", { name: "Stop listening on the network" }));
  expect(await within(dialog).findByText(/listens on this computer only/)).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("while listening is off, nothing turns it on until the person presses the button", async () => {
  const { calls } = renderApp("/", { "GET /v1/projects": { projects: [] }, "GET /phone": { on: false, devices: [] }, "POST /phone/on": on });
  await userEvent.click(within(screen.getByRole("contentinfo")).getByRole("button", { name: "Open on your phone" }));
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText(/listens on this computer only/)).toBeInTheDocument();
  expect(calls.some((c) => c.path === "/phone/on")).toBe(false);
  await userEvent.click(within(dialog).getByRole("button", { name: "Open on your phone" }));
  expect(await within(dialog).findByRole("img", { name: /QR code/ })).toBeInTheDocument();
});

test("without the launcher it says how to start Open Sourcebook", async () => {
  renderApp("/", { "GET /v1/projects": { projects: [] }, "GET /phone": [503, { error: "phone_unavailable", message: "x" }] });
  await userEvent.click(within(screen.getByRole("contentinfo")).getByRole("button", { name: "Open on your phone" }));
  expect(await screen.findByText(/needs it started the usual way/)).toBeInTheDocument();
});
