/**
 * Picture generators, behind a registry like the voices: each says whether it can run with the settings at hand, what
 * it is good at, and makes one picture from words in a shape (tall, square, wide), optionally guided by reference
 * pictures. Muse Image (with META_API_KEY) is the only one today; another generator is one more entry here.
 */
import { metaFromEnv, museImage, type Shape } from "./meta.ts";

export interface Reference {
  bytes: Buffer;
  type: string;
  name: string;
}

export interface GeneratorContext {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface Generator {
  id: string;
  label: string;
  /** What it does well, for the agent to choose by. */
  strengths: string;
  available(env: NodeJS.ProcessEnv): boolean;
  make(prompt: string, shape: Shape, references: Reference[], x: GeneratorContext): Promise<Buffer>;
}

const muse: Generator = {
  id: "muse-image",
  label: "Muse Image",
  strengths: "illustrations and scenes in any look, clean diagrams and infographics, accurate lettering when asked for; takes up to 10 reference pictures for a look or a subject to keep",
  available: (env) => !!env.META_API_KEY?.trim(),
  make: (prompt, shape, references, x) => museImage(metaFromEnv(x.env, x.fetch)!, prompt, shape, references, x.signal),
};

export const GENERATORS: Generator[] = [muse];

export const generatorsFor = (env: NodeJS.ProcessEnv) => GENERATORS.filter((g) => g.available(env));
