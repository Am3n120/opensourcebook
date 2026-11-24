/**
 * List prices (USD per million tokens) for the models this engine is
 * configured to use. This is the only place prices live: to add or change one,
 * edit this table. A model not listed here is recorded as unpriced.
 *
 * Checked 2026-11-12 against the providers' own pages:
 *  - Google Gemini API, Standard paid tier, text:
 *    https://aistudio.google.com/docs/pricing (moved from ai.google.dev/gemini-api/docs/pricing).
 *    Output includes thinking tokens. gemini-3.6-flash and gemini-3.8-flash:
 *    $0.75 in / $3.75 out through 2026-12-31, then $1.50 / $7.50 from 2027-01-01.
 *    gemini-4-argon and gemini-4-carbon: $2 / $10, then $4 / $20 from 2026-12-01.
 *    Other current Gemini models are listed for when the config moves to them.
 *    Model ids for the Gemini 4 and 3.8 rows are inferred from the page's names
 *    (not confirmed against the API); the 3.6 row matches the configured id.
 *  - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing.
 *    `deepseek-v4-flash` is a retired name served and billed as deepseek-flash.
 *    Cache-miss input $0.15 off-peak / $0.30 peak, output $0.60 / $1.20. We use
 *    the peak rate (an upper bound); the adapter does not report cache hits.
 *  - Meta Muse Ember (`muse-ember-1.0`): https://research.meta.ai/blog/muse-ember,
 *    $0.10 in / $0.50 out for prompts up to 200K tokens (cached input $0.004).
 *    Above 200K the whole request costs $0.30 / $1.50; the table has no context
 *    tiers, so long prompts are under-priced here.
 *  - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (base
 *    input and output). claude-haiku-5-5 costs $0.50 / $2.50 for prompts over
 *    100K tokens; the table has no context tiers, so those are under-priced.
 *    Mythos models (limited availability) are left out.
 *  - OpenAI: https://developers.openai.com/api/docs/pricing (Standard tier). Rates
 *    above 272K input tokens are higher and not modeled. gpt-5.6-sol is left out:
 *    its listed price is promotional until 2026-11-30 and unclear.
 *  - OpenRouter ids for the newest models (anthropic/, google/gemini-4-carbon,
 *    meta/muse-ember, nex-agi/nex-n2.6, kt/midm-k-3.0-pro): list prices from
 *    https://openrouter.ai/models?order=newest on 2026-11-12.
 *  - OpenRouter: https://openrouter.ai/google/gemini-3.6-flash lists several
 *    upstream routes between $0.375 and $1.35 input. We use the Google AI Studio
 *    standard route ($0.75 / $3.75) with the same 2027 change as above; the real
 *    charge depends on the route OpenRouter picks.
 *
 * Billed units: the providers report input and output tokens only, so those
 * are the only units priced.
 */
import type { PriceTable } from "../types/provider";

const FLASH_36 = [
  { inputPerMillion: 0.75, outputPerMillion: 3.75 },
  { inputPerMillion: 1.5, outputPerMillion: 7.5, effectiveFrom: "2027-01-01" },
];
const GEMINI_4 = [
  { inputPerMillion: 2, outputPerMillion: 10 },
  { inputPerMillion: 4, outputPerMillion: 20, effectiveFrom: "2026-12-01" },
];

export const MODEL_PRICES: PriceTable = {
  // Configured today (wrangler.toml).
  "gemini-3.6-flash": FLASH_36,
  "google/gemini-3.6-flash": FLASH_36,
  "deepseek-v4-flash": { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  // Other current models.
  "gemini-3.8-flash": FLASH_36,
  "gemini-4-argon": GEMINI_4,
  "gemini-4-carbon": GEMINI_4,
  "gemini-3.5-flash-lite": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "gemini-3.1-flash-lite": { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  "gemini-2.5-flash-lite": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "deepseek-flash": { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  "muse-ember-1.0": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  "deepseek-v4-pro": { inputPerMillion: 1.32, outputPerMillion: 3.96 },
  // Anthropic.
  "claude-fable-5-2": { inputPerMillion: 8, outputPerMillion: 40 },
  "claude-opus-5-5": { inputPerMillion: 4, outputPerMillion: 20 },
  "claude-sonnet-5-5": { inputPerMillion: 2, outputPerMillion: 10 },
  "claude-haiku-5-5": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  // OpenAI.
  "gpt-6-astra": { inputPerMillion: 10, outputPerMillion: 50 },
  "gpt-6-sol": { inputPerMillion: 2, outputPerMillion: 10 },
  "gpt-6.1-sol": { inputPerMillion: 2, outputPerMillion: 10 },
  "gpt-6.1-terra": { inputPerMillion: 1, outputPerMillion: 5 },
  "gpt-6-luna": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  "gpt-5.6-terra": { inputPerMillion: 2, outputPerMillion: 12 },
  "gpt-5.6-luna": { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  "gpt-5.5": { inputPerMillion: 5, outputPerMillion: 30 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  "gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  // Newest on OpenRouter.
  "anthropic/claude-fable-5.2": { inputPerMillion: 8, outputPerMillion: 40 },
  "google/gemini-4-carbon": GEMINI_4,
  "meta/muse-ember": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  "nex-agi/nex-n2.6": { inputPerMillion: 0.12, outputPerMillion: 0.4 },
  "kt/midm-k-3.0-pro": { inputPerMillion: 0.2, outputPerMillion: 0.8 },
};
