export function calculatePayroll(
  attendance = [],
  persons = [],
  deptRates = [],
  settings = {}
) {
  // Removed unused variables

  return persons.map((person) => {
    // Filter attendance for this person
    const personAttendance = attendance
      .filter((a) => a.person_id === person.id && a.event === "time-in")
      .map((a) => new Date(a.device_time));

    // Get department rates
    const deptRate =
      deptRates.find(
        (d) =>
          (d.department || "").toLowerCase().trim() ===
          (person.department || "").toLowerCase().trim()
      ) || {};

    // Apply deductions: use department rates when the person has an ID number present (Employee Share)
    const sss = person.sss ? Number(deptRate.sss || 0) : 0;
    const pag_ibig = person.pag_ibig ? Number(deptRate.pag_ibig || 0) : 0;
    const philhealth = person.philhealth ? Number(deptRate.philhealth || 0) : 0;
    const cashAdvance = Number(person.cash_advance || 0);

    // Employer share (paid by company, not deducted from employee)
    const sss_employer = person.sss ? Number(deptRate.sss_employer || 0) : 0;
    const pag_ibig_employer = person.pag_ibig ? Number(deptRate.pag_ibig_employer || 0) : 0;
    const philhealth_employer = person.philhealth ? Number(deptRate.philhealth_employer || 0) : 0;
    const totalEmployerShare = sss_employer + pag_ibig_employer + philhealth_employer;

    // Count only weekdays (exclude Saturday=6 and Sunday=0)
    const daysPresent = personAttendance.filter((d) => {
      const wd = d.getDay();
      return wd !== 0 && wd !== 6;
    }).length;
    const dailyRate = Number(person.daily_rate || 0);

    // --- OT Calculation ---
    let otHourlyRate = Number(deptRate.ot_rate || 0);
    if (!otHourlyRate && dailyRate) otHourlyRate = dailyRate / 8;

    let otHours = 0;
    // Calculate OT from attendance records with event='time-out' and status='overtime'
    const afternoonEnd = settings.afternoon_end || "17:00";
    const [endHour, endMinute] = afternoonEnd.split(":").map(Number);
    const endTotal = endHour * 60 + endMinute;
    attendance
      .filter(
        (a) =>
          a.person_id === person.id &&
          a.event === "time-out" &&
          a.status === "overtime"
      )
      .forEach((a) => {
        const dt = new Date(a.device_time);
        const outTotal = dt.getHours() * 60 + dt.getMinutes();
        if (outTotal > endTotal) {
          otHours += (outTotal - endTotal) / 60;
        }
      });

    const otPay = otHourlyRate * otHours;

    // --- End OT Calculation ---

    // Late count and deduction will be injected from PayrollPage
    // (lateCount and totalLateDeduction will be set there)
    return {
      id: person.id,
      daysPresent,
      dailyRate,
      gross: dailyRate * daysPresent + otPay,
      totalLateDeduction: 0, // will be set in PayrollPage
      sss,
      pag_ibig,
      philhealth,
      sss_employer,
      pag_ibig_employer,
      philhealth_employer,
      totalEmployerShare,
      cashAdvance,
      totalDeductions: 0, // will be set in PayrollPage
      net: 0, // will be set in PayrollPage
      otHours,
      otHourlyRate,
      otPay,
      holidayDays: 0,
      holidayPay: 0,
      lateCount: 0, // will be set in PayrollPage
    };
  });
}

/**
 * Calculates late deduction using the Tiered Bracket rule:
 * - 1 to 15 mins: Minor late fee (default ₱10)
 * - 16 to 30 mins: Mid late fee (default ₱25)
 * - 31 to 60 mins: Full 1-hour rate from Employee Rates (Daily Rate / 8 or Late Penalty)
 * - > 60 mins: Pro-rated by unworked hours
 */
export function calculateTieredLateDeduction(
  lateItems = [],
  dailyRate = 0,
  personLatePenalty = 0,
  settings = {}
) {
  let localTier = null;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("late_tier_settings") : null;
    if (raw) localTier = JSON.parse(raw);
  } catch (e) {}

  const minorFee = Number(
    settings?.late_tier_minor_fee ?? localTier?.late_tier_minor_fee ?? 10
  );
  const midFee = Number(
    settings?.late_tier_mid_fee ?? localTier?.late_tier_mid_fee ?? 25
  );
  const majorMode =
    settings?.late_tier_major_mode || localTier?.late_tier_major_mode || "employee_hourly";
  const customMajorFee = Number(
    settings?.late_tier_major_fee ?? localTier?.late_tier_major_fee ?? 50
  );

  // Compute 1-hour rate based on Employee Rates
  let majorRate = 0;
  if (majorMode === "employee_penalty" && personLatePenalty > 0) {
    majorRate = Number(personLatePenalty);
  } else if (majorMode === "custom_flat") {
    majorRate = customMajorFee;
  } else {
    // Default: Employee Hourly Rate (Daily Rate / 8)
    majorRate = dailyRate > 0 ? Number(dailyRate) / 8 : Number(personLatePenalty || 50);
  }
  majorRate = Math.round(majorRate * 100) / 100;

  let totalDeduction = 0;
  const breakdown = [];

  for (const item of lateItems) {
    const mins = Number(item.minutesLate) || 1;
    let itemDeduction = 0;
    let tierLabel = "";

    if (mins <= 15) {
      itemDeduction = minorFee;
      tierLabel = `Minor Late (1–15m)`;
    } else if (mins <= 30) {
      itemDeduction = midFee;
      tierLabel = `Mid Late (16–30m)`;
    } else if (mins <= 60) {
      itemDeduction = majorRate;
      tierLabel = `Major Late (~1 hr rate)`;
    } else {
      const hours = Math.ceil(mins / 60);
      itemDeduction = Math.round(hours * majorRate * 100) / 100;
      tierLabel = `Extended Late (${hours}h)`;
    }

    totalDeduction += itemDeduction;
    breakdown.push({
      ...item,
      minutesLate: mins,
      deduction: itemDeduction,
      tierLabel,
    });
  }

  return {
    totalLateDeduction: Math.round(totalDeduction * 100) / 100,
    lateBreakdown: breakdown,
  };
}
