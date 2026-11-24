// Unit tests for lib/config.ts (M1-6): the daily cap default is the
// decided 1000 (Groq free tier, since the 2026-11-24 provider switch),
// The monthly search limit is a display limit only (owner decision
// 2026-11-24): a bad override falls back to the default instead of
// failing closed, because nothing is blocked by it.
import { afterEach, describe, expect, it } from "vitest";
import { modelCallCap, monthlySearchCap, usageDateToday, usageMonthStart } from "@/lib/config";

describe("modelCallCap", () => {
  afterEach(() => {
    delete process.env.DAILY_MODEL_CALL_CAP;
  });

  it("defaults to 1000 (PRD §6 [DECIDED] — Groq free tier)", () => {
    expect(modelCallCap()).toBe(1000);
  });

  it("uses the env override", () => {
    process.env.DAILY_MODEL_CALL_CAP = "5";
    expect(modelCallCap()).toBe(5);
  });

  it("treats an empty override as unset", () => {
    process.env.DAILY_MODEL_CALL_CAP = "  ";
    expect(modelCallCap()).toBe(1000);
  });

  it("fails closed to 0 on a non-numeric override", () => {
    process.env.DAILY_MODEL_CALL_CAP = "many";
    expect(modelCallCap()).toBe(0);
  });

  it("fails closed to 0 on a fractional or negative override", () => {
    process.env.DAILY_MODEL_CALL_CAP = "2.5";
    expect(modelCallCap()).toBe(0);
    process.env.DAILY_MODEL_CALL_CAP = "-1";
    expect(modelCallCap()).toBe(0);
  });
});

describe("monthlySearchCap", () => {
  afterEach(() => {
    delete process.env.MONTHLY_SEARCH_CAP;
  });

  it("defaults to 1000 (Tavily free tier, 1 credit per basic search)", () => {
    expect(monthlySearchCap()).toBe(1000);
  });

  it("uses the env override", () => {
    process.env.MONTHLY_SEARCH_CAP = "500";
    expect(monthlySearchCap()).toBe(500);
  });

  it("treats an empty override as unset", () => {
    process.env.MONTHLY_SEARCH_CAP = "  ";
    expect(monthlySearchCap()).toBe(1000);
  });

  it("falls back to the default on a non-numeric override (display only — nothing is blocked)", () => {
    process.env.MONTHLY_SEARCH_CAP = "many";
    expect(monthlySearchCap()).toBe(1000);
  });

  it("falls back to the default on a fractional or non-positive override", () => {
    process.env.MONTHLY_SEARCH_CAP = "2.5";
    expect(monthlySearchCap()).toBe(1000);
    process.env.MONTHLY_SEARCH_CAP = "0";
    expect(monthlySearchCap()).toBe(1000);
    process.env.MONTHLY_SEARCH_CAP = "-1";
    expect(monthlySearchCap()).toBe(1000);
  });
});

describe("usageDateToday", () => {
  it("returns a YYYY-MM-DD date on the Kolkata boundary", () => {
    const today = usageDateToday();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const expected = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    expect(today).toBe(expected);
  });
});

describe("usageMonthStart", () => {
  it("returns the first of the current month on the Kolkata boundary", () => {
    const start = usageMonthStart();
    expect(start).toMatch(/^\d{4}-\d{2}-01$/);
    const expected = usageDateToday().slice(0, 7) + "-01";
    expect(start).toBe(expected);
  });
});
