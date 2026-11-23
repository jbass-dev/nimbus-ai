// Schedules for background tasks, as short human strings:
//   "every 30m" | "every 2h" | "daily 08:30" | "weekdays 07:45"
// Times are the computer's local time (the desktop app runs on the user's own machine).

const MIN_EVERY_MIN = 30;
const MAX_EVERY_MIN = 7 * 24 * 60;

export function parseSchedule(input) {
  const s = String(input ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  let m = /^every (\d{1,4}) ?(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(s);
  if (m) {
    const minutes = Number(m[1]) * (m[2].startsWith("h") ? 60 : 1);
    if (minutes < MIN_EVERY_MIN) throw new Error(`Tasks can run at most every ${MIN_EVERY_MIN} minutes.`);
    if (minutes > MAX_EVERY_MIN) throw new Error("Use a schedule of a week or less.");
    return { kind: "every", minutes, text: minutes % 60 === 0 ? `every ${minutes / 60}h` : `every ${minutes}m` };
  }
  m = /^(daily|weekdays)(?: at)? (\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    if (hour > 23 || minute > 59) throw new Error("That time isn't valid. Use 24-hour HH:MM, e.g. daily 08:30.");
    return { kind: m[1], hour, minute, text: `${m[1]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
  }
  throw new Error('Use a schedule like "every 2h", "every 30m", "daily 08:30" or "weekdays 07:45".');
}

/** Epoch ms of the first run strictly after `from`. */
export function nextRunAfter(schedule, from = Date.now()) {
  const sch = typeof schedule === "string" ? parseSchedule(schedule) : schedule;
  if (sch.kind === "every") return from + sch.minutes * 60_000;
  const d = new Date(from);
  d.setHours(sch.hour, sch.minute, 0, 0);
  for (let i = 0; i < 9; i++) {
    const day = d.getDay();
    if (d.getTime() > from && (sch.kind === "daily" || (day !== 0 && day !== 6))) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(sch.hour, sch.minute, 0, 0);
  }
  return from + 24 * 3_600_000;
}
