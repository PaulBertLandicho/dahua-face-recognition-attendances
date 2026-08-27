function toDateString(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const localDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (localDate) {
    return `${localDate[3]}-${localDate[1].padStart(2, "0")}-${localDate[2].padStart(2, "0")}`;
  }
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