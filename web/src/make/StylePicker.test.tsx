import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithEngine } from "../test/renderWithEngine";
import { formats, sampleVideoFormat } from "../test/fakeEngine";
import { StylePicker } from "./StylePicker";
import { firstSentence } from "./styles";
import { StyleRow } from "./StyleRow";

test("the styles are the engine's, with their pictures through the proxy, and Use names the one picked", async () => {
  const onChange = vi.fn();
  const onClose = vi.fn();
  renderWithEngine(<StylePicker value={null} onChange={onChange} onClose={onClose} />);
  const group = await screen.findByRole("radiogroup", { name: "Style" });
  expect(screen.getByRole("dialog", { name: "Pick a style for this video" })).toBeInTheDocument();
  expect([...group.querySelectorAll("b")].map((b) => b.textContent)).toEqual(["Maker's pick", "Chalkboard", "Ink"]);
  expect(screen.getByRole("radio", { name: /Maker's pick/ })).toHaveAttribute("aria-checked", "true");
  expect([...group.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
    "/api/v1/video-makers/scenes/styles/chalk/preview",
    "/api/v1/video-makers/scenes/styles/ink/preview",
  ]);
  await userEvent.click(screen.getByRole("radio", { name: /Ink/ }));
  await userEvent.click(screen.getByRole("button", { name: "Use Ink" }));
  expect(onChange).toHaveBeenCalledWith("ink");
  expect(onClose).toHaveBeenCalled();
});

test("a new style in the engine's list shows up with nothing else changed", async () => {
  const style = sampleVideoFormat.settings[1] as { options: object[] };
  const more = { ...sampleVideoFormat, settings: [sampleVideoFormat.settings[0], { ...style, options: [...style.options, { value: "neon", label: "Neon", preview: "/v1/x/neon" }] }] };
  renderWithEngine(<StylePicker value="chalk" onChange={() => {}} onClose={() => {}} />, { "GET /v1/formats": { formats: [more, ...formats.slice(1)] } });
  expect(await screen.findByRole("radio", { name: /Neon/ })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /Chalkboard/ })).toHaveAttribute("aria-checked", "true");
});

test("the style row shows the style's picture and name, and Change opens the picker", async () => {
  const onChange = vi.fn();
  renderWithEngine(<StyleRow value="chalk" onChange={onChange} />);
  const row = await screen.findByRole("button", { name: "Style: Chalkboard. Change" });
  expect(row.querySelector("img")?.getAttribute("src")).toBe("/api/v1/video-makers/scenes/styles/chalk/preview");
  await userEvent.click(row);
  await userEvent.click(screen.getByRole("radio", { name: /Ink/ }));
  await userEvent.click(screen.getByRole("button", { name: "Use Ink" }));
  expect(onChange).toHaveBeenCalledWith("ink");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("with no style offered the row is not drawn", async () => {
  const { container } = renderWithEngine(<StyleRow value={null} onChange={() => {}} />, { "GET /v1/formats": { formats } });
  await new Promise((r) => setTimeout(r, 20));
  expect(container).toBeEmptyDOMElement();
});

test("a card shows a style's first sentence, More shows the rest, and the pick it opened on comes first", async () => {
  const style = sampleVideoFormat.settings[1] as { options: Array<{ value: string; description?: string }> };
  const long = { ...sampleVideoFormat, settings: [sampleVideoFormat.settings[0], { ...style, options: style.options.map((o) => (o.value === "ink" ? { ...o, description: "Fine pen lines on warm paper. Each stroke swells and tapers. Labels sit beside what they name." } : o)) }] };
  renderWithEngine(<StylePicker value="ink" onChange={() => {}} onClose={() => {}} />, { "GET /v1/formats": { formats: [long, ...formats.slice(1)] } });
  const group = await screen.findByRole("radiogroup", { name: "Style" });
  expect([...group.querySelectorAll("b")].map((b) => b.textContent)).toEqual(["Ink", "Maker's pick", "Chalkboard"]);
  const ink = screen.getByRole("radio", { name: /Ink/ });
  expect(ink).toHaveTextContent("Fine pen lines on warm paper.");
  expect(ink).not.toHaveTextContent("Each stroke");
  await userEvent.click(screen.getByRole("button", { name: "More about Ink" }));
  expect(ink).toHaveTextContent("Labels sit beside what they name.");
  // One sentence has no More.
  expect(screen.queryByRole("button", { name: "More about Chalkboard" })).toBeNull();
  // Picking another never moves the cards.
  await userEvent.click(screen.getByRole("radio", { name: /Chalkboard/ }));
  expect([...group.querySelectorAll("b")].map((b) => b.textContent)).toEqual(["Ink", "Maker's pick", "Chalkboard"]);
});

test("the first sentence ends at its full stop, and a text with one sentence has no more", () => {
  expect(firstSentence("A teacher's slate: chalk on a dark board. It reads well.")).toEqual({ first: "A teacher's slate: chalk on a dark board.", more: true });
  expect(firstSentence("Scale 1.5 is fine here")).toEqual({ first: "Scale 1.5 is fine here", more: false });
  // One long sentence is cut at a pause, and More has the rest.
  expect(firstSentence("A teacher's slate: chalk on a dark green board that keeps the ghost of old lessons, lines gone over twice, shapes hatched.")).toEqual({ first: "A teacher's slate: chalk on a dark green board that keeps the ghost of old lessons…", more: true });
  expect(firstSentence("An engineer's drawing: fine white drafting lines that run past their corners on a deep blue gridded sheet, parts hatched.").first).toBe("An engineer's drawing: fine white drafting lines that run past their corners on a deep blue gridded…");
});
