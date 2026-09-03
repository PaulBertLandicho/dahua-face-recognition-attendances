const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

function getWallClockParts(value) {
  const text = String(value || "").trim();
  const match = text.match(WALL_CLOCK_PATTERN);
  if (!match || /[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
  };
}

export function parseAttendanceTime(value) {
  const wallClock = getWallClockParts(value);
  if (wallClock) {
    return { date: new Date(Date.UTC(wallClock.year, wallClock.month - 1, wallClock.day, wallClock.hour, wallClock.minute, wallClock.second)), wallClock: true };
  }
  return { date: new Date(value), wallClock: false };
}

export function formatAttendanceDateTime(value) {
  const parsed = parseAttendanceTime(value);
  if (Number.isNaN(parsed.date.getTime())) return "";

  const options = { month: "long", day: "2-digit", year: "numeric" };
  const datePart = parsed.wallClock
    ? new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(parsed.date)
    : parsed.date.toLocaleDateString("en-US", options);
  const timePart = parsed.wallClock
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" }).format(parsed.date)
    : parsed.date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return `${datePart} - ${timePart}`;
}

export function attendanceDateKey(value) {
  const parsed = parseAttendanceTime(value);
  if (Number.isNaN(parsed.date.getTime())) return "";
  if (parsed.wallClock) return parsed.date.toISOString().slice(0, 10);
  return `${parsed.date.getFullYear()}-${String(parsed.date.getMonth() + 1).padStart(2, "0")}-${String(parsed.date.getDate()).padStart(2, "0")}`;
}

export function attendanceTimestamp(value) {
  return parseAttendanceTime(value).date.getTime();
}

export function updateAttendanceClock(value, clock) {
  const wallClock = getWallClockParts(value);
  const match = String(clock || "").match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return value;
  const time = `${match[1]}:${match[2]}:${match[3] || "00"}`;
  if (wallClock) {
    return `${String(wallClock.year).padStart(4, "0")}-${String(wallClock.month).padStart(2, "0")}-${String(wallClock.day).padStart(2, "0")} ${time}`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  date.setHours(Number(match[1]), Number(match[2]), Number(match[3] || 0), 0);
  return date.toISOString();
}
