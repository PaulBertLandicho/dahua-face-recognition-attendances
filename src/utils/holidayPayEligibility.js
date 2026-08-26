function toDateString(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function previousDate(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function hasHolidayPayEligibility(attendance, holidayDate) {
  const holiday = toDateString(holidayDate);
  if (!holiday) return false;

  const attendedDates = new Set(
    (attendance || [])
      .filter((record) => !record.event || record.event === "time-in")
      .map((record) => toDateString(record.device_time || record.date))
      .filter(Boolean),
  );

  return attendedDates.has(holiday) && attendedDates.has(previousDate(holiday));
}