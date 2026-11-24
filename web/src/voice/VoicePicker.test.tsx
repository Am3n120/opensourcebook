import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { VoiceSetup } from "../api/types";
import { renderWithEngine } from "../test/renderWithEngine";
import { sampleVoiceSetup } from "../test/fakeEngine";
import { VoicePicker } from "./VoicePicker";

function Harness({ changed = () => undefined }: { changed?: (s: VoiceSetup) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" ref={setAnchor}>
        Open voice
      </button>
      {open && <VoicePicker anchor={anchor} onChange={changed} onClose={() => setOpen(false)} />}
    </>
  );
}

const installed = { ...sampleVoiceSetup, services: sampleVoiceSetup.services.map((s) => (s.id === "local-b" ? { ...s, installed: true } : s)) };
const dialog = () => screen.findByRole("dialog", { name: "Voice" });

test("it lists the services in the engine's order, the current one ticked with its voices, and one that is not set up with the way to set it up", async () => {
  renderWithEngine(<Harness />);
  const box = await dialog();
  const services = await within(box).findAllByRole("radio", { name: /Hosted A|On this computer/ });
  expect(services[0]).toHaveTextContent("Hosted A");
  expect(services[0]).toHaveAttribute("aria-checked", "true");
  const off = within(box).getByRole("link", { name: /On this computer, not set up/ });
  expect(off).toHaveTextContent("Not set up");
  expect(off).toHaveTextContent("Set up");
  expect(off).toHaveAttribute("href", "/settings?voice=local-b#voice");
  const voices = await within(box).findByRole("radiogroup", { name: "Hosted A voices" });
  expect(within(voices).getByRole("radio", { name: /Warm/ })).toHaveAttribute("aria-checked", "true");
  expect(within(voices).getByRole("radio", { name: /Bright/ })).toHaveAttribute("aria-checked", "false");
  expect(within(voices).getByRole("button", { name: "Play Warm" })).toBeInTheDocument();
  expect(box).toHaveTextContent("One voice speaks every video and audio.");
  expect(within(box).getByRole("link", { name: "Keys and more in Settings, under Voice" })).toHaveAttribute("href", "/settings#voice");
});

test("a service that offers no samples shows no play button on any of its voices", async () => {
  renderWithEngine(<Harness />, { "GET /v1/voice": { ...sampleVoiceSetup, services: sampleVoiceSetup.services.map((s) => (s.id === "hosted-a" ? { ...s, samples: false } : s)) } });
  const box = await dialog();
  const voices = await within(box).findByRole("radiogroup", { name: "Hosted A voices" });
  expect(within(voices).getByRole("radio", { name: /Warm/ })).toBeInTheDocument();
  expect(within(voices).queryByRole("button", { name: /^Play / })).not.toBeInTheDocument();
});

test("a voice picked here is the voice, and the caller hears of it", async () => {
  const changed = vi.fn();
  const { calls } = renderWithEngine(<Harness changed={changed} />);
  const voices = await within(await dialog()).findByRole("radiogroup", { name: "Hosted A voices" });
  await userEvent.click(within(voices).getByRole("radio", { name: /Bright/ }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(calls.find((c) => c.method === "PUT" && c.path === "/v1/voice")?.body).toEqual({ service: "hosted-a", voice: "v2" });
  await waitFor(() => expect(within(voices).getByRole("radio", { name: /Bright/ })).toHaveAttribute("aria-checked", "true"));
});

test("a service that is ready can be picked on the spot", async () => {
  const changed = vi.fn();
  const { calls } = renderWithEngine(<Harness changed={changed} />, { "GET /v1/voice": installed, "PUT /v1/voice": { ...installed, service: "local-b", voice: undefined } });
  const box = await dialog();
  await userEvent.click(await within(box).findByRole("radio", { name: /On this computer/ }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(calls.find((c) => c.method === "PUT" && c.path === "/v1/voice")?.body).toEqual({ service: "local-b" });
  expect(changed.mock.calls[0]![0].service).toBe("local-b");
  expect(within(box).queryByRole("link", { name: /not set up/ })).toBeNull();
});

test("with no voice chosen nothing is marked, and Escape closes it", async () => {
  renderWithEngine(<Harness />, { "GET /v1/voice": { ...sampleVoiceSetup, service: undefined, voice: undefined, from: "none" } });
  const box = await dialog();
  const hosted = await within(box).findByRole("radio", { name: /Hosted A/ });
  expect(hosted).toHaveAttribute("aria-checked", "false");
  expect(within(box).queryByRole("radiogroup", { name: /voices/ })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});
