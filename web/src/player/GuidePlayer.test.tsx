import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import type { ApiClient } from "../api/client";
import type { JsonObject, Output } from "../api/types";
import { Ctx } from "../app/context";
import { now } from "../test/fakeEngine";
import { GuidePlayer } from "./GuidePlayer";
import { asGuide, draftOf, editBody } from "./guideData";
import type { PlayerProps } from "./players";

const payload: JsonObject = {
  schemaVersion: 1,
  title: "Mitosis on one page",
  about: "What mitosis is and its stages.",
  lengthNote: "Your notes are short, so this is half a page.",
  sections: [
    {
      id: "s1",
      title: "What it is",
      points: [
        { id: "p1", term: "Mitosis", text: "One nucleus into **two** identical nuclei.", background: false, cites: [{ sourceId: "s1", quote: "the division of one cell nucleus", locator: { charStart: 0, charEnd: 30 } }] },
        { id: "p2", text: "A way to remember the order: PMAT.", background: true, cites: [] },
      ],
    },
    {
      id: "s2",
      title: "Stages",
      points: [
        { id: "p3", term: "Anaphase", text: "Chromatids pulled to the poles.", background: false, cites: [{ sourceId: "s1", quote: "pulled to opposite poles" }], yours: true, made: { term: "Anaphase", text: "Chromatids pulled apart." } },
        { id: "p4", text: "Ask about this in class.", background: false, cites: [], yours: true },
      ],
    },
  ],
};

function output(p: JsonObject = payload): Output {
  return { id: "o1", type: "guide", title: "Guide", schemaVersion: 1, costUsd: 0, createdAt: now, updatedAt: now, payload: p, citations: [], sources: [] } as unknown as Output;
}

function draw(props: Partial<PlayerProps> = {}, client?: Partial<ApiClient>) {
  const all: PlayerProps = { output: output(), finish: null, sources: [{ id: "s1", name: "Cell notes" }], go: vi.fn(), ...props };
  const wrap = (node: ReactNode) => (client ? <Ctx.Provider value={{ client: client as ApiClient, formats: [], edgeKinds: [], refreshInbox: () => undefined }}>{node}</Ctx.Provider> : node);
  return render(<MemoryRouter>{wrap(<GuidePlayer {...all} />)}</MemoryRouter>);
}

describe("GuidePlayer", () => {
  it("draws the page: headings, a strong term, inline marks, cites numbered across the page and listed at the end, and whose words each point is", () => {
    draw();
    expect(screen.getByRole("heading", { name: "Mitosis on one page" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What it is" })).toBeInTheDocument();
    expect(screen.getByText("Mitosis").tagName).toBe("STRONG");
    expect(screen.getByText("two").tagName).toBe("STRONG");
    expect(screen.getByText("Not from your sources")).toBeInTheDocument();
    // What the person changed or wrote is marked theirs.
    expect(screen.getAllByText("yours")).toHaveLength(2);
    expect(screen.getAllByText("yours")[0]).toHaveAttribute("title", "Changed by you");
    expect(screen.getByText(/half a page/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Source 1: Cell notes/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Source 2: Cell notes/ })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Sources" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("pulled to opposite poles")).toBeInTheDocument();
    // With nowhere to save, it cannot be changed here, but it can be printed.
    expect(screen.queryByRole("button", { name: "Change it" })).toBeNull();
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
  });

  it("prints only the page", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      expect(document.documentElement.classList.contains("gprint")).toBe(true);
      expect(document.querySelector("[data-printing]")?.getAttribute("aria-label")).toBe("Mitosis on one page");
    });
    draw();
    await userEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("afterprint"));
    expect(document.documentElement.classList.contains("gprint")).toBe(false);
    print.mockRestore();
  });

  it("is changed by hand on the page itself and kept whole when the person is done", async () => {
    const kept = { ...payload, title: "My mitosis notes", editedAt: "2026-11-20T10:00:00.000Z" };
    const editOutput = vi.fn(async () => output(kept));
    draw({}, { editOutput });
    await userEvent.click(screen.getByRole("button", { name: "Change it" }));
    expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
    const title = screen.getByRole("textbox", { name: "Title" });
    await userEvent.clear(title);
    await userEvent.type(title, "My mitosis notes");
    // A point opens in place; a changed one can have the maker's words put back.
    await userEvent.click(screen.getByRole("button", { name: "Change point 1 of section 2" }));
    const point = screen.getByRole("group", { name: "Changing point 1 of section 2" });
    expect(within(point).getByText(/the maker's words are kept so you can put them back/)).toBeInTheDocument();
    await userEvent.click(within(point).getByRole("button", { name: "Put the maker's words back" }));
    expect(within(point).getByRole("textbox", { name: "Point" })).toHaveValue("Chromatids pulled apart.");
    await userEvent.click(within(point).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Change point 2 of section 1" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Changing point 2 of section 1" })).getByRole("button", { name: "Remove" }));
    await userEvent.click(screen.getByRole("button", { name: "Move section 2 up" }));
    await userEvent.click(screen.getByRole("button", { name: "Done changing" }));
    expect(editOutput).toHaveBeenCalledWith("o1", {
      title: "My mitosis notes",
      sections: [
        { id: "s2", title: "Stages", points: [{ id: "p3", term: "Anaphase", text: "Chromatids pulled to the poles." }, { id: "p4", text: "Ask about this in class." }] },
        { id: "s1", title: "What it is", points: [{ id: "p1", term: "Mitosis", text: "One nucleus into **two** identical nuclei." }] },
      ],
    });
    expect(await screen.findByRole("heading", { name: "My mitosis notes" })).toBeInTheDocument();
    expect(screen.getByText(/Changed by you on/)).toBeInTheDocument();
  });

  it("saves a point's new words with Save, and stays open to change more", async () => {
    const editOutput = vi.fn(async (_id: string, body: JsonObject) => output({ ...payload, ...body }));
    draw({}, { editOutput });
    await userEvent.click(screen.getByRole("button", { name: "Change it" }));
    await userEvent.click(screen.getByRole("button", { name: "Change point 1 of section 1" }));
    const point = screen.getByRole("group", { name: "Changing point 1 of section 1" });
    await userEvent.clear(within(point).getByRole("textbox", { name: "Term" }));
    await userEvent.type(within(point).getByRole("textbox", { name: "Term" }), "Division");
    await userEvent.click(within(point).getByRole("button", { name: "Save" }));
    expect(editOutput).toHaveBeenCalledOnce();
    expect((editOutput.mock.calls[0]![1].sections as Array<{ points: Array<{ term?: string }> }>)[0]!.points[0]!.term).toBe("Division");
    expect(await screen.findByRole("button", { name: "Done changing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change point 1 of section 1" })).toHaveTextContent("Division");
    // Nothing more changed: done sends nothing.
    await userEvent.click(screen.getByRole("button", { name: "Done changing" }));
    expect(editOutput).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Change it" })).toBeInTheDocument();
  });

  it("says what the engine would not keep, and keeps the fields open", async () => {
    const editOutput = vi.fn(async () => {
      throw new Error("Section 1 needs a heading.");
    });
    draw({}, { editOutput });
    await userEvent.click(screen.getByRole("button", { name: "Change it" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Heading of section 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Done changing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Section 1 needs a heading.");
    expect(screen.getByRole("textbox", { name: "Title" })).toBeInTheDocument();
  });

  it("adds sections and points of the person's own, with no ids", () => {
    const draft = draftOf(asGuide(payload), "T");
    draft.sections.push({ key: "k", title: "Mine", points: [{ key: "k2", term: "", text: "A note.", cited: false }] });
    expect(editBody(draft).sections).toContainEqual({ title: "Mine", points: [{ text: "A note." }] });
  });

  it("reads a broken payload without throwing", () => {
    expect(asGuide({ sections: [{ points: [{ text: "" }, "x", { text: "ok" }] }, 3] } as unknown as JsonObject).sections).toEqual([
      { id: "s1", title: "", points: [{ id: "s1p1", term: "", text: "ok", background: false, cites: [], yours: false }] },
    ]);
  });

  it("says nothing about a change by you once every point is back to the maker's words", () => {
    const back: JsonObject = { ...payload, editedAt: "2026-11-01T10:00:00Z", sections: [{ id: "s1", title: "Stages", points: [{ id: "p3", term: "Anaphase", text: "Chromatids pulled apart.", background: false, cites: [], yours: true, made: { term: "Anaphase", text: "Chromatids pulled apart." } }] }] };
    draw({ output: output(back) });
    expect(screen.queryByText(/Changed by you on/)).not.toBeInTheDocument();
  });
});
