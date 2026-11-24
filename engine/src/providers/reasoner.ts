/**
 * `Reasoner` over the existing text providers (the router, or any one
 * `StructuredProvider`). The underlying adapters already log their own usage
 * with tokens, so this layer adds no event of its own; it adds the abort and
 * budget checks every media call has.
 *
 * The text providers take no pictures alongside a JSON prompt, so this
 * adapter does not see images and refuses a request that carries them. Vision
 * review (rendered stills, candidate pictures) needs an adapter that sends
 * images with the prompt; that is part of the provider choice for video.
 * `effort` has no counterpart in the text providers and is not sent.
 */
import type { StructuredProvider } from "../types/provider";
import type { MediaCallContext, Reasoner, ReasonRequest } from "../types/media";
import { assertWithinBudget, MediaCapabilityError } from "./media";

export class StructuredReasoner implements Reasoner {
  readonly seesImages = false;

  constructor(private readonly provider: StructuredProvider) {}

  get name(): string {
    return this.provider.name;
  }

  async reasonJSON<T>(request: ReasonRequest, ctx: MediaCallContext): Promise<T> {
    if (request.images && request.images.length > 0) {
      throw new MediaCapabilityError(`${this.provider.name} cannot look at images`);
    }
    ctx.signal?.throwIfAborted();
    // Token cost is only known after the call, so only an empty budget refuses.
    assertWithinBudget(ctx, undefined);
    const result = await this.provider.generateJSON<T>({
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      ...(request.task ? { task: request.task } : {}),
    });
    ctx.signal?.throwIfAborted();
    return result;
  }
}
