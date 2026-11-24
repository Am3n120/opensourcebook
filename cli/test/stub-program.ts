// A stand-in program for the launcher's tests (a test fixture, not part of Open Sourcebook): answers /up on its port. Each start
// adds one to a counter file; while the count is within EXIT_FIRST it answers and then exits with code 3 half a
// second later, like a program that crashes.
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.STUB_PORT);
const counter = process.env.STUB_COUNTER!;
appendFileSync(counter, "x");
const starts = readFileSync(counter, "utf8").length;
const exitFirst = Number(process.env.STUB_EXIT_FIRST ?? 0);
createServer((_req, res) => res.end("{}")).listen(port, "127.0.0.1", () => {
  if (starts <= exitFirst) setTimeout(() => process.exit(3), 500);
});
// A helper in the same group that survives a polite stop, like a runtime left behind by a dev server.
setInterval(() => undefined, 1000);
