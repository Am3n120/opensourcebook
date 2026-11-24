import type { Json, PlanView, Source } from "../api/types";
import { detailOf, marked, momentWords, matchMentions, mentionables, mentionAt, mentionList, mentionsIn, splitMentions, type Mentionable } from "./mentions";

const all: Mentionable[] = [
  { group: "Sources", key: "s1", name: "Lecture 7 · Independence", detail: "source" },
  { group: "Made", key: "i1", name: "Fix: independence, slower", detail: "Unit 1" },
  { group: "Plans", key: "p1", name: "Exam prep", detail: "draft" },
];

test("finds the @word being typed at the caret", () => {
  expect(mentionAt("redo @ind", 9)).toEqual({ start: 5, query: "ind" });
  expect(mentionAt("email@x", 7)).toBeUndefined();
  expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
});

test("matches names that start a word first, then names that contain the query", () => {
  expect(matchMentions(all, "ind").map((m) => m.key)).toEqual(["s1", "i1"]);
  expect(matchMentions(all, "prep").map((m) => m.key)).toEqual(["p1"]);
});

test("splits a message into text and known mentions, longest name first", () => {
  expect(splitMentions("redo @Exam prep and @Exam", ["Exam", "Exam prep"])).toEqual([
    { text: "redo ", mention: false },
    { text: "@Exam prep", mention: true },
    { text: " and ", mention: false },
    { text: "@Exam", mention: true },
  ]);
});

test("names in a message become the engine's mentions, each once", () => {
  const all: Mentionable[] = [
    { group: "Sources", key: "s:s1", name: "Week 3", detail: "source" },
    { group: "Chats", key: "c:c9", name: "Limits", detail: "2 messages" },
  ];
  expect(mentionsIn("compare @Week 3 with @Limits and @Week 3 again", all)).toEqual([
    { kind: "source", id: "s1", label: "Week 3" },
    { kind: "chat", id: "c9", label: "Limits" },
  ]);
  expect(mentionsIn("no mentions here", all)).toEqual([]);
});

test("what is playing in the Studio is suggested first, and only once", () => {
  const view = {
    plan: { id: "p1", projectId: "x", title: "Unit 1", version: 1, status: "running", createdAt: "", updatedAt: "" },
    items: [
      { id: "a", level: 1, ord: 0, type: "byte", title: "Limits", settings: {}, enabled: true, status: "done", sources: [], done: false, outputId: "o1" },
      { id: "b", level: 2, ord: 0, type: "quiz", title: "Check", settings: {}, enabled: true, status: "done", sources: [], done: false, outputId: "o2" },
    ],
  } as unknown as PlanView;
  const list = mentionables([], [view], [], "b");
  expect(list[0]).toMatchObject({ group: "Playing now", name: "Check" });
  expect(list.filter((m) => m.name === "Check")).toHaveLength(1);
});

test("each thing says what it is: a source whether the chat reads it, a made thing its shape and plan, this chat as this chat", () => {
  const view = {
    plan: { id: "p1", projectId: "x", title: "Unit 1", version: 1, status: "running", createdAt: "", updatedAt: "" },
    items: [{ id: "a", level: 1, ord: 0, type: "quiz", title: "Check", settings: {}, enabled: true, status: "done", sources: [], done: false, outputId: "o1" }],
  } as unknown as PlanView;
  const sources = [
    { id: "s1", projectId: "x", kind: "pdf", title: "Week 3", status: "ready", createdAt: "", updatedAt: "" },
    { id: "s2", projectId: "x", kind: "note", title: "Notes", status: "ready", createdAt: "", updatedAt: "" },
  ] as Source[];
  const chats = [{ id: "c1", projectId: "x", title: "Limits", messageCount: 14, createdAt: "", updatedAt: "" }];
  const list = mentionables(sources, [view], chats, undefined, { ticked: new Set(["s1"]), chatId: "c1", label: (f) => `the ${f}` });
  expect(list.map((m) => [m.group, m.detail])).toEqual([
    ["Sources", "pdf · ticked"],
    ["Sources", "note · not ticked: picking it ticks it"],
    ["Made", "the quiz · in Plan: Unit 1"],
    ["Plans", "1 item"],
    ["Chats", "this chat · 14 messages"],
  ]);
  expect(list[1]!.unticked).toBe(true);
});

test("marks the letters a query matched", () => {
  expect(marked("Cell checkpoints", "che")).toEqual([
    { text: "Cell ", hit: false },
    { text: "che", hit: true },
    { text: "ckpoints", hit: false },
  ]);
  expect(marked("Cell", "")).toEqual([{ text: "Cell", hit: false }]);
});

test("the All tab shows a few of every group, so chats are in view however much the project holds; a group's tab lists it all", () => {
  const many = (group: Mentionable["group"], n: number, word: string): Mentionable[] => Array.from({ length: n }, (_, i) => ({ group, key: `${group}${i}`, name: `${word} ${i}`, detail: "" }));
  const list = [...many("Playing now", 1, "Cells"), ...many("Sources", 3, "Notes"), ...many("Made", 9, "Quiz"), ...many("Plans", 1, "Path"), ...many("Chats", 10, "Talk")];
  const all = mentionList(list, "", 0);
  expect([...new Set(all.found.map((m) => m.group))]).toEqual(["Playing now", "Sources", "Made", "Plans", "Chats"]);
  expect(all.found.filter((m) => m.group === "Chats")).toHaveLength(4);
  expect(all.more).toEqual([
    { group: "Made", count: 5, tab: 2 },
    { group: "Chats", count: 6, tab: 4 },
  ]);
  const chats = mentionList(list, "", 4);
  expect(chats.found).toHaveLength(10);
  expect(chats.more).toEqual([]);
  expect(mentionList(list, "talk 7", 0).found.map((m) => m.name)).toEqual(["Talk 7"]);
});

test("Playing now says where the person is in it, read when the list is drawn: a time, a question, or nothing", () => {
  const view = {
    plan: { id: "p1", projectId: "x", title: "Unit 1", version: 1, status: "running", createdAt: "", updatedAt: "", direct: true },
    items: [{ id: "b", level: 2, ord: 0, type: "video", title: "Check", settings: {}, enabled: true, status: "done", sources: [], done: false, outputId: "o2" }],
  } as unknown as PlanView;
  let at: Json | undefined = { time: 72.4, scene: "s2" };
  const [row] = mentionables([], [view], [], "b", { label: () => "video", playingAt: () => at });
  expect(detailOf(row!)).toBe("video · at 1:12");
  at = { time: 3 };
  expect(detailOf(row!)).toBe("video · at 0:03");
  at = undefined;
  expect(detailOf(row!)).toBe("video");
  expect(momentWords({ at: 2, responses: [] })).toBe("question 3");
  expect(momentWords({ section: "a", point: "b" })).toBeUndefined();
  // Without a player to ask, the row is as it was.
  expect(detailOf(mentionables([], [view], [], "b", { label: () => "video" })[0]!)).toBe("video");
});
