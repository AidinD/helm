// Minimal standard-cron evaluator (5 fields: minute hour day-of-month month
// day-of-week). Supports `*`, `*/step`, `a-b` ranges, `a-b/step`, and `a,b,c`
// lists (each list item may itself be a number, range, or step). No seconds,
// no `@`-macros, no names (MON/JAN) - Helm's routines are written as numeric
// 5-field crons.
//
// Deliberately dependency-free and computed by MINUTE-STEPPING from a start
// instant: for each candidate minute we test the five fields, returning the
// first match. This sidesteps the arithmetic pitfalls of hand-rolling
// "next occurrence" math (month lengths, DST, dom/dow interaction) - Date's own
// local-time methods do the calendar work. It's only ever called on create /
// after a fire (never in a hot loop), so a bounded linear scan is fine.
//
// Times are LOCAL (matches how the user reads "08:05 on Monday"). Day-of-week
// is 0-6 with 0 = Sunday; 7 is accepted as Sunday too (standard cron).

const FIELDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 and 7 = Sunday)
];

// One year of minutes - every normal cron (sub-yearly) matches well within
// this; a pathological one (e.g. Feb 29) that doesn't is reported as "no next
// run" rather than scanned forever.
const SCAN_CAP_MINUTES = 366 * 24 * 60;

// Parse one field into a Set of allowed ints, or null for "*" (any). Throws on
// anything malformed so an invalid cron is rejected loudly at create time.
function parseField(spec, { min, max }) {
  if (spec === "*") {
    return null;
  }
  const values = new Set();
  for (const part of spec.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`cron: bad step "${part}"`);
      }
    }
    let lo;
    let hi;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(rangePart);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron: bad range "${part}" (expected ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(v);
    }
  }
  return values;
}

// Parse a full "m h dom mon dow" expression into { minute, hour, dom, month,
// dow } where each is a Set or null. Throws on malformed input.
function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${parts.length} in "${expr}"`);
  }
  const [minute, hour, dom, month, dowRaw] = parts.map((p, i) => parseField(p, FIELDS[i]));
  // Normalize day-of-week 7 -> 0 (both mean Sunday).
  let dow = dowRaw;
  if (dow && dow.has(7)) {
    dow = new Set([...dow].map((d) => (d === 7 ? 0 : d)));
  }
  return { minute, hour, dom, month, dow };
}

/** True if `date` (local time) satisfies the parsed cron fields. */
function cronMatches(date, fields) {
  if (fields.minute && !fields.minute.has(date.getMinutes())) {
    return false;
  }
  if (fields.hour && !fields.hour.has(date.getHours())) {
    return false;
  }
  if (fields.month && !fields.month.has(date.getMonth() + 1)) {
    return false;
  }
  // Day-of-month / day-of-week: standard cron OR-semantics when BOTH are
  // restricted; otherwise the restricted one (or always, if both are *).
  const domRestricted = fields.dom !== null;
  const dowRestricted = fields.dow !== null;
  const domOk = !domRestricted || fields.dom.has(date.getDate());
  const dowOk = !dowRestricted || fields.dow.has(date.getDay());
  if (domRestricted && dowRestricted) {
    return domOk || dowOk;
  }
  return domOk && dowOk;
}

/**
 * The next fire time STRICTLY AFTER `from` (default now), or null if none within
 * a year. `from` may be a Date or ms. Returns a Date (local), seconds zeroed.
 * Throws if the cron expression is invalid.
 */
export function nextRun(expr, from = Date.now()) {
  const fields = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `from`
  for (let i = 0; i < SCAN_CAP_MINUTES; i++) {
    if (cronMatches(d, fields)) {
      return new Date(d);
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Validate a cron expression; returns { ok } or { ok:false, error }. */
export function validateCron(expr) {
  try {
    parseCron(expr);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
