import { describe, expect, it } from "vitest";
import { NOTHING_READ, canReadAgain } from "../src/sources/failure";

describe("whether a failed source is worth reading again", () => {
  it("is for a link, which may open next time", () => {
    expect(canReadAgain({ url: "https://example.test/x" }, `${NOTHING_READ} This page could not be opened.`)).toBe(true);
  });

  it("is not for a file whose reading finished and found nothing", () => {
    expect(canReadAgain({}, `${NOTHING_READ} This kind of file could not be read.`)).toBe(false);
  });

  it("is for a file whose reading broke off", () => {
    expect(canReadAgain({}, "The reading timed out.")).toBe(true);
  });
});
