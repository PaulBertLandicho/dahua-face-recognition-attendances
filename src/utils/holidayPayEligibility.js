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
          !String(val).includes("(Rest Day)"),
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

  // Raw attendance record or { date } summary object
  return Boolean(record.device_time || record.attendance_work_date || record.date);
}

export function hasHolidayPayEligibility(attendance, holidayDate) {
  const holiday = toDateString(holidayDate);
  if (!holiday) return false;

  const attendedDates = new Set(
    (attendance || [])
      .filter((record) => hasValidPunch(record))
      .map((record) =>
        toDateString(
          record.attendance_work_date || record.date || record.device_time,
        ),
      )
      .filter(Boolean),
  );

  return attendedDates.has(holiday);
}
