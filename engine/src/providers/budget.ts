/**
 * Spending cap for one job. The guard sits on the two paths every engine
 * uses and cannot skip: the usage sink (to add up what each call cost) and
 * the provider (to refuse the next call once the cap is reached). An engine
 * receives only the guarded provider, so none has to remember to check.
 *
 * "Reached" means recorded spend >= the budget. Calls already in flight when
 * the cap is reached still finish and are recorded; none starts after.
 * Unpriced calls add nothing, so a model without a price cannot be capped.
 */
import type { StructuredProvider, UsageEvent, UsageSink } from "../types/provider";

export class BudgetExceededError extends Error {
  constructor(
    readonly budgetUSD: number,
    readonly spentUSD: number,
  ) {
    super(`Budget exceeded: spent $${spentUSD.toFixed(4)} of the $${budgetUSD.toFixed(4)} budget; no further provider calls were made.`);
    this.name = "BudgetExceededError";
  }
}

export class BudgetGuard implements UsageSink {
  private spent: number;
  private tripped?: BudgetExceededError;

  /** `alreadySpentUSD` carries spend from earlier attempts of the same job. */
  constructor(
    private readonly inner: UsageSink,
    readonly budgetUSD: number | undefined,
    alreadySpentUSD = 0,
  ) {
    this.spent = alreadySpentUSD;
  }

  record(event: UsageEvent): void | Promise<void> {
    this.spent += event.usd ?? 0;
    return this.inner.record(event);
  }

  get spentUSD(): number {
    return this.spent;
  }

  /** Set once a call was refused; the runner uses it even if an engine swallowed the error. */
  get exceeded(): BudgetExceededError | undefined {
    return this.tripped;
  }

  /** Throws before a provider call when the cap is already reached. */
  check(): void {
    if (this.budgetUSD === undefined || this.spent < this.budgetUSD) return;
    this.tripped ??= new BudgetExceededError(this.budgetUSD, this.spent);
    throw this.tripped;
  }

  /** The same provider, with every call checked first. Optional capabilities stay optional. */
  guard<P extends StructuredProvider>(provider: P): P {
    if (this.budgetUSD === undefined) return provider;
    return new Proxy(provider, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function" || key === "constructor") return value;
        return (...args: unknown[]) => {
          this.check();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }
}
