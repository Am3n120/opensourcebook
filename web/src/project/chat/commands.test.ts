import type { ChatCommand } from "../../api/types";
import { bareCommand, chatCommandOf, firstSentence, matchCommands, pickedAlone } from "./commands";
import { ago, helpLine } from "./words";

const cmd = (command: string, title: string, group: ChatCommand["group"], format?: string): ChatCommand => ({ command, title, group, label: title, about: `${title}, in its own words`, skill: group, ...(format ? { format } : {}) });
// Listed by the engine out of group order, as a registry may.
const commands = [cmd("mindmap", "Map the ideas", "chat"), cmd("video", "video", "make", "video"), cmd("plan", "Plan a whole subject", "plan"), cmd("quiz", "quiz", "make", "quiz")];

test("lists what is made, then plans, then what answers in the chat, each group in the engine's order", () => {
  expect(matchCommands(commands).map((c) => c.command)).toEqual(["video", "quiz", "plan", "mindmap"]);
});

test("filters by the word after / or a word of the title", () => {
  expect(matchCommands(commands, "qu").map((c) => c.command)).toEqual(["quiz"]);
  expect(matchCommands(commands, "ideas").map((c) => c.command)).toEqual(["mindmap"]);
  expect(matchCommands(commands, "zzz")).toEqual([]);
});

test("alone, a shape opens its sheet, a plan opens a new plan, and the rest wait for words", () => {
  expect(commands.map(pickedAlone)).toEqual(["type", "sheet", "plan", "sheet"]);
  expect(bareCommand(" /Video ", commands)?.command).toBe("video");
  expect(bareCommand("/video on cells", commands)).toBeUndefined();
});

test("the line under the box names the first shapes the engine lists and a plan", () => {
  const formats = [{ id: "video", label: "video", singular: "explainer video" }, { id: "quiz", label: "quiz" }] as never;
  expect(helpLine(commands, formats)).toBe("Ask for an explainer video, a quiz or a plan here and its make sheet opens on the right, filled in.");
  expect(helpLine([], formats)).toBe("Ask about your sources here; every answer shows the spot it came from.");
});

test("how long ago a chat was used, in plain words", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  expect(ago("2026-11-22T11:59:30Z", now)).toBe("now");
  expect(ago("2026-11-22T11:40:00Z", now)).toBe("20 min ago");
  expect(ago("2026-11-21T10:00:00Z", now)).toBe("yesterday");
  expect(ago("2026-11-19T12:00:00Z", now)).toBe("3 days ago");
});

test("a reply's chat command: the skill it names, else the last command typed before it, as for a teach-back verdict the agent wrote", () => {
  const teach = { ...cmd("teachback", "Explain it back", "chat"), skill: "teachBack" };
  const all = [...commands, teach];
  const chat = [
    { id: "u0", role: "user" as const, text: "/teachback mitosis" },
    { id: "a1", role: "assistant" as const, text: "Explain it in your own words." },
    { id: "u2", role: "user" as const, text: "Mitosis splits one nucleus into two." },
    { id: "a3", role: "assistant" as const, text: "" },
  ];
  expect(chatCommandOf({ id: "a3" }, chat, all)).toBe(teach);
  expect(chatCommandOf({ id: "a3", skill: "teachBack" }, [], all)).toBe(teach);
  // A make or plan command, or none at all, is not one to start again.
  expect(chatCommandOf({ id: "a1" }, [{ id: "u0", role: "user", text: "/video cells" }, { id: "a1", role: "assistant", text: "" }], all)).toBeUndefined();
  expect(chatCommandOf({ id: "a1" }, [{ id: "u0", role: "user", text: "hello" }, { id: "a1", role: "assistant", text: "" }], all)).toBeUndefined();
});

test("a command's line is the first sentence of its registry text, whole", () => {
  expect(firstSentence("Checks your own explanation of an idea against your sources: what you got right, what you left out.")).toBe("Checks your own explanation of an idea against your sources");
  expect(firstSentence("Lays out the main ideas in your sources and how they connect, as a map you can tap: each idea opens the spot.")).toBe("Lays out the main ideas in your sources and how they connect, as a map you can tap");
  expect(firstSentence("A path through the sources. Shown first for you to look over.")).toBe("A path through the sources.");
  expect(firstSentence("cards to swipe and flip, brought back until they stick")).toBe("Cards to swipe and flip, brought back until they stick");
  expect(firstSentence("Version 1.5 is out. More soon.")).toBe("Version 1.5 is out.");
});

test("a command's line starts with a capital whatever the registry sends", () => {
  expect(firstSentence("lays out the main ideas.")).toBe("Lays out the main ideas.");
  expect(firstSentence("Already capital.")).toBe("Already capital.");
});
