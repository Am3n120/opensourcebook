#!/usr/bin/env node
// The `opensourcebook` command. Plain JavaScript, so an old Node gets a plain sentence instead of a syntax error; the launcher
// itself is TypeScript (cli/main.ts), run by Node 24 directly.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`Open Sourcebook needs Node 24 or newer, and this is Node ${process.versions.node}. Install Node 24 from nodejs.org (or run "nvm install 24"), then run this again.`);
  process.exit(1);
}

try {
  const { main } = await import("./main.ts");
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Never a stack trace: one plain sentence. OPENSOURCEBOOK_DEBUG=1 shows the whole error for whoever is fixing the launcher.
  console.error(process.env.OPENSOURCEBOOK_DEBUG ? error : `Open Sourcebook could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
