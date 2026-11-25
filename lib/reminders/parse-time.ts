// Natural-language reminder times (Phase 3, 2026-11-25). Pure
// functions: no network, no database, no model.
//
// Plain language: the owner writes times the way people do — "in 2
// hours", "tomorrow at 9am", "25 Dec at 9am", "next Monday at 9am"
// — and this turns them into an exact instant. Every time is read
// in Asia/Kolkata, the owner's time zone. IST is UTC+5:30 all year
// (no daylight saving), so the conversion is a fixed offset and
// cannot drift.
//
// The one rule that matters: an unparseable time is NEVER guessed.
// parseReminderTime returns ok:false and the caller asks the owner
// for clarification. A guessed time would fire a reminder at the
// wrong hour, which is worse than asking.
//
// Supported time expressions (matched anywhere in the text):
//   - relative: "in 2 hours", "in 30 minutes", "in 90 seconds",
//     "in 3 days", "in 1 week", "in an hour", "in half an hour"
//   - tomorrow / today / tonight, with a time: "tomorrow at 9am",
//     "today 18:00"; bare "tonight" means today at 9pm
//   - weekday: "Monday at 9am" (the next one, strictly in the
//     future), "next Monday at 9am" (the one after that)
//   - explicit dates: "2026-12-25 09:00", "25/12/2026 9am",
//     "25 Dec 2026 at 9am", "Dec 25 at 9am" (no year: this year, or
//     next year if that date already passed)
//   - a bare time: "9am", "9:30pm", "18:00", "at 9" — today if it
//     is still ahead, otherwise tomorrow
// A date with no time means 9:00am. A time with no am/pm and an
// hour of 1–12 means am; 13–23 means 24-hour time.

/** Fixed IST offset: UTC+5:30, no daylight saving ever. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface KolkataParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23
  minute: number; // 0–59
  weekday: number; // 0 = Sunday … 6 = Saturday
}

/** The Asia/Kolkata calendar parts of a moment. */
export function kolkataParts(now: Date): KolkataParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found === undefined ? 0 : Number(found.value);
  };
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    weekdayName,
  );
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    weekday: weekday < 0 ? 0 : weekday,
  };
}

/** A Kolkata wall-clock reading as a UTC instant. */
export function kolkataToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, 0, 0) - IST_OFFSET_MS,
  );
}

/** Add whole days to a Kolkata calendar date (month/year rollover
 * handled by the Date constructor). */
function addDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** True when the given Kolkata calendar date is a real date (no
 * 31 February, no month 13). */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() + 1 === month &&
    d.getUTCDate() === day
  );
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Parse a time-of-day fragment: "9am", "9:30pm", "18:00", "9".
 * Returns the 24-hour hour/minute, or null when it is not a valid
 * time (25:00, 13pm, 9:60). A bare hour of 1–12 means am; 13–23
 * means 24-hour time. */
export function parseTimeOfDay(
  raw: string,
): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw.trim());
  if (match === null) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (minute < 0 || minute > 59) return null;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (match[2] !== undefined) {
    // "18:00" — 24-hour time.
    if (hour < 0 || hour > 23) return null;
  } else {
    // Bare hour: 1–11 is am, 12 is noon, 13–23 is 24-hour time.
    if (hour < 1 || hour > 23) return null;
    if (hour === 12) hour = 12;
  }
  return { hour, minute };
}

export type ParsedTime =
  | { ok: true; at: Date }
  | { ok: false };

interface TimeMatch {
  at: Date;
  start: number;
  end: number;
}

const TIME_FRAGMENT = String.raw`(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)`;
// Longest first: "dec" must not win over "december", "sept" over
// "september" — the regex alternation takes the first match.
const MONTH_NAME = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");
const WEEKDAY_NAME = Object.keys(WEEKDAYS).join("|");

/** The relative matcher: "in 2 hours" etc. */
function matchRelative(text: string, now: Date): TimeMatch | null {
  const match =
    /\bin\s+(?:(\d+)\s+)?(half\s+an\s+)?(an?\s+)?(seconds?|minutes?|hours?|days?|weeks?)\b/.exec(
      text,
    );
  if (match === null) return null;
  const amount = match[1] === undefined ? 1 : Number(match[1]);
  const half = match[2] !== undefined;
  const unit = match[4];
  if (!Number.isInteger(amount) || amount <= 0 || amount > 365) return null;
  const msPerUnit: Record<string, number> = {
    second: 1000,
    seconds: 1000,
    minute: 60 * 1000,
    minutes: 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
  };
  const per = msPerUnit[unit];
  if (per === undefined) return null;
  const at = new Date(now.getTime() + (half ? 0.5 : amount) * per);
  return { at, start: match.index, end: match.index + match[0].length };
}

/** The explicit-date matchers: ISO, DD/MM/YYYY, "25 Dec 2026",
 * "Dec 25". Each takes an optional time; without one it is 9am. */
function matchExplicitDate(
  text: string,
  now: Date,
): TimeMatch | null {
  const nowParts = kolkataParts(now);

  // ISO: 2026-12-25, optionally with a time.
  const iso = /(\d{4})-(\d{2})-(\d{2})(?:[ T]+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?/.exec(
    text,
  );
  if (iso !== null) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!isRealDate(year, month, day)) return null;
    const time =
      iso[4] === undefined ? { hour: 9, minute: 0 } : parseTimeOfDay(iso[4]);
    if (time === null) return null;
    return {
      at: kolkataToDate(year, month, day, time.hour, time.minute),
      start: iso.index,
      end: iso.index + iso[0].length,
    };
  }

  // DD/MM/YYYY (or DD-MM-YYYY), optionally with a time.
  const dmy =
    /(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T]+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?/.exec(
      text,
    );
  if (dmy !== null) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (!isRealDate(year, month, day)) return null;
    const time =
      dmy[4] === undefined ? { hour: 9, minute: 0 } : parseTimeOfDay(dmy[4]);
    if (time === null) return null;
    return {
      at: kolkataToDate(year, month, day, time.hour, time.minute),
      start: dmy.index,
      end: dmy.index + dmy[0].length,
    };
  }

  // "25 Dec 2026" / "25 December" + optional time.
  const dmyName = new RegExp(
    String.raw`(\d{1,2})\s+(${MONTH_NAME})(?:\s+(\d{4}))?(?:\s+(?:at\s+)?${TIME_FRAGMENT})?`,
  ).exec(text);
  if (dmyName !== null) {
    const day = Number(dmyName[1]);
    const month = MONTHS[dmyName[2]];
    let year =
      dmyName[3] === undefined ? nowParts.year : Number(dmyName[3]);
    if (month === undefined || !isRealDate(year, month, day)) return null;
    const time =
      dmyName[4] === undefined
        ? { hour: 9, minute: 0 }
        : parseTimeOfDay(dmyName[4]);
    if (time === null) return null;
    let at = kolkataToDate(year, month, day, time.hour, time.minute);
    // No year given and the date already passed: next year.
    if (dmyName[3] === undefined && at.getTime() <= now.getTime()) {
      year += 1;
      if (!isRealDate(year, month, day)) return null;
      at = kolkataToDate(year, month, day, time.hour, time.minute);
    }
    return { at, start: dmyName.index, end: dmyName.index + dmyName[0].length };
  }

  // "Dec 25" / "December 25, 2026" + optional time.
  const mdyName = new RegExp(
    String.raw`(${MONTH_NAME})\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s+(?:at\s+)?${TIME_FRAGMENT})?`,
  ).exec(text);
  if (mdyName !== null) {
    const month = MONTHS[mdyName[1]];
    const day = Number(mdyName[2]);
    let year =
      mdyName[3] === undefined ? nowParts.year : Number(mdyName[3]);
    if (month === undefined || !isRealDate(year, month, day)) return null;
    const time =
      mdyName[4] === undefined
        ? { hour: 9, minute: 0 }
        : parseTimeOfDay(mdyName[4]);
    if (time === null) return null;
    let at = kolkataToDate(year, month, day, time.hour, time.minute);
    if (mdyName[3] === undefined && at.getTime() <= now.getTime()) {
      year += 1;
      if (!isRealDate(year, month, day)) return null;
      at = kolkataToDate(year, month, day, time.hour, time.minute);
    }
    return { at, start: mdyName.index, end: mdyName.index + mdyName[0].length };
  }

  return null;
}

/** The weekday matcher: "Monday at 9am", "next Monday at 9am". */
function matchWeekday(text: string, now: Date): TimeMatch | null {
  const match = new RegExp(
    String.raw`\b(next\s+)?(${WEEKDAY_NAME})\b(?:\s+(?:at\s+)?${TIME_FRAGMENT})?`,
  ).exec(text);
  if (match === null) return null;
  const target = WEEKDAYS[match[2]];
  if (target === undefined) return null;
  const time =
    match[3] === undefined ? { hour: 9, minute: 0 } : parseTimeOfDay(match[3]);
  if (time === null) return null;
  const nowParts = kolkataParts(now);
  // Days until the next occurrence, strictly in the future: today
  // only counts when the time is still ahead.
  let delta = (target - nowParts.weekday + 7) % 7;
  const todayAt = kolkataToDate(
    nowParts.year,
    nowParts.month,
    nowParts.day,
    time.hour,
    time.minute,
  );
  if (delta === 0 && todayAt.getTime() <= now.getTime()) delta = 7;
  if (match[1] !== undefined) delta += 7; // "next Monday": the one after.
  const date = addDays(nowParts.year, nowParts.month, nowParts.day, delta);
  return {
    at: kolkataToDate(date.year, date.month, date.day, time.hour, time.minute),
    start: match.index,
    end: match.index + match[0].length,
  };
}

/** The today/tomorrow/tonight matcher. */
function matchDayWord(text: string, now: Date): TimeMatch | null {
  const match = new RegExp(
    String.raw`\b(tomorrow|today|tonight)\b(?:\s+(?:at\s+)?${TIME_FRAGMENT})?`,
  ).exec(text);
  if (match === null) return null;
  const nowParts = kolkataParts(now);
  const word = match[1];
  let time: { hour: number; minute: number };
  if (match[2] === undefined) {
    // Bare "tonight" means 9pm; bare "tomorrow"/"today" means 9am.
    time = word === "tonight" ? { hour: 21, minute: 0 } : { hour: 9, minute: 0 };
  } else {
    const parsed = parseTimeOfDay(match[2]);
    if (parsed === null) return null;
    time = parsed;
  }
  const date =
    word === "tomorrow"
      ? addDays(nowParts.year, nowParts.month, nowParts.day, 1)
      : { year: nowParts.year, month: nowParts.month, day: nowParts.day };
  let at = kolkataToDate(date.year, date.month, date.day, time.hour, time.minute);
  // "today at 9am" when it is already past 9am: tomorrow 9am.
  if (word !== "tomorrow" && at.getTime() <= now.getTime()) {
    const next = addDays(nowParts.year, nowParts.month, nowParts.day, 1);
    at = kolkataToDate(next.year, next.month, next.day, time.hour, time.minute);
  }
  return { at, start: match.index, end: match.index + match[0].length };
}

/** The bare-time matcher: "9am", "9:30pm", "18:00", "at 9" —
 * today when it is still ahead, otherwise tomorrow. */
function matchBareTime(text: string, now: Date): TimeMatch | null {
  const match = new RegExp(
    String.raw`(?:^|\s)(?:at\s+)?${TIME_FRAGMENT}\b`,
  ).exec(text);
  if (match === null) return null;
  const time = parseTimeOfDay(match[1]);
  if (time === null) return null;
  const nowParts = kolkataParts(now);
  let at = kolkataToDate(
    nowParts.year,
    nowParts.month,
    nowParts.day,
    time.hour,
    time.minute,
  );
  if (at.getTime() <= now.getTime()) {
    const next = addDays(nowParts.year, nowParts.month, nowParts.day, 1);
    at = kolkataToDate(next.year, next.month, next.day, time.hour, time.minute);
  }
  // The match starts at the whitespace before the time (or 0).
  const start = match[0].startsWith(" ") || match[0].startsWith("\t")
    ? match.index + 1
    : match.index;
  return { at, start, end: match.index + match[0].length };
}

const MATCHERS = [
  matchRelative,
  matchExplicitDate,
  matchWeekday,
  matchDayWord,
  matchBareTime,
];

/** Find a time expression anywhere in the text and resolve it to
 * an instant, with the span it occupied. Returns null when nothing
 * in the text parses as a time — the caller must ask for
 * clarification, never guess. */
export function findTimeExpression(
  text: string,
  now: Date,
): TimeMatch | null {
  const lowered = text.toLowerCase();
  for (const match of MATCHERS) {
    const found = match(lowered, now);
    if (found !== null) return found;
  }
  return null;
}

/** Parse a time expression from anywhere in the text. */
export function parseReminderTime(text: string, now: Date): ParsedTime {
  const found = findTimeExpression(text, now);
  if (found === null) return { ok: false };
  return { ok: true, at: found.at };
}

export type ReminderRequest =
  | { ok: true; at: Date; message: string }
  | { ok: false; reason: "no_time" | "no_message" };

/**
 * Parse a whole reminder request — "remind me tomorrow at 9am to
 * submit the form", "remind me in 2 hours to call the lab", or a
 * bare "/remind tomorrow 9am submit the form" (the leading "remind
 * me" is optional). Returns the instant and the message, or a
 * reason the caller turns into a clarification question.
 */
export function parseReminderRequest(
  text: string,
  now: Date,
): ReminderRequest {
  let rest = text.trim().replace(/\s+/g, " ");
  // Optional leading "remind me" / "please remind me".
  rest = rest.replace(/^please\s+/i, "");
  rest = rest.replace(/^remind\s+me\s*/i, "");
  if (rest === "") return { ok: false, reason: "no_time" };

  const found = findTimeExpression(rest, now);
  if (found === null) return { ok: false, reason: "no_time" };

  // The message is everything except the time expression, with the
  // filler words around it removed ("to", "that", "about").
  let message = `${rest.slice(0, found.start)} ${rest.slice(found.end)}`
    .replace(/\s+/g, " ")
    .trim();
  message = message
    .replace(/^(to|that|about|me\s+to)\s+/i, "")
    .replace(/\s+(to|that|about)$/i, "")
    .replace(/^to\s+/i, "")
    .trim();
  // A stray leading "to" left by "remind me to X at TIME".
  message = message.replace(/^to\s+/i, "").trim();
  if (message === "") return { ok: false, reason: "no_message" };
  return { ok: true, at: found.at, message };
}

/** The clarification question for a failed parse — never a guess. */
export function clarificationFor(
  reason: "no_time" | "no_message",
): string {
  if (reason === "no_time") {
    return 'When should I remind you? Tell me a time, like "tomorrow at 9am" or "in 2 hours".';
  }
  return "What should I remind you about?";
}

/** A reminder instant as the owner reads it: "25 Nov 2026, 9:00 AM". */
export function formatReminderTime(at: Date | string): string {
  const date = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}
