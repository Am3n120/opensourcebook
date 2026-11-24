import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { FormatDescriptor, JsonObject } from "../api/types";
import { renderWithEngine } from "../test/renderWithEngine";
import { sampleMakeTimes, sampleProviders, sampleVideoFormat, sampleVoiceSetup } from "../test/fakeEngine";
import { MadeByBox } from "./MadeByBox";

function Harness({ format = sampleVideoFormat, start = { minutes: 3 }, seen = () => undefined }: { format?: FormatDescriptor; start?: JsonObject; seen?: (s: JsonObject) => void }) {
  const [settings, setSettings] = useState<JsonObject>(start);
  return (
    <MadeByBox
      format={format}
      settings={settings}
      onChange={(next) => {
        seen(next);
        setSettings(next);
      }}
    />
  );
}

const row = (name: RegExp) => screen.getAllByRole("button").find((b) => name.test(b.textContent ?? ""))!;

test("it starts from the person's default for the shape, says so, and gives the time from runs here", async () => {
  renderWithEngine(<Harness />);
  expect(await screen.findByText("Your default for videos")).toBeInTheDocument();
  const maker = row(/Zeta Agent/);
  expect(maker).toHaveTextContent("Z Mid · medium effort");
  await waitFor(() => expect(maker).toHaveTextContent("about 4 min"));
  expect(maker).toHaveTextContent("for 3 min · from your last 5");
  expect(row(/Reviewed by/)).toHaveTextContent("None · add one if you want a second look");
  await waitFor(() => expect(screen.getByText("about 4 min", { selector: ".mb-total b" })).toBeInTheDocument());
});

test("the voice row shows the voice set up, and its row opens the voice picker where it is", async () => {
  renderWithEngine(<Harness />);
  await waitFor(() => expect(row(/^Voice/)).toHaveTextContent("Hosted A · Warm"));
  await userEvent.click(row(/^Voice/));
  const picker = await screen.findByRole("dialog", { name: "Voice" });
  expect(picker).toHaveTextContent("One voice speaks every video and audio.");
  await userEvent.click(await within(picker).findByRole("radio", { name: /Bright/ }));
  await waitFor(() => expect(row(/^Voice/)).toHaveTextContent("Hosted A · Bright"));
});

test("with no voice set up it says so, the row opens the picker, and a link goes to Settings > Voice", async () => {
  renderWithEngine(<Harness />, { "GET /v1/voice": { ...sampleVoiceSetup, service: undefined, voice: undefined, from: "none" } });
  await waitFor(() => expect(row(/^Voice/)).toHaveTextContent("Not set up"));
  expect(screen.getByRole("link", { name: "Set up voice" })).toHaveAttribute("href", "/settings#voice");
  await userEvent.click(row(/^Voice/));
  const picker = await screen.findByRole("dialog", { name: "Voice" });
  expect(await within(picker).findByRole("link", { name: /On this computer, not set up/ })).toHaveAttribute("href", "/settings?voice=local-b#voice");
});

test("a shape that is not spoken has no voice row, and one with no reviewer has no review row", async () => {
  const quiet: FormatDescriptor = { ...sampleVideoFormat, voiced: undefined, settings: sampleVideoFormat.settings.filter((f) => f.key !== "reviewer") };
  renderWithEngine(<Harness format={quiet} />);
  await screen.findByText(/Zeta Agent/);
  expect(screen.queryByText("Voice")).toBeNull();
  expect(screen.queryByText("Reviewed by")).toBeNull();
});

test("a pick made here changes this thing's settings and its time, and writes no default", async () => {
  const seen = vi.fn();
  const { calls } = renderWithEngine(<Harness seen={seen} />);
  await waitFor(() => expect(row(/Zeta Agent/)).toHaveTextContent("about 4 min"));
  await userEvent.click(row(/Zeta Agent/));
  const dialog = await screen.findByRole("dialog", { name: "Made by, for videos" });
  await userEvent.click(within(dialog).getByRole("option", { name: /Z Small/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Use this" }));
  expect(seen).toHaveBeenLastCalledWith({ minutes: 3, agent: "agent:zeta:z-small", effort: "medium" });
  await waitFor(() => expect(row(/Zeta Agent/)).toHaveTextContent("Z Small · medium effort"));
  expect(row(/Zeta Agent/)).toHaveTextContent("about 3 min");
  expect(screen.queryByText("Your default for videos")).toBeNull();
  expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
});

test("a reviewer can be added for this thing and the total adds its time; with no run it says no time yet", async () => {
  const seen = vi.fn();
  renderWithEngine(<Harness seen={seen} />);
  await waitFor(() => expect(row(/Zeta Agent/)).toHaveTextContent("about 4 min"));
  await userEvent.click(row(/Reviewed by/));
  const dialog = await screen.findByRole("dialog", { name: "Reviewed by, for videos" });
  await userEvent.click(within(dialog).getByRole("tab", { name: "Zeta Agent" }));
  await userEvent.click(within(dialog).getByRole("option", { name: /Z Big/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Use this" }));
  expect(seen).toHaveBeenLastCalledWith({ minutes: 3, reviewer: "agent:zeta:z-big", reviewEffort: "medium" });
  await waitFor(() => expect(row(/Reviewed by/)).toHaveTextContent("Zeta Agent · Z Big · medium effort"));
  expect(screen.getByText("In all: no time yet")).toBeInTheDocument();
});

test("with no runs here at all the total says no time yet, never a guess", async () => {
  renderWithEngine(<Harness start={{ minutes: 15 }} />, { "GET /v1/make-times": { times: sampleMakeTimes.filter((t) => t.scope === "chat") } });
  await waitFor(() => expect(screen.getByText("In all: no time yet")).toBeInTheDocument());
  expect(row(/Zeta Agent/)).toHaveTextContent("no time yet");
});

test("with no default and nothing picked, the row asks who makes it", async () => {
  renderWithEngine(<Harness />, { "GET /v1/providers": { ...sampleProviders, picks: {} } });
  await waitFor(() => expect(row(/Pick who makes it/)).toBeInTheDocument());
  expect(screen.queryByText("Your default for videos")).toBeNull();
});
