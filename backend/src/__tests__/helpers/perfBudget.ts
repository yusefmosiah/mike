import { expect } from "vitest";

/**
 * Speed budgets are checked only when MIKE_PERF=1 (`npm run test:perf`).
 * A wall-clock limit inside the ordinary suite failed whenever the machine
 * was busy, without anything being slow; the test still checks the result.
 */
export const PERF_BUDGETS = process.env.MIKE_PERF === "1";

export function expectWithinBudget(elapsedMs: number, budgetMs: number, what: string): void {
  if (!PERF_BUDGETS) return;
  expect(elapsedMs, `${what} took ${Math.round(elapsedMs)} ms`).toBeLessThan(budgetMs);
}
