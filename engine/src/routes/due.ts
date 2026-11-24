/**
 * What is due across the person's plans (docs/api.md, "Due"): stages they
 * gave a day, with something left, that fell before today, fall today, or
 * fall in the next few days. `today` is the person's day, sent by their app.
 *
 *   GET /v1/due?today=YYYY-MM-DD[&ahead=7] → 200 { today, stages: [...] }
 */
import { authenticate, errorResponse, json } from "../http";
import { isDay } from "../studio/days";
import { dueStages } from "../studio/schedule";
import type { EngineDeps } from "../wiring";

const DEFAULT_AHEAD = 7;
const MAX_AHEAD = 60;

export async function listDue(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const query = new URL(request.url).searchParams;
  const today = query.get("today");
  if (!isDay(today)) return errorResponse("invalid_request", "today must be a day written YYYY-MM-DD", 400);
  const rawAhead = query.get("ahead");
  const ahead = rawAhead === null ? DEFAULT_AHEAD : /^\d{1,3}$/.test(rawAhead) ? Number(rawAhead) : undefined;
  if (ahead === undefined || ahead > MAX_AHEAD) return errorResponse("invalid_request", `ahead must be a whole number of days up to ${MAX_AHEAD}`, 400);
  return json({ today, stages: await dueStages(deps.repos, auth.ownerId, today, ahead) });
}
