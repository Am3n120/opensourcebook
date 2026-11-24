import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { now } from "../test/fakeEngine";
import { renderApp } from "../test/render";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><rect width="29" height="29" fill="#fff"/><path d="M4 4h7v7H4z"/></svg>';
const iphone = { id: "ab12", name: "iPhone, Safari", pairedAt: now, lastSeenAt: now };
const on = { on: true, address: "http://192.168.1.23:5180", code: { url: "http://192.168.1.23:5180/pair#abc", expiresAt: "2026-11-12T10:10:00.000Z", svg }, devices: [iphone] };

test("Open on your phone turns listening on and shows the code, the address and the plain-HTTP line", async () => {
  const { calls } = renderApp("/settings#phone", { "GET /phone": { on: false, devices: [] }, "POST /phone/on": on });
  const section = await screen.findByRole("region", { name: "Phone" });
  expect(await within(section).findByText(/Open Sourcebook listens on this computer only/)).toBeInTheDocument();
  // The shared filled button, as everywhere else.
  expect(within(section).getByRole("button", { name: "Open on your phone" })).toHaveClass("pbtn");
  await userEvent.click(within(section).getByRole("button", { name: "Open on your phone" }));
  const qr = await within(section).findByRole("img", { name: "QR code to open Open Sourcebook on your phone" });
  expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  expect(decodeURIComponent(qr.getAttribute("src")!)).toContain("<path");
  expect(section).toHaveTextContent("http://192.168.1.23:5180");
  expect(section).toHaveTextContent("not encrypted");
  // The pairing code itself is only in the picture.
  expect(section.textContent).not.toContain("pair#abc");
  expect(calls.some((c) => c.method === "POST" && c.path === "/phone/on")).toBe(true);
});

test("the paired devices are listed, and one can be removed", async () => {
  const { calls } = renderApp("/settings#phone", { "GET /phone": on, "DELETE /phone/devices/:id": { ...on, devices: [] }, "POST /phone/off": { on: false, devices: [] } });
  const list = await screen.findByRole("list", { name: "Paired devices" });
  expect(list).toHaveTextContent("iPhone, Safari");
  await userEvent.click(within(list).getByRole("button", { name: "Remove iPhone, Safari" }));
  expect(await screen.findByText("None yet.")).toBeInTheDocument();
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/phone/devices/ab12")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Stop listening on the network" }));
  expect(await within(screen.getByRole("region", { name: "Phone" })).findByRole("button", { name: "Open on your phone" })).toBeInTheDocument();
});

test("without the launcher, it says how to start Open Sourcebook", async () => {
  renderApp("/settings#phone", { "GET /phone": [503, { error: "phone_unavailable", message: "x" }] });
  expect(await screen.findByText(/needs it started the usual way/)).toBeInTheDocument();
});
