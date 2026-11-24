import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { JsonObject, Output } from "../api/types";
import { now } from "../test/fakeEngine";
import { AudioPlayer } from "./AudioPlayer";
import { asAudio, sentencesOf } from "./audioData";
import type { PlayerProps } from "./players";
import { renderPlayer } from "./registry";

/** Words for a text, each 400 ms long, starting at `at`. */
function timed(text: string, at: number) {
  return text.split(" ").map((t, i) => ({ text: t, startMs: at + i * 400, endMs: at + i * 400 + 380 }));
}
const p1 = "The river broke its banks. It moved east!";
const p2 = "This is an aside. Rivers often do that.";
const payload: JsonObject = {
  schemaVersion: 1,
  title: "How the river moved",
  about: "Why the river moved east.",
  parts: [
    { id: "p1", title: "The flood", text: p1, background: false, cites: [{ sourceId: "s1", quote: "the river broke its banks", locator: { charStart: 10, charEnd: 35 } }], startMs: 0, endMs: 4000, words: timed(p1, 0) },
    { id: "p2", title: "Why rivers move", text: p2, background: true, cites: [], startMs: 4000, endMs: 8000, words: timed(p2, 4000) },
  ],
  file: { assetId: "a1", url: "/v1/assets/a1", contentType: "audio/mp4", durationMs: 8000 },
};

function output(p: JsonObject = payload): Output {
  return { id: "o1", type: "audio", title: "River audio", schemaVersion: 1, costUsd: 0, createdAt: now, updatedAt: now, payload: p, citations: [], sources: [] } as unknown as Output;
}

let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    fireEvent.play(this);
    return Promise.resolve();
  });
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    fireEvent.pause(this);
  });
});
afterEach(() => vi.restoreAllMocks());

function draw(props: Partial<PlayerProps> = {}, p?: JsonObject) {
  const all: PlayerProps = { output: output(p), finish: null, sources: [{ id: "s1", name: "River notes" }], go: vi.fn(), ...props };
  const utils = render(
    <MemoryRouter>
      <AudioPlayer {...all} />
    </MemoryRouter>,
  );
  const el = utils.container.querySelector("audio") as HTMLAudioElement | null;
  return { ...utils, el, props: all };
}

/** Sets the file's length and time as a browser would, then tells the player. */
function at(el: HTMLAudioElement, seconds: number, event: "timeUpdate" | "loadedMetadata" = "timeUpdate", duration = 8) {
  Object.defineProperty(el, "duration", { configurable: true, value: duration });
  el.currentTime = seconds;
  fireEvent[event](el);
}

test("draws the parts and their sentences, from the file at its own address", () => {
  const { el } = draw();
  expect(el).toHaveAttribute("src", "/api/v1/assets/a1");
  expect(el).toHaveAttribute("preload", "metadata");
  // Each part says where it is in the whole; the title is the chrome's.
  expect(screen.getByRole("heading", { name: "Part 1 of 2 · The flood" })).toBeInTheDocument();
  const flood = screen.getByRole("region", { name: "The flood" });
  expect(within(flood).getAllByTitle("Play from here").map((s) => s.textContent)).toEqual(["The river broke its banks.", "It moved east!"]);
  // Outside a chrome it draws its own line along the bottom, broken where the second part begins.
  expect(screen.getByRole("slider", { name: "Where you are" })).toBeInTheDocument();
  expect(document.querySelectorAll(".pc-mark")).toHaveLength(1);
});

test("the play button plays and pauses", async () => {
  const { el } = draw();
  await userEvent.click(screen.getByRole("button", { name: "Play" }));
  expect(play).toHaveBeenCalledTimes(1);
  Object.defineProperty(el!, "paused", { configurable: true, value: false });
  await userEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(pause).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
});

test("a tapped sentence plays from its first word", async () => {
  const { el } = draw();
  at(el!, 0, "loadedMetadata");
  await userEvent.click(screen.getByText("Rivers").closest("[role=button]")!);
  expect(el!.currentTime).toBeCloseTo(5.6);
  expect(play).toHaveBeenCalled();
});

test("a sentence plays from the keyboard too", async () => {
  const { el } = draw();
  at(el!, 0, "loadedMetadata");
  (screen.getByText("moved").closest("[role=button]") as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(el!.currentTime).toBeCloseTo(2.0);
  expect(play).toHaveBeenCalled();
});

test("the word being said is marked", () => {
  const { el } = draw();
  at(el!, 0.9);
  // 0.9 s is the third word of the first part ("broke", 0.8 to 1.18 s).
  const word = screen.getByText("broke");
  expect(word).toHaveAttribute("aria-current", "true");
  expect(word).toHaveClass("on");
  expect(word.closest(".asent")).toHaveClass("on");
  at(el!, 4.5);
  expect(screen.getByText("broke")).not.toHaveAttribute("aria-current");
  expect(screen.getByText("is")).toHaveAttribute("aria-current", "true");
});

test("starts where the person stopped, unless that was the very end", () => {
  const { el } = draw({ progress: { time: 5 } });
  at(el!, 0, "loadedMetadata");
  expect(el!.currentTime).toBe(5);
  expect(screen.getByText("0:05")).toBeInTheDocument();
  const end = draw({ progress: { time: 7.5 } }).el!;
  at(end, 0, "loadedMetadata");
  expect(end.currentTime).toBe(0);
});

test("keeps the time on pause, and reports where it is as it plays", () => {
  const keep = vi.fn();
  const here = vi.fn();
  const { el } = draw({ keep, here });
  at(el!, 3.24);
  expect(here).toHaveBeenLastCalledWith({ time: 3.2 });
  fireEvent.pause(el!);
  expect(keep).toHaveBeenLastCalledWith({ time: 3.2 });
});

test("playing to the end ticks the item done and keeps the start", () => {
  const keep = vi.fn();
  const complete = vi.fn();
  const { el } = draw({ keep, complete, progress: { time: 4 } });
  fireEvent.ended(el!);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(keep).toHaveBeenLastCalledWith({ time: 0 });
});

test("back 15 seconds, never before the start", async () => {
  const { el } = draw();
  at(el!, 6, "loadedMetadata", 30);
  el!.currentTime = 20;
  await userEvent.click(screen.getByRole("button", { name: "Back 15 seconds" }));
  expect(el!.currentTime).toBe(5);
  await userEvent.click(screen.getByRole("button", { name: "Back 15 seconds" }));
  expect(el!.currentTime).toBe(0);
});

test("speed steps through its choices, sets the rate and is remembered", async () => {
  const { el, unmount } = draw();
  const speed = () => screen.getByRole("button", { name: /^Speed/ });
  expect(speed()).toHaveTextContent("1×");
  await userEvent.click(speed());
  expect(speed()).toHaveTextContent("1.25×");
  expect(el!.playbackRate).toBe(1.25);
  for (const want of ["1.5×", "1.75×", "2×", "0.75×", "1×"]) {
    await userEvent.click(speed());
    expect(speed()).toHaveTextContent(want);
  }
  await userEvent.click(speed());
  unmount();
  const again = draw().el!;
  expect(again.playbackRate).toBe(1.25);
});

test("a background part is marked as not from the sources, and has no cites", () => {
  draw();
  const aside = screen.getByRole("region", { name: "Why rivers move" });
  expect(within(aside).getByText(/^Background, not from your sources:/)).toBeInTheDocument();
  expect(within(aside).queryByRole("button", { name: /^Source/ })).not.toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "The flood" })).queryByText(/not from your sources/)).not.toBeInTheDocument();
});

test("a part's cites open the exact words, or link to the source", async () => {
  const onOpenCite = vi.fn();
  const { unmount } = draw({ onOpenCite });
  await userEvent.click(screen.getByRole("button", { name: /^Source 1: River notes/ }));
  expect(onOpenCite).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "s1", quote: "the river broke its banks" }));
  unmount();
  draw();
  expect(screen.getByRole("link", { name: /^Source 1: River notes/ })).toHaveAttribute("href", "/sources/s1?at=10-35&quote=the+river+broke+its+banks");
});

test("in a feed it waits to be played, with no hint, and pauses when scrolled away", () => {
  const keep = vi.fn();
  const { el, rerender, props } = draw({ autoplay: true, active: true, keep });
  expect(play).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Play" })).toHaveTextContent("");
  el!.currentTime = 3;
  rerender(
    <MemoryRouter>
      <AudioPlayer {...props} active={false} />
    </MemoryRouter>,
  );
  expect(pause).toHaveBeenCalled();
  expect(keep).toHaveBeenLastCalledWith({ time: 3 });
});

test("keys: space plays, left goes back 15 seconds; down is left to the chrome around it", async () => {
  const go = vi.fn();
  const { el } = draw({ go, next: { outputId: "o2", title: "Next" } });
  at(el!, 20, "loadedMetadata", 30);
  await userEvent.keyboard(" ");
  expect(play).toHaveBeenCalled();
  await userEvent.keyboard("{ArrowLeft}");
  expect(el!.currentTime).toBe(5);
  await userEvent.keyboard("{ArrowDown}");
  expect(go).not.toHaveBeenCalled();
});

test("offers its slot for asking about the spot, once, with the time", () => {
  const aboutHere = vi.fn(() => <button type="button">Ask here</button>);
  const { el } = draw({ aboutHere });
  at(el!, 2.5);
  expect(screen.getAllByRole("button", { name: "Ask here" })).toHaveLength(1);
  expect(aboutHere).toHaveBeenLastCalledWith({ time: 2.5 });
});

test("the media session carries the title and controls, and lets go on unmount", () => {
  const handlers = new Map<string, unknown>();
  const session = { metadata: null as unknown, playbackState: "none", setActionHandler: vi.fn((a: string, h: unknown) => handlers.set(a, h)), setPositionState: vi.fn() };
  Object.defineProperty(navigator, "mediaSession", { configurable: true, value: session });
  vi.stubGlobal("MediaMetadata", class { constructor(public init: object) {} });
  const { unmount } = draw();
  expect((session.metadata as { init: object }).init).toEqual({ title: "How the river moved", artist: "Open Sourcebook", album: "The flood" });
  for (const a of ["play", "pause", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack"]) expect(handlers.get(a)).toBeTypeOf("function");
  unmount();
  expect([...handlers.values()].every((h) => h === null)).toBe(true);
  delete (navigator as { mediaSession?: unknown }).mediaSession;
  vi.unstubAllGlobals();
});

test("one with no file says so and still shows its words", () => {
  const { el } = draw({}, { ...payload, file: undefined } as unknown as JsonObject);
  expect(el).toBeNull();
  expect(screen.getByText("This audio has no file yet.")).toBeInTheDocument();
  expect(screen.getByText("Rivers")).toBeInTheDocument();
});

test("the registry plays audio", () => {
  const drawn = renderPlayer([], "audio", { output: output(), finish: null, sources: [], go: () => undefined });
  render(<MemoryRouter>{drawn}</MemoryRouter>);
  expect(screen.getByLabelText("How the river moved")).toBeInTheDocument();
});

describe("audioData", () => {
  const w = (texts: string[]) => texts.map((text, i) => ({ text, startMs: i * 100, endMs: i * 100 + 90 }));

  test("a sentence ends at . ! or ?, before closing quotes or brackets; the last run ends one anyway", () => {
    const words = w(["He", "said", "“stop.”", "Then", "(quietly!)", "Why?", "and", "then"]);
    expect(sentencesOf(words)).toEqual([
      { startMs: 0, from: 0, to: 3 },
      { startMs: 300, from: 3, to: 5 },
      { startMs: 500, from: 5, to: 6 },
      { startMs: 600, from: 6, to: 8 },
    ]);
    expect(sentencesOf(w(["e.g", "3.5", "units"]))).toEqual([{ startMs: 0, from: 0, to: 3 }]);
    expect(sentencesOf([])).toEqual([]);
  });

  test("reads a bad payload without throwing", () => {
    expect(asAudio({})).toEqual({ title: "", about: "", lengthNote: "", parts: [] });
    expect(asAudio(undefined)).toMatchObject({ parts: [] });
    expect(asAudio({ parts: "nope", file: { url: 3 } } as unknown as JsonObject)).toMatchObject({ parts: [] });
    const read = asAudio({ parts: [{ text: "Hi there. Bye", startMs: 1000, endMs: 4000, words: "junk", background: true, cites: [{ sourceId: "s1" }] }, "junk", null] } as unknown as JsonObject);
    expect(read.parts).toHaveLength(1);
    expect(read.file).toBeUndefined();
    const part = read.parts[0]!;
    // Words with no times are spread over the part; a background part is never cited.
    expect(part).toMatchObject({ id: "p1", title: "", background: true, cites: [], startMs: 1000, endMs: 4000 });
    expect(part.words.map((x) => x.startMs)).toEqual([1000, 2000, 3000]);
    expect(part.sentences).toEqual([{ startMs: 1000, from: 0, to: 2 }, { startMs: 3000, from: 2, to: 3 }]);
    expect(asAudio({ parts: [{ words: [{ text: "Ok.", startMs: -5, endMs: "x" }, { text: 4 }] }] } as unknown as JsonObject).parts[0]).toMatchObject({ text: "Ok.", words: [{ text: "Ok.", startMs: 0, endMs: 0 }] });
  });
});
