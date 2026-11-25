// Reminder time-parsing tests (Phase 3): relative times, tomorrow
// + time, explicit dates, weekdays, and — the rule that matters —
// unparseable times ask for clarification instead of guessing.
// The fixed "now" is Wed 25 Nov 2026, 08:30 IST (03:00 UTC).
import { describe, expect, it } from "vitest";
import {
  clarificationFor,
  formatReminderTime,
  parseReminderRequest,
  parseReminderTime,
  parseTimeOfDay,
} from "@/lib/reminders/parse-time";

const NOW = new Date("2026-11-25T03:00:00Z");

function iso(result: { ok: true; at: Date } | { ok: false }): string | null {
  return result.ok ? result.at.toISOString() : null;
}

describe("parseTimeOfDay", () => {
  it("reads am/pm, 24-hour and bare hours", () => {
    expect(parseTimeOfDay("9am")).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeOfDay("9:30pm")).toEqual({ hour: 21, minute: 30 });
    expect(parseTimeOfDay("12am")).toEqual({ hour: 0, minute: 0 });
    expect(parseTimeOfDay("12pm")).toEqual({ hour: 12, minute: 0 });
    expect(parseTimeOfDay("18:00")).toEqual({ hour: 18, minute: 0 });
    expect(parseTimeOfDay("9")).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeOfDay("12")).toEqual({ hour: 12, minute: 0 });
  });

  it("rejects impossible times", () => {
    expect(parseTimeOfDay("25:00")).toBeNull();
    expect(parseTimeOfDay("13pm")).toBeNull();
    expect(parseTimeOfDay("9:60")).toBeNull();
    expect(parseTimeOfDay("0am")).toBeNull();
    expect(parseTimeOfDay("noon")).toBeNull();
  });
});

describe("parseReminderTime — relative times", () => {
  it("reads in N hours/minutes/days/weeks from now", () => {
    expect(iso(parseReminderTime("in 2 hours", NOW))).toBe(
      "2026-11-25T05:00:00.000Z",
    );
    expect(iso(parseReminderTime("in 30 minutes", NOW))).toBe(
      "2026-11-25T03:30:00.000Z",
    );
    expect(iso(parseReminderTime("in 90 seconds", NOW))).toBe(
      "2026-11-25T03:01:30.000Z",
    );
    expect(iso(parseReminderTime("in 3 days", NOW))).toBe(
      "2026-11-28T03:00:00.000Z",
    );
    expect(iso(parseReminderTime("in 1 week", NOW))).toBe(
      "2026-12-02T03:00:00.000Z",
    );
  });

  it("reads in an hour and in half an hour", () => {
    expect(iso(parseReminderTime("in an hour", NOW))).toBe(
      "2026-11-25T04:00:00.000Z",
    );
    expect(iso(parseReminderTime("in half an hour", NOW))).toBe(
      "2026-11-25T03:30:00.000Z",
    );
    expect(iso(parseReminderTime("in a minute", NOW))).toBe(
      "2026-11-25T03:01:00.000Z",
    );
  });
});

describe("parseReminderTime — tomorrow, today, bare times", () => {
  it("reads tomorrow at a time", () => {
    expect(iso(parseReminderTime("tomorrow at 9am", NOW))).toBe(
      "2026-11-26T03:30:00.000Z",
    );
    expect(iso(parseReminderTime("tomorrow 9:30pm", NOW))).toBe(
      "2026-11-26T16:00:00.000Z",
    );
    // A bare "tomorrow" means 9am.
    expect(iso(parseReminderTime("tomorrow", NOW))).toBe(
      "2026-11-26T03:30:00.000Z",
    );
  });

  it("reads today at a time, and rolls a past time to tomorrow", () => {
    expect(iso(parseReminderTime("today at 6pm", NOW))).toBe(
      "2026-11-25T12:30:00.000Z",
    );
    expect(iso(parseReminderTime("today at 7am", NOW))).toBe(
      "2026-11-26T01:30:00.000Z",
    );
  });

  it("reads a bare time today, or tomorrow when it already passed", () => {
    expect(iso(parseReminderTime("9am", NOW))).toBe("2026-11-25T03:30:00.000Z");
    expect(iso(parseReminderTime("8am", NOW))).toBe("2026-11-26T02:30:00.000Z");
    expect(iso(parseReminderTime("18:00", NOW))).toBe(
      "2026-11-25T12:30:00.000Z",
    );
    expect(iso(parseReminderTime("at 9", NOW))).toBe(
      "2026-11-25T03:30:00.000Z",
    );
  });

  it("reads tonight as 9pm today", () => {
    expect(iso(parseReminderTime("tonight", NOW))).toBe(
      "2026-11-25T15:30:00.000Z",
    );
  });
});

describe("parseReminderTime — weekdays", () => {
  it("reads the next weekday, strictly in the future", () => {
    // Now is Wednesday: Monday is 30 Nov.
    expect(iso(parseReminderTime("Monday at 9am", NOW))).toBe(
      "2026-11-30T03:30:00.000Z",
    );
    // Wednesday at 9am is still ahead today.
    expect(iso(parseReminderTime("Wednesday at 9am", NOW))).toBe(
      "2026-11-25T03:30:00.000Z",
    );
    // Wednesday at 8am already passed: next Wednesday.
    expect(iso(parseReminderTime("Wednesday at 8am", NOW))).toBe(
      "2026-12-02T02:30:00.000Z",
    );
  });

  it("reads next <weekday> as the one after the coming one", () => {
    expect(iso(parseReminderTime("next Monday at 9am", NOW))).toBe(
      "2026-12-07T03:30:00.000Z",
    );
  });
});

describe("parseReminderTime — explicit dates", () => {
  it("reads ISO and DD/MM/YYYY dates with a time", () => {
    expect(iso(parseReminderTime("2026-12-25 09:00", NOW))).toBe(
      "2026-12-25T03:30:00.000Z",
    );
    expect(iso(parseReminderTime("25/12/2026 9am", NOW))).toBe(
      "2026-12-25T03:30:00.000Z",
    );
  });

  it("reads month-name dates, with and without a year", () => {
    expect(iso(parseReminderTime("25 Dec 2026 at 9am", NOW))).toBe(
      "2026-12-25T03:30:00.000Z",
    );
    expect(iso(parseReminderTime("25 December at 9am", NOW))).toBe(
      "2026-12-25T03:30:00.000Z",
    );
    expect(iso(parseReminderTime("Dec 25 at 9am", NOW))).toBe(
      "2026-12-25T03:30:00.000Z",
    );
  });

  it("rolls a month-name date without a year to next year when it passed", () => {
    expect(iso(parseReminderTime("1 Jan at 9am", NOW))).toBe(
      "2027-01-01T03:30:00.000Z",
    );
  });

  it("defaults a date with no time to 9am", () => {
    expect(iso(parseReminderTime("25 Dec 2026", NOW))).toBe(
      "2026-12-25T03:30:00.000Z",
    );
  });

  it("rejects impossible dates", () => {
    expect(parseReminderTime("32 Dec 2026", NOW)).toEqual({ ok: false });
    expect(parseReminderTime("31 Feb 2026", NOW)).toEqual({ ok: false });
    expect(parseReminderTime("2026-13-01", NOW)).toEqual({ ok: false });
  });
});

describe("parseReminderTime — unparseable means ask, never guess", () => {
  it("returns ok:false for vague or missing times", () => {
    for (const text of [
      "sometime",
      "later",
      "next week",
      "yesterday",
      "soon",
      "at some point",
      "",
      "   ",
    ]) {
      expect(parseReminderTime(text, NOW)).toEqual({ ok: false });
    }
  });

  it("returns ok:false for impossible times", () => {
    expect(parseReminderTime("at 25:00", NOW)).toEqual({ ok: false });
    expect(parseReminderTime("tomorrow at 13pm", NOW)).toEqual({ ok: false });
  });
});

describe("parseReminderRequest", () => {
  it("splits time and message in both orders", () => {
    const first = parseReminderRequest(
      "remind me tomorrow at 9am to submit the form",
      NOW,
    );
    expect(first).toEqual({
      ok: true,
      at: new Date("2026-11-26T03:30:00.000Z"),
      message: "submit the form",
    });
    const second = parseReminderRequest(
      "remind me to buy milk tomorrow at 9am",
      NOW,
    );
    expect(second).toEqual({
      ok: true,
      at: new Date("2026-11-26T03:30:00.000Z"),
      message: "buy milk",
    });
  });

  it("reads the spec examples", () => {
    const first = parseReminderRequest(
      "remind me tomorrow at 9am to submit the form",
      NOW,
    );
    expect(first.ok).toBe(true);
    const second = parseReminderRequest(
      "remind me in 2 hours to call the lab",
      NOW,
    );
    expect(second).toEqual({
      ok: true,
      at: new Date("2026-11-25T05:00:00.000Z"),
      message: "call the lab",
    });
  });

  it("works without the leading remind me (Telegram /remind args)", () => {
    const result = parseReminderRequest("tomorrow 9am submit the form", NOW);
    expect(result).toEqual({
      ok: true,
      at: new Date("2026-11-26T03:30:00.000Z"),
      message: "submit the form",
    });
  });

  it("asks for clarification when the time is missing", () => {
    expect(parseReminderRequest("remind me to submit the form", NOW)).toEqual({
      ok: false,
      reason: "no_time",
    });
    expect(parseReminderRequest("remind me", NOW)).toEqual({
      ok: false,
      reason: "no_time",
    });
  });

  it("asks for clarification when the message is missing", () => {
    expect(parseReminderRequest("remind me tomorrow at 9am", NOW)).toEqual({
      ok: false,
      reason: "no_message",
    });
    expect(parseReminderRequest("remind me in 2 hours", NOW)).toEqual({
      ok: false,
      reason: "no_message",
    });
    expect(parseReminderRequest("remind me at 9am", NOW)).toEqual({
      ok: false,
      reason: "no_message",
    });
  });
});

describe("clarificationFor and formatReminderTime", () => {
  it("asks for a time or a message, never guesses", () => {
    expect(clarificationFor("no_time")).toContain("tomorrow at 9am");
    expect(clarificationFor("no_message")).toContain("What should I remind");
  });

  it("formats an instant in India time", () => {
    const text = formatReminderTime(new Date("2026-11-26T03:30:00.000Z"));
    expect(text).toContain("26 Nov 2026");
    expect(text).toContain("9:00 am");
  });
});
