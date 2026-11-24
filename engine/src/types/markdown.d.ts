/** Markdown files are bundled as their text (wrangler.toml's Text rule; vitest.config.ts does the same). */
declare module "*.md" {
  const text: string;
  export default text;
}
