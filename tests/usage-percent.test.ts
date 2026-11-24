// usagePercent tests (owner requirement 2026-11-24): the meter
// percentage, with no invented values — a non-positive limit means
// no percentage at all, never a division by zero. No specific limit
// value is asserted here: the limit is a config value, not a fact
// about this function.
import { describe, expect, it } from "vitest";
import { usagePercent } from "@/lib/usage";

describe("usagePercent", () => {
  it("computes the rounded percentage", () => {
    expect(usagePercent(1, 20)).toBe(5);
    expect(usagePercent(20, 20)).toBe(100);
    expect(usagePercent(0, 20)).toBe(0);
    expect(usagePercent(1, 3)).toBe(33);
  });

  it("returns null for a non-positive limit", () => {
    expect(usagePercent(5, 0)).toBeNull();
    expect(usagePercent(5, -1)).toBeNull();
  });

  it("returns null for invalid usage", () => {
    expect(usagePercent(-1, 20)).toBeNull();
    expect(usagePercent(Number.NaN, 20)).toBeNull();
  });
});
