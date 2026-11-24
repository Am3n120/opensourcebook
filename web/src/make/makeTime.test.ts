import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { ApiProvider } from "../app/api";
import { fakeEngine, now, redesignRoutes } from "../test/fakeEngine";
import { findTime, timeResult, timeWords, totalWords, useMakeTime, type MakeTimeQuery } from "./makeTime";

const row = { scope: "video", agent: "a", model: "m", effort: "medium", bucket: "le4", runs: 5, seconds: 252, lastAt: now };
const key: MakeTimeQuery = { scope: "video", agent: "a", model: "m", effort: "medium", bucket: "le4" };

test("a time is found only for the exact key: no other model, effort or length stands in", () => {
  expect(findTime([row], key)).toBe(row);
  expect(findTime([row], { ...key, model: "other" })).toBeUndefined();
  expect(findTime([row], { ...key, effort: "high" })).toBeUndefined();
  expect(findTime([row], { ...key, bucket: "le7" })).toBeUndefined();
  expect(findTime([row], { ...key, bucket: undefined })).toBeUndefined();
  expect(findTime([{ ...row, model: undefined }], { ...key, model: undefined })).toBeDefined();
});

test("words: about N min from your last N, or no time yet, and nothing while it is not known", () => {
  expect(timeWords(timeResult([row], key))).toEqual({ text: "about 4 min", sub: "from your last 5", muted: false });
  expect(timeWords(timeResult([{ ...row, runs: 1, seconds: 30 }], key))).toEqual({ text: "about 30 sec", sub: "from your last run", muted: false });
  expect(timeWords(timeResult([], key))).toEqual({ text: "no time yet", sub: "none made here", muted: true });
  expect(timeWords(timeResult(undefined, key))).toBeUndefined();
  expect(timeWords(timeResult(null, key))).toBeUndefined();
});

test("a total is said only when every part has a time", () => {
  const found = timeResult([row], key);
  expect(totalWords([found, timeResult([{ ...row, seconds: 120 }], key)])).toEqual({ text: "about 6 min", muted: false });
  expect(totalWords([found, { status: "none" }])).toMatchObject({ text: "no time yet" });
  expect(totalWords([found, { status: "loading" }])).toBeUndefined();
});

function wrapper(routes = redesignRoutes) {
  const engine = fakeEngine(routes);
  return { engine, wrapper: ({ children }: { children: ReactNode }) => createElement(ApiProvider, { client: engine.client, children }) };
}

test("useMakeTime asks the engine for the scope's times and looks the key up", async () => {
  const { engine, wrapper: w } = wrapper();
  const { result } = renderHook(() => useMakeTime({ scope: "video", agent: "zeta", model: "z-mid", effort: "medium", bucket: "le4" }), { wrapper: w });
  expect(result.current).toEqual({ status: "loading" });
  await waitFor(() => expect(result.current.status).toBe("found"));
  expect(timeWords(result.current)?.text).toBe("about 4 min");
  expect(engine.calls.find((c) => c.path === "/v1/make-times")?.query.get("scope")).toBe("video");
});

test("an engine without the route has kept no times; any other failure says nothing", async () => {
  const missing = wrapper({});
  const a = renderHook(() => useMakeTime({ scope: "quiz", agent: "a" }), { wrapper: missing.wrapper });
  await waitFor(() => expect(a.result.current).toEqual({ status: "none" }));
  const broken = wrapper({ "GET /v1/make-times": [500, { error: "x", message: "x" }] });
  const b = renderHook(() => useMakeTime({ scope: "quiz", agent: "a" }), { wrapper: broken.wrapper });
  await waitFor(() => expect(b.result.current).toEqual({ status: "unknown" }));
});
