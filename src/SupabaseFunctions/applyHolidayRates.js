// applyHolidayRates.js
// Apply holiday rates to payroll based on holidays table
import { fetchHolidays } from "./fetchHolidays";
import { hasHolidayPayEligibility } from "../utils/holidayPayEligibility";

/**
 * Modifies payroll array to apply holiday rates for matching dates
 * @param {Array} payroll - payroll array from calculatePayroll
 * @param {Array} attendance - attendance records
 * @param {Array} deptRates - department rates
 * @param {string} department
 * @param {number} month
 * @param {number} year
 * @returns {Promise<Array>} payroll with holidayDays and holidayPay updated
 */
export async function applyHolidayRates(
  payroll,
  attendance,
  deptRates,
  department,
  month,
  year
) {
  const holidays = await fetchHolidays(department, month, year);
  const deptRate =
    deptRates.find(
      (d) =>
        (d.department || "").toLowerCase().trim() ===
        (department || "").toLowerCase().trim()
    ) || {};
  const regularRate = Number(deptRate.regular_holiday_rate || 100);
  const specialRate = Number(deptRate.special_holiday_rate || 30);

  return payroll.map((personPay) => {
    let holidayDays = 0;
    let holidayPay = 0;
    const personAttendance = attendance.filter(
      (a) => a.person_id === personPay.id && a.event === "time-in"
    );
    personAttendance.forEach((a) => {
      const attDate = a.device_time.split("T")[0];
      const holiday = holidays.find((h) => h.date === attDate);
      if (holiday && hasHolidayPayEligibility(personAttendance, holiday.date)) {
        holidayDays++;
        if (holiday.type === "regular") {
          holidayPay += personPay.dailyRate * (regularRate / 100);
        } else if (holiday.type === "special") {
          holidayPay += personPay.dailyRate * (specialRate / 100);
        }
      }
    });
    return {
      ...personPay,
      holidayDays,
      holidayPay,
      gross: personPay.gross + holidayPay,
    };
  });
}
