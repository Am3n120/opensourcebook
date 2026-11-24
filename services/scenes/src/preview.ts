/**
 * A picture of each style: one real frame of a fixed small sample scene, drawn in that style, about 360 by 640 (a
 * third of the portrait frame), rendered on first ask and kept on disk.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { buildScene, type SceneContext } from "./scene.ts";
import { renderStills } from "../pipeline/stages/scene.ts";
import { estimate } from "./voice.ts";

export const NARRATION = "Every style draws the same scene its own way, with its own lines, colours and letters.";
export const SAMPLE = `@0
text t "A sample" role=title
row r gap=70
  circle a "idea" w=300
  box b "example" w=340 h=240
arrow a -> b
@6 keep
text ans "one look" role=answer
mark ring b
`;

const inflight = new Map<string, Promise<string>>();

export function stylePreview(style: string, dataDir: string): Promise<string> {
  const file = join(dataDir, "previews", `${style}.jpg`);
  if (existsSync(file)) return Promise.resolve(file);
  let made = inflight.get(style);
  if (!made) {
    made = (async () => {
      const folder = join(dataDir, "previews", `.${style}`);
      mkdirSync(folder, { recursive: true });
      const c: SceneContext = { title: "Sample", idea: "", brief: "", style, frame: { width: 1080, height: 1920 }, scene: { id: "s1", narration: NARRATION, onScreenText: [], visual: "A sample", cites: [] }, timing: estimate(NARRATION) };
      const built = await buildScene(c, SAMPLE, folder);
      if (!built.scene) throw new Error(`the sample scene does not build in ${style}: ${built.problems.join("; ")}`);
      const [still] = await renderStills(built.scene, built.theme, [built.scene.frames - 5], folder, 1 / 3);
      renameSync(still!, file);
      return file;
    })().finally(() => inflight.delete(style));
    inflight.set(style, made);
  }
  return made;
}
