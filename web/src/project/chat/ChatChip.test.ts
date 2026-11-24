import { readFileSync } from "node:fs";

test("on a phone the model chip hides its lead words and keeps the full name for assistive tech", () => {
  const css = readFileSync("src/project/chat/chat.css", "utf8");
  expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.cpick \.cpick-lead \{ display: none; \}/);
});
