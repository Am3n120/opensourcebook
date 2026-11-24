/**
 * Meta's API, for the toolbox's paid tools: Muse Image (a picture from words), SAM 3.1 (a thing cut out of a picture
 * by name) and Muse Spark with its web search. Only the calls, their retries and their fields are here: no cost
 * ledger and no stage timings. The key is `META_API_KEY`, read from the environment; nothing here runs without it.
 */
import { decodeMaskToRaster, parseImageStream, recordsOfKind, type ResponsesEvent } from "@meta-sam/parser";

export interface MetaConfig {
  key: string;
  base: string;
  fetch: typeof fetch;
}

export function metaFromEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): MetaConfig | undefined {
  const key = env.META_API_KEY?.trim();
  return key ? { key, base: (env.META_BASE_URL?.trim() || "https://api.meta.ai/v1").replace(/\/$/, ""), fetch: fetchImpl } : undefined;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
});

/** POST with retries on network errors, 429 (honouring Retry-After) and 5xx. Other errors throw with the body. */
export async function post(m: MetaConfig, path: string, body: unknown, signal?: AbortSignal, tries = 4): Promise<any> {
  for (let i = 1; ; i++) {
    let res: Response;
    let text = "";
    try {
      res = await m.fetch(`${m.base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${m.key}`, ...(body instanceof FormData ? {} : { "content-type": "application/json" }) },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(110_000), ...(signal ? [signal] : [])]),
      });
      text = await res.text();
    } catch (e) {
      if (i >= tries || signal?.aborted) throw e;
      await sleep(3000 * i, signal);
      continue;
    }
    if (res.ok) return JSON.parse(text);
    if ((res.status === 429 || res.status >= 500) && i < tries) {
      await sleep(Number(res.headers.get("retry-after")) * 1000 || 2000 * 2 ** (i - 1), signal);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error(`Meta refused the key (${res.status}); check META_API_KEY.`);
    throw new Error(`Meta ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Muse Image.

/** Aspect ratios Muse Image honours; it decides the pixel size itself (about 2.5 megapixels). */
export const SHAPES = { tall: "1152x2048", square: "1024x1024", wide: "2048x1152" } as const;
export type Shape = keyof typeof SHAPES;

/** One picture from a prompt, as JPEG bytes. With references, through /images/edits, which takes up to 10. */
export async function museImage(m: MetaConfig, prompt: string, shape: Shape, references: { bytes: Buffer; type: string; name: string }[] = [], signal?: AbortSignal): Promise<Buffer> {
  const fields = { model: "muse-image-1.0", size: SHAPES[shape], n: 1, response_format: "b64_json", output_format: "jpeg", reasoning_strength: "low", tool_enablement: { enable_web_search: false, enable_image_search: false, enable_shell: false } };
  let r: any;
  if (references.length) {
    // /images/edits is multipart: object fields as JSON strings, each reference as image[i] (found by trying it).
    const form = new FormData();
    for (const [k, v] of Object.entries({ ...fields, prompt })) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    references.slice(0, 10).forEach((ref, i) => form.append(`image[${i}]`, new Blob([new Uint8Array(ref.bytes)], { type: ref.type }), ref.name));
    r = await post(m, "/images/edits", form, signal);
  } else r = await post(m, "/images/generations", { ...fields, prompt }, signal);
  const b64 = r.data?.[0]?.b64_json;
  if (!b64) throw new Error("Muse Image sent no picture back (often a refused prompt); change the prompt.");
  return Buffer.from(b64, "base64");
}

// ---------------------------------------------------------------------------------------------------------------------
// SAM 3.1.

/** One mask: a raster the size of its box (1 where the thing is), and the box in pixels of the picture sent. */
export interface Mask {
  raster: Uint8Array;
  width: number;
  height: number;
  bounds: { left: number; top: number; right: number; bottom: number };
  confidence?: number;
}

// The SAM parser reads a Responses event stream; a reply that was not streamed is replayed as one delta.
async function* asEvents(text: string): AsyncIterable<ResponsesEvent> {
  const lane = { item_id: "m", output_index: 0, content_index: 0 };
  yield { type: "response.output_text.delta", ...lane, delta: text } as ResponsesEvent;
  yield { type: "response.output_text.done", ...lane, text } as ResponsesEvent;
  yield { type: "response.completed" } as ResponsesEvent;
}

/** Every mask SAM finds for a short noun phrase on a JPEG. Nothing found is an empty list, not an error. */
export async function samMasks(m: MetaConfig, jpeg: Buffer, phrase: string, signal?: AbortSignal): Promise<Mask[]> {
  const r = await post(m, "/responses", {
    model: "sam-3.1",
    store: false,
    metadata: { include_confidence: "true", mask_encoding: "lossless" },
    input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${jpeg.toString("base64")}` }, { type: "input_text", text: phrase }] }],
  }, signal);
  const text = r.output?.[0]?.content?.[0]?.text ?? "";
  const records = recordsOfKind((await parseImageStream(asEvents(text)).finalResult).records, "mask") as any[];
  return records.map((x) => ({ raster: decodeMaskToRaster(x.mask), width: x.mask.width, height: x.mask.height, bounds: { ...x.bounds }, confidence: x.confidence }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Muse Spark with web search.

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

/** Web results for a query, from Spark's own web search, as a list of pages (each URL is one it cited or returned). */
export async function sparkSearch(m: MetaConfig, query: string, n: number, signal?: AbortSignal): Promise<WebResult[]> {
  const schema = { type: "object", additionalProperties: false, required: ["results"], properties: { results: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "url", "snippet"], properties: { title: { type: "string" }, url: { type: "string" }, snippet: { type: "string" } } } } } };
  const r = await post(m, "/responses", {
    model: "muse-spark-1.3",
    store: false,
    reasoning: { effort: "low" },
    max_output_tokens: 6000,
    instructions: `Search the web and list up to ${n} pages that best match the query, most useful first. Only pages your search really returned, each with its exact URL, its title, and one or two sentences on what is on it. No commentary.`,
    input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [{ type: "web_search" }],
    text: { format: { type: "json_schema", name: "web_results", schema, strict: true } },
  }, signal);
  const messages = (r.output ?? []).filter((o: any) => o.type === "message");
  const content = messages.at(-1)?.content ?? [];
  const text = content.map((c: any) => c.text ?? "").join("");
  // Only URLs the search itself returned or cited are kept, so a result is never a made-up address.
  const seen = new Set<string>();
  for (const o of r.output ?? []) {
    for (const s of o.action?.sources ?? o.results ?? []) if (typeof s?.url === "string") seen.add(s.url);
    for (const c of o.content ?? []) for (const a of c.annotations ?? []) if (typeof a?.url === "string") seen.add(a.url);
  }
  let results: WebResult[] = [];
  try {
    results = ((JSON.parse(text) as { results?: WebResult[] }).results ?? []).filter((x) => /^https?:\/\//.test(x.url));
  } catch {
    results = [];
  }
  const grounded = seen.size ? results.filter((x) => seen.has(x.url) || [...seen].some((u) => sameHostPath(u, x.url))) : results;
  return grounded.slice(0, n);
}

function sameHostPath(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return x.hostname === y.hostname && x.pathname.replace(/\/$/, "") === y.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}
