"use strict";

const { Temporal } = require("@js-temporal/polyfill");
const { validateTimezone } = require("./orchestrator-config");
const { invalid } = require("./utility-common");
const WEEKDAYS = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];

function zone(value) {
  try { return validateTimezone(value); } catch { invalid("Invalid IANA timezone"); }
}
function disambiguation(value = "reject") {
  if (!["reject", "earlier", "later"].includes(value)) invalid("disambiguation must be reject, earlier or later");
  return value;
}
function parseDatetime(value, timezone, mode) {
  if (typeof value !== "string" || value.length > 100 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || value.includes("[")) invalid("datetime must be an ISO timestamp");
  try {
    if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return Temporal.Instant.from(value).toZonedDateTimeISO(timezone);
    return Temporal.PlainDateTime.from(value, { overflow: "reject" }).toZonedDateTime(timezone, { disambiguation: mode });
  } catch { invalid("Invalid, ambiguous or nonexistent datetime; specify an offset or explicit disambiguation"); }
}
function describe(value) {
  return {
    datetime: value.toString({ timeZoneName: "never" }), timezone: value.timeZoneId,
    utc: value.toInstant().toString(), epoch_milliseconds: value.epochMilliseconds,
    date: value.toPlainDate().toString(), weekday: WEEKDAYS[value.dayOfWeek - 1], offset: value.offset,
  };
}
function currentDate(timezone, now = () => Date.now()) {
  return Temporal.Instant.fromEpochMilliseconds(now()).toZonedDateTimeISO(zone(timezone)).toPlainDate();
}
function dateDetails(value) {
  try {
    const date = Temporal.PlainDate.from(value);
    return { date: date.toString(), weekday: WEEKDAYS[date.dayOfWeek - 1] };
  } catch { throw new Error("Invalid source date"); }
}

function timeTool(body, config, { now = () => Date.now() } = {}) {
  const timezone = zone(body.timezone ?? config.default_timezone);
  const mode = disambiguation(body.disambiguation);
  const action = body.action ?? "now";
  if (!["now", "convert", "add", "difference"].includes(action)) invalid("Unsupported time action");
  const start = action === "now" ? Temporal.Instant.fromEpochMilliseconds(now()).toZonedDateTimeISO(timezone) : parseDatetime(body.datetime, timezone, mode);
  if (action === "now") return { ok: true, action, ...describe(start) };
  if (action === "convert") return { ok: true, action, ...describe(start.withTimeZone(zone(body.target_timezone))) };
  if (action === "difference") {
    const end = parseDatetime(body.end_datetime, timezone, mode);
    const milliseconds = end.epochMilliseconds - start.epochMilliseconds;
    return { ok: true, action, start: describe(start), end: describe(end), milliseconds, seconds: milliseconds / 1000, hours: milliseconds / 3600000, days: milliseconds / 86400000, days_kind: "elapsed_24_hours" };
  }
  const units = ["milliseconds", "seconds", "minutes", "hours", "days", "weeks", "months", "years"];
  if (!units.includes(body.unit)) invalid("Invalid duration unit; use plural English units");
  if (typeof body.amount !== "number" || !Number.isFinite(body.amount) || Math.abs(body.amount) > 1000000) invalid("amount must be a finite number between -1000000 and 1000000");
  const calendar = ["days", "weeks", "months", "years"].includes(body.unit);
  if (calendar && !Number.isInteger(body.amount)) invalid("Calendar duration amounts must be integers");
  const milliseconds = calendar ? null : body.amount * { milliseconds: 1, seconds: 1000, minutes: 60000, hours: 3600000 }[body.unit];
  if (!calendar && !Number.isSafeInteger(milliseconds)) invalid("Elapsed durations must have whole millisecond precision");
  let result;
  try {
    if (calendar) {
      const local = start.toPlainDateTime().add({ [body.unit]: body.amount }, { overflow: "reject" });
      result = local.toZonedDateTime(timezone, { disambiguation: mode });
    } else result = start.add({ milliseconds });
  } catch { invalid("Duration produces an invalid, ambiguous or nonexistent datetime"); }
  return { ok: true, action, amount: body.amount, unit: body.unit, duration_kind: calendar ? "calendar" : "elapsed", ...describe(result) };
}

module.exports = { timeTool, currentDate, dateDetails };
