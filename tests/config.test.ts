// Unit tests for lib/config.ts (M1-6): the daily cap default is the
// decided 20, the env override wins, and a bad override fails closed.
import { afterEach, describe, expect, it } from "vitest";
import { modelCallCap, searchCap, usageDateToday } from "@/lib/config";

describe("modelCallCap", () => {
  afterEach(() => {
    delete process.env.DAILY_MODEL_CALL_CAP;
  });

  it("defaults to 20 (PRD §6 [DECIDED])", () => {
    expect(modelCallCap()).toBe(20);
  });

  it("uses the env override", () => {
    process.env.DAILY_MODEL_CALL_CAP = "5";
    expect(modelCallCap()).toBe(5);
  });

  it("treats an empty override as unset", () => {
    process.env.DAILY_MODEL_CALL_CAP = "  ";
    expect(modelCallCap()).toBe(20);
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

describe("searchCap", () => {
  afterEach(() => {
    delete process.env.DAILY_SEARCH_CAP;
  });

  it("defaults to 10 (TECH_STACK.md §3.4 [DECIDED])", () => {
    expect(searchCap()).toBe(10);
  });

  it("uses the env override", () => {
    process.env.DAILY_SEARCH_CAP = "5";
    expect(searchCap()).toBe(5);
  });

  it("treats an empty override as unset", () => {
    process.env.DAILY_SEARCH_CAP = "  ";
    expect(searchCap()).toBe(10);
  });

  it("fails closed to 0 on a non-numeric override", () => {
    process.env.DAILY_SEARCH_CAP = "many";
    expect(searchCap()).toBe(0);
  });

  it("fails closed to 0 on a fractional or negative override", () => {
    process.env.DAILY_SEARCH_CAP = "2.5";
    expect(searchCap()).toBe(0);
    process.env.DAILY_SEARCH_CAP = "-1";
    expect(searchCap()).toBe(0);
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
