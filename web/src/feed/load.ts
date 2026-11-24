import type { ApiClient } from "../api/client";
import { isApiError, isUnreachable } from "../api/errors";
import type { Item, PlanView } from "../api/types";
import { dueIn } from "../player/spacing";
import type { FeedEntry } from "./order";

/**
 * Everything made, with where each sits: its project, its plan item's place,
 * done tick and kept progress. A thing an item made again later is left out:
 * the item's own output is the one that counts, as on the plan.
 */
export async function loadFeed(client: ApiClient): Promise<FeedEntry[]> {
  const [outputs, projects] = await Promise.all([client.all((q) => client.listOutputs(q), 500), client.all((q) => client.listProjects(q), 500)]);
  const planIds = [...new Set(outputs.map((o) => o.planId).filter((id): id is string => !!id))];
  const plans = new Map<string, PlanView>();
  await Promise.all(
    planIds.map(async (id) => {
      try {
        plans.set(id, await client.getPlan(id));
      } catch (error) {
        // A plan that cannot be read leaves its things in the feed without a tick; losing the computer stops it all.
        if (isUnreachable(error)) throw error;
      }
    }),
  );
  const titles = new Map(projects.map((p) => [p.id, p.title]));
  const entries: FeedEntry[] = [];
  const now = Date.now();
  for (const output of outputs) {
    const view = output.planId ? plans.get(output.planId) : undefined;
    const item: Item | undefined = view?.items.find((i) => i.id === output.itemId);
    if (item && item.outputId && item.outputId !== output.id) continue;
    if (item && !item.enabled) continue;
    const projectTitle = output.projectId ? titles.get(output.projectId) : undefined;
    entries.push({
      output,
      ...(projectTitle ? { projectTitle } : {}),
      ...(view?.plan.title ? { planTitle: view.plan.title } : {}),
      ...(item ? { place: { level: item.level, ord: item.ord } } : {}),
      done: item?.done === true,
      ...(item?.progress !== undefined ? { progress: item.progress } : {}),
      // Cards due now, read from what is kept (a thing with no cards has none): what a feed order can bring up first.
      ...(item?.progress !== undefined && dueIn(item.progress, now) > 0 ? { due: dueIn(item.progress, now) } : {}),
    });
  }
  return entries;
}

/** Why the feed cannot be shown: the computer is away, or this device is not paired (any more). */
export type Reach = "ok" | "away" | "unpaired";

export function reachOf(error: unknown): Reach {
  if (isApiError(error, "not_paired")) return "unpaired";
  if (isUnreachable(error) || isApiError(error, "web_unreachable") || (isApiError(error) && [502, 503, 504].includes(error.status))) return "away";
  return "ok";
}
