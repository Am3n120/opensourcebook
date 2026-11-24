import { sampleProviders } from "../../test/fakeEngine";
import { pickerState } from "./providerLoad";

test("Set up a provider only once the engine has answered that none can answer, and a failed load says it couldn't reach the engine", () => {
  expect(pickerState(undefined, "loading", false)).toBe("waiting");
  expect(pickerState(undefined, "failed", false)).toBe("failed");
  expect(pickerState(sampleProviders, "loading", false)).toBe("waiting");
  expect(pickerState(sampleProviders, "ready", false)).toBe("setUp");
  expect(pickerState(sampleProviders, "ready", true)).toBe("picker");
  expect(pickerState({ ...sampleProviders, connector: { configured: true, reachable: false } }, "ready", true)).toBe("unreachable");
  expect(pickerState({ ...sampleProviders, connector: { configured: false, reachable: false } }, "ready", true)).toBe("none");
});
