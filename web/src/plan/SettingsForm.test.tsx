import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import type { AgentPickPatch, FormatDescriptor, JsonObject, Providers } from "../api/types";
import { SettingsForm } from "./SettingsForm";

// Shaped like the engine's quiz descriptor: every code comes with its words.
const quiz: FormatDescriptor = {
  id: "quiz", label: "quiz", colorSlot: 3, icon: "check", ready: true,
  settings: [
    {
      key: "kinds", label: "Question kinds", help: "Which kinds of question it may use.", kind: "choices", minItems: 1,
      options: [
        { value: "choice", label: "multiple choice", description: "Pick the one right answer from a few options." },
        { value: "worked", label: "worked, step-checked", description: "Work a problem through in steps." },
      ],
    },
    {
      key: "feedback", label: "Feedback", kind: "choice",
      options: [
        { value: "afterEach", label: "After each question", description: "Says right or wrong as soon as each question is answered." },
        { value: "atEnd", label: "At the end", description: "Holds every answer's feedback until the whole quiz is done." },
      ],
    },
    {
      key: "questions", label: "Questions", help: "How many.", kind: "number", min: 0, max: 80, step: 1,
      specialValues: [{ value: 0, label: "Fit to the brief", description: "Counted when it is made, from the brief and the sources." }],
    },
    { key: "someday", label: "Someday", kind: "slider" } as unknown as FormatDescriptor["settings"][number],
  ],
  defaults: { kinds: ["choice", "worked"], feedback: "afterEach", questions: 0 },
};

function Harness({ onChange }: { onChange: (s: JsonObject) => void }) {
  const [settings, setSettings] = useState<JsonObject>({});
  return (
    <SettingsForm
      format={quiz}
      settings={settings}
      onChange={(next) => {
        setSettings(next);
        onChange(next);
      }}
    />
  );
}

test("a choices setting is ticked from its options with what each does; the last one stays; a choice says what the pick does", async () => {
  const changes: JsonObject[] = [];
  render(<Harness onChange={(s) => changes.push(s)} />);
  const group = screen.getByRole("group", { name: "Question kinds" });
  expect(group).toHaveTextContent("Pick the one right answer from a few options.");
  expect(group).not.toHaveTextContent("worked,step");
  const worked = within(group).getByRole("checkbox", { name: /worked, step-checked/ });
  await userEvent.click(worked);
  expect(changes.at(-1)).toEqual({ kinds: ["choice"] });
  // At least one kind: the one left cannot be unticked.
  expect(within(group).getByRole("checkbox", { name: /multiple choice/ })).toBeDisabled();
  await userEvent.click(worked);
  // Back to the default: the key goes, so {} still means "the defaults".
  expect(changes.at(-1)).toEqual({});

  expect(screen.getByText("Says right or wrong as soon as each question is answered.")).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("Feedback"), "atEnd");
  expect(screen.getByText("Holds every answer's feedback until the whole quiz is done.")).toBeInTheDocument();
  // A kind of field this app does not know is left out.
  expect(screen.queryByText("Someday")).not.toBeInTheDocument();
});

test("a number's special value is a tick beside it: ticked, there is no number to type; unticked, a typed number replaces it", async () => {
  const changes: JsonObject[] = [];
  render(<Harness onChange={(s) => changes.push(s)} />);
  const fits = screen.getByRole("checkbox", { name: "Fit to the brief" });
  expect(fits).toBeChecked();
  expect(screen.queryByRole("spinbutton", { name: "Questions" })).not.toBeInTheDocument();
  // What the value means stands in for the field's help.
  expect(screen.getByText("Counted when it is made, from the brief and the sources.")).toBeInTheDocument();
  expect(screen.queryByText("How many.")).not.toBeInTheDocument();
  await userEvent.click(fits);
  // Unticking brings the number; nothing is stored until one is typed.
  expect(fits).not.toBeChecked();
  const count = screen.getByRole("spinbutton", { name: "Questions" });
  expect(changes).toHaveLength(0);
  await userEvent.type(count, "12");
  expect(changes.at(-1)).toEqual({ questions: 12 });
  expect(screen.getByText("How many.")).toBeInTheDocument();
  await userEvent.click(fits);
  expect(changes.at(-1)).toEqual({});
  expect(screen.queryByRole("spinbutton", { name: "Questions" })).not.toBeInTheDocument();
});

// Shaped like the engine's video descriptor with two makers, one of them with styles.
const video: FormatDescriptor = {
  id: "video", label: "video", colorSlot: 1, icon: "play", ready: true,
  settings: [
    {
      key: "maker", label: "Maker", help: "What makes the video.", kind: "choice",
      options: [
        { value: "auto", label: "Whichever is ready", description: "Uses the maker that can make it on this computer when it is made: now that is Drawn scenes." },
        { value: "other", label: "Another maker", description: "Makes it another way." },
        { value: "scenes", label: "Drawn scenes", description: "Your own agent draws the scenes. Takes about 5 to 15 minutes." },
      ],
    },
    {
      key: "style", label: "Style", help: "How the video looks.", kind: "choice", showWhen: { key: "maker", in: ["scenes"] },
      options: [
        { value: "auto", label: "Maker's pick", description: "The maker picks the look that suits the brief and the sources when it makes it." },
        { value: "chalk", label: "Chalkboard", description: "White chalk on green.", preview: "/v1/video-makers/scenes/styles/chalk/preview" },
        { value: "ink", label: "Ink", description: "Black ink on paper.", preview: "/v1/video-makers/scenes/styles/ink/preview" },
      ],
    },
  ],
  defaults: { maker: "auto", style: "auto" },
};

function VideoHarness({ onChange }: { onChange: (s: JsonObject) => void }) {
  const [settings, setSettings] = useState<JsonObject>({});
  return (
    <SettingsForm
      format={video}
      settings={settings}
      onChange={(next) => {
        setSettings(next);
        onChange(next);
      }}
    />
  );
}

test("a setting shown only for some values of another appears when that one is picked, and goes when it is not", async () => {
  const changes: JsonObject[] = [];
  render(<VideoHarness onChange={(s) => changes.push(s)} />);
  expect(screen.queryByRole("radiogroup", { name: "Style" })).toBeNull();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Maker" }), "scenes");
  expect(screen.getByRole("radiogroup", { name: "Style" })).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Maker" }), "other");
  expect(screen.queryByRole("radiogroup", { name: "Style" })).toBeNull();
  expect(changes.at(-1)).toEqual({ maker: "other" });
});

test("options with pictures are picked as cards: each a named radio with its picture through the proxy, the pick saying what it does", async () => {
  const changes: JsonObject[] = [];
  render(<VideoHarness onChange={(s) => changes.push(s)} />);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Maker" }), "scenes");
  const group = screen.getByRole("radiogroup", { name: "Style" });
  const cards = within(group).getAllByRole("radio");
  expect(cards.map((card) => (card.closest("label") as HTMLElement).textContent)).toEqual(["Maker's pick", "Chalkboard", "Ink"]);
  expect(within(group).getByRole("radio", { name: "Maker's pick" })).toBeChecked();
  // The pictures sit beside the names: no alt text to read twice.
  const pictures = group.querySelectorAll("img");
  expect([...pictures].map((img) => img.getAttribute("src"))).toEqual(["/api/v1/video-makers/scenes/styles/chalk/preview", "/api/v1/video-makers/scenes/styles/ink/preview"]);
  expect([...pictures].every((img) => img.getAttribute("alt") === "")).toBe(true);

  await userEvent.click(within(group).getByRole("radio", { name: "Chalkboard" }));
  expect(changes.at(-1)).toEqual({ maker: "scenes", style: "chalk" });
  expect(screen.getByText("White chalk on green.")).toBeInTheDocument();
  // Arrow keys move the pick, as in any radio group.
  await userEvent.keyboard("{ArrowRight}");
  expect(changes.at(-1)).toEqual({ maker: "scenes", style: "ink" });
  // Back to the default drops the key, so {} still means "the defaults".
  await userEvent.click(within(group).getByRole("radio", { name: "Maker's pick" }));
  expect(changes.at(-1)).toEqual({ maker: "scenes" });
});

const agentFormat: FormatDescriptor = {
  id: "explainer",
  label: "explainer",
  colorSlot: 1,
  icon: "play",
  ready: true,
  settings: [
    {
      key: "agent",
      label: "Agent & model",
      help: "Which agent, model, and thinking effort write and check it.",
      kind: "agent",
      effortKey: "effort",
      turnKind: "work",
    },
  ],
  defaults: {},
};

const sampleProviders: Providers = {
  connector: { configured: true, reachable: true },
  providers: [
    {
      id: "alpha",
      label: "Alpha Agent",
      added: true,
      enabled: true,
      state: "ready",
      headline: "Ready",
      default: true,
      defaultModel: "alpha-fast",
      workDefault: true,
      workDefaultModel: "alpha-balanced",
      workDefaultEffort: "high",
      pick: "agent:alpha",
      models: [
        { id: "alpha-fast", pick: "agent:alpha:alpha-fast", label: "Alpha Fast", shown: true, favorite: false, tier: "fast" },
        { id: "alpha-balanced", pick: "agent:alpha:alpha-balanced", label: "Alpha Balanced", shown: true, favorite: false, tier: "balanced" },
        { id: "alpha-strong", pick: "agent:alpha:alpha-strong", label: "Alpha Strong", shown: true, favorite: false, tier: "strong" },
      ],
      efforts: [
        { id: "low", label: "Low", weight: "light" },
        { id: "high", label: "High", weight: "high" },
      ],
    },
    {
      id: "beta",
      label: "Beta Agent",
      added: true,
      enabled: true,
      state: "ready",
      headline: "Ready",
      pick: "agent:beta",
      models: [{ id: "beta-strong", pick: "agent:beta:beta-strong", label: "Beta Strong", shown: true, favorite: false, tier: "strong" }],
      efforts: [{ id: "medium", label: "Medium", weight: "medium" }],
    },
  ],
};

test("kind='agent' renders safely without ApiProvider", () => {
  render(<SettingsForm format={agentFormat} settings={{}} onChange={() => undefined} />);
  expect(screen.getByText("Agent & model")).toBeInTheDocument();
  expect(screen.getByText(/Uses your connected agent's default/)).toBeInTheDocument();
});

test("kind='agent' lets you pick model and effort, shows rough time/usage without prices, clears incompatible effort across providers, and resets to default", async () => {
  const changes: JsonObject[] = [];
  const savedPicks: Array<{ scope: string; patch: AgentPickPatch }> = [];
  function AgentHarness() {
    const [settings, setSettings] = useState<JsonObject>({});
    return (
      <MemoryRouter>
        <SettingsForm
          format={agentFormat}
          settings={settings}
          providers={sampleProviders}
          onSavePick={(scope, patch) => savedPicks.push({ scope, patch })}
          onChange={(next) => {
            setSettings(next);
            changes.push(next);
          }}
        />
      </MemoryRouter>
    );
  }
  render(<AgentHarness />);
  expect(screen.getByText(/Roughly 10 to 15 minutes · moderate use of your plan\./)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/\$/);

  await userEvent.click(screen.getByRole("button", { name: /Model and effort: Alpha Agent, Alpha Balanced, High/ }));
  await userEvent.click(screen.getByRole("option", { name: "Alpha Strong" }));
  expect(changes.at(-1)).toEqual({ agent: "agent:alpha:alpha-strong" });
  expect(savedPicks.at(-1)).toEqual({ scope: "explainer", patch: { agent: "alpha", model: "alpha-strong" } });
  expect(screen.getByText(/Roughly 20 to 30 minutes · heavy use of your plan\./)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /Model and effort: Alpha Agent, Alpha Strong, High/ }));
  await userEvent.click(screen.getByRole("option", { name: "Low" }));
  expect(changes.at(-1)).toEqual({ agent: "agent:alpha:alpha-strong", effort: "low" });
  expect(savedPicks.at(-1)).toEqual({ scope: "explainer", patch: { agent: "alpha", model: "alpha-strong", effort: "low" } });

  // Switching to Beta clears Alpha's "low" effort so it cannot leak across providers.
  await userEvent.click(screen.getByRole("tab", { name: "Beta Agent" }));
  await userEvent.click(screen.getByRole("option", { name: "Beta Strong" }));
  expect(changes.at(-1)).toEqual({ agent: "agent:beta:beta-strong" });
  expect(savedPicks.at(-1)).toEqual({ scope: "explainer", patch: { agent: "beta", model: "beta-strong", effort: null } });

  await userEvent.click(screen.getByRole("button", { name: "Use default" }));
  expect(changes.at(-1)).toEqual({});
  expect(savedPicks.at(-1)).toEqual({ scope: "explainer", patch: { agent: null, model: null, effort: null } });
});
