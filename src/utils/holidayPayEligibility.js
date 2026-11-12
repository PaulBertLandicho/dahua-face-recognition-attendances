function toDateString(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const text = value.trim();
    const ymdMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (ymdMatch) return `${ymdMatch[1]}-${ymdMatch[2]}-${ymdMatch[3]}`;
    const localDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (localDate) {
      return `${localDate[3]}-${localDate[1].padStart(2, "0")}-${localDate[2].padStart(2, "0")}`;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function hasValidPunch(record) {
  if (!record || typeof record !== "object") return false;
  if (String(record.status || "").toLowerCase() === "absent") return false;
  if (record.archived) return false;

  // If this is a detailedAttendance object (from getDetailedAttendance)
  const hasDetailedFields =
    "morningIn" in record ||
    "morningOut" in record ||
    "afternoonIn" in record ||
    "afternoonOut" in record ||
    "attendanceIn" in record ||
    "attendanceOut" in record;

  if (hasDetailedFields) {
    const isValidTime = (val) =>
      Boolean(
        val &&
          val !== "-" &&
          val !== "N/A" &&
          val !== "Not time-in" &&
          val !== "Not time-out" &&
          !String(val).includes("Missing") &&
          !String(val).includes("(Holiday)") &&
          !String(val).includes("(Rest Day)")
      );
    return (
      isValidTime(record.morningIn) ||
      isValidTime(record.morningOut) ||
      isValidTime(record.afternoonIn) ||
      isValidTime(record.afternoonOut) ||
      isValidTime(record.attendanceIn) ||
      isValidTime(record.attendanceOut)
    );
  }

  // Raw attendance record from database (must have actual punch timestamp)
  if (record.device_time) return true;
  if (
    record.attendance_work_date &&
    (record.time_in || record.time_out || record.punch_time)
  ) {
    return true;
  }
  if (record.present === true) return true;
  if (typeof record.hoursWorked === "number" && record.hoursWorked > 0) return true;
  if (typeof record.regularHours === "number" && record.regularHours > 0) return true;

  return false;
}

function extractAttendedDates(records) {
  if (!Array.isArray(records)) return [];
  const dates = [];
  for (const record of records) {
    if (hasValidPunch(record)) {
      const d = toDateString(
        record.attendance_work_date || record.date || record.device_time,
      );
      if (d) dates.push(d);
    }
  }
  return dates;
}

/**
 * Determines whether an employee is eligible for holiday pay for a given holiday date.
 *
 * Rules:
 * 1. If the employee worked on the holiday itself, they are eligible.
 * 2. Unworked holiday: Employee must have valid attendance on:
 *    - The scheduled workday immediately BEFORE the holiday, AND
 *    - The scheduled workday immediately AFTER the holiday.
 *    If the employee is absent ("Not time-in", "Not time-out") on the workday
 *    immediately before OR immediately after, holiday pay is NOT applied.
 *
 * @param {Array} attendance - Attendance records (detailed daily attendance or raw attendance records)
 * @param {string|Date} holidayDate - Holiday date (YYYY-MM-DD or parseable date string/Date object)
 * @param {Array} [allAttendance=null] - Optional broader attendance records for cross-period boundary checks
 * @param {Array} [holidays=[]] - Optional list of other holidays in the period to skip non-working holiday clusters
 * @returns {boolean}
 */
export function hasHolidayPayEligibility(
  attendance,
  holidayDate,
  allAttendance = null,
  holidays = [],
) {
  const holiday = toDateString(holidayDate);
  if (!holiday) return false;

  const holidaySet = new Set();
  holidaySet.add(holiday);
  if (Array.isArray(holidays)) {
    for (const h of holidays) {
      const hd = toDateString(h.date || h.holiday_date || h);
      if (hd) holidaySet.add(hd);
    }
  }

  // Also collect any holiday markers already present in attendance records
  if (Array.isArray(attendance)) {
    for (const rec of attendance) {
      if (
        rec &&
        (rec.isHoliday ||
          String(rec.morningIn || "").includes("(Holiday)") ||
          String(rec.attendanceIn || "").includes("(Holiday)"))
      ) {
        const d = toDateString(rec.date || rec.attendance_work_date);
        if (d) holidaySet.add(d);
      }
    }
  }

  const primaryDates = new Set(extractAttendedDates(attendance));
  const allDates = allAttendance
    ? new Set([...primaryDates, ...extractAttendedDates(allAttendance)])
    : primaryDates;

  // 1. Employee attended on the holiday itself
  if (allDates.has(holiday)) {
    return true;
  }

  // 2. Unworked holiday: Employee must have valid attendance on:
  //    - The scheduled workday immediately BEFORE the holiday, AND
  //    - The scheduled workday immediately AFTER the holiday.
  //    If the employee is absent ("Not time-in", "Not time-out") on the workday
  //    immediately before OR immediately after, holiday pay is NOT applied.

  // A. Workday immediately BEFORE the holiday
  let hasBefore = false;
  let currBefore = new Date(`${holiday}T00:00:00`);
  for (let i = 1; i <= 14; i++) {
    currBefore.setDate(currBefore.getDate() - 1);
    const dateStr = toDateString(currBefore);
    if (!dateStr) break;
    const dayOfWeek = currBefore.getDay(); // 0 = Sun, 6 = Sat

    // If employee worked on this day (e.g. weekend OT or holiday work), it counts as attendance before!
    if (allDates.has(dateStr)) {
      hasBefore = true;
      break;
    }

    // If weekend (Sat/Sun) and unworked, it's a rest day -> skip back
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      continue;
    }

    // If another holiday and unworked, it's a non-working holiday -> skip back
    if (holidaySet.has(dateStr)) {
      continue;
    }

    // This was the scheduled workday immediately preceding the holiday.
    // The employee did NOT have attendance on this scheduled workday!
    hasBefore = false;
    break;
  }

  // B. Workday immediately AFTER the holiday
  let hasAfter = false;
  let currAfter = new Date(`${holiday}T00:00:00`);
  for (let i = 1; i <= 14; i++) {
    currAfter.setDate(currAfter.getDate() + 1);
    const dateStr = toDateString(currAfter);
    if (!dateStr) break;
    const dayOfWeek = currAfter.getDay(); // 0 = Sun, 6 = Sat

    // If employee worked on this day (e.g. weekend OT or holiday work), it counts as attendance after!
    if (allDates.has(dateStr)) {
      hasAfter = true;
      break;
    }

    // If weekend (Sat/Sun) and unworked, it's a rest day -> skip forward
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      continue;
    }

    // If another holiday and unworked, it's a non-working holiday -> skip forward
    if (holidaySet.has(dateStr)) {
      continue;
    }

    // This was the scheduled workday immediately following the holiday.
    // The employee did NOT have attendance on this scheduled workday!
    hasAfter = false;
    break;
  }

  return Boolean(hasBefore && hasAfter);
}
