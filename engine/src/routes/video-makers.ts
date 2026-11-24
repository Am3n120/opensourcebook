/**
 * Video makers (docs/api.md, "Video makers"; DECISIONS #54).
 *
 *   GET /v1/video-makers                               → 200 { makers }   who can make videos here, and whether each can now
 *   GET /v1/video-makers/:maker/styles/:style/preview  → 200 image/*      a picture of one of a maker's styles
 *
 * The picture comes from the maker's own service on this computer, which
 * clients cannot reach or hold the token of; the engine passes it on.
 */
import { authenticate, errorResponse, json } from "../http";
import type { EngineDeps } from "../wiring";

export async function listVideoMakers(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const registry = deps.videoMakers;
  if (!registry) return json({ makers: [] });
  const fallback = registry.default()?.id;
  const makers = await Promise.all(
    registry.list().map(async (maker) => {
      const status = maker.status ? await maker.status(request.signal).catch(() => ({ available: false, problem: `${maker.label} did not answer.` })) : { available: true };
      return {
        id: maker.id,
        label: maker.label,
        description: maker.description,
        ...(maker.local ? { local: true } : {}),
        ...(maker.id === fallback ? { default: true } : {}),
        styles: maker.styles().length,
        available: status.available,
        ...(status.problem ? { problem: status.problem } : {}),
        ...("agent" in status && status.agent ? { agent: status.agent } : {}),
        ...("notice" in status && status.notice ? { notice: status.notice } : {}),
      };
    }),
  );
  return json({ makers });
}

export async function styleSample(request: Request, makerId: string, styleId: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const maker = deps.videoMakers?.get(makerId);
  if (!maker?.preview || !maker.styles().some((style) => style.id === styleId)) return errorResponse("not_found", "No such style", 404);
  const picture = await maker.preview(styleId, request.signal).catch(() => undefined);
  if (!picture?.body) return errorResponse("not_found", "That style has no picture right now", 404);
  const type = picture.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) return errorResponse("not_found", "That style has no picture right now", 404);
  return new Response(picture.body, { status: 200, headers: { "content-type": type, "cache-control": "private, max-age=3600" } });
}
