import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Markdown is imported as its text, as wrangler bundles it (wrangler.toml, [[rules]]).
  plugins: [
    {
      name: "markdown-as-text",
      enforce: "pre",
      load(id) {
        const path = id.split("?")[0]!;
        return path.endsWith(".md") ? `export default ${JSON.stringify(readFileSync(path, "utf8"))};` : undefined;
      },
    },
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
