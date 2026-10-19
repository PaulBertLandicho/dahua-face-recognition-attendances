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
    const morningStart = settings.morning_start || "08:00";
    const [startHour, startMinute] = morningStart.split(":").map(Number);
    const startTotal = (startHour || 8) * 60 + (startMinute || 0);
    const earlyOtLimit = Math.min(startTotal - 60, 7 * 60);

    const afternoonEnd = settings.afternoon_end || "17:00";
    const [endHour, endMinute] = afternoonEnd.split(":").map(Number);
    const endTotal = (endHour || 17) * 60 + (endMinute || 0);

    // 1. Early-in OT: 3:00 AM up to 7:00 AM
    attendance
      .filter((a) => a.person_id === person.id && a.event === "time-in")
      .forEach((a) => {
        const dt = new Date(a.device_time);
        const inTotal = dt.getHours() * 60 + dt.getMinutes();
        if (inTotal >= 3 * 60 && inTotal <= earlyOtLimit && inTotal < startTotal) {
          otHours += (startTotal - inTotal) / 60;
        }
      });

    // 2. Afternoon Out OT (past afternoonEnd, including past midnight < 3:00 AM)
    attendance
      .filter(
        (a) =>
          a.person_id === person.id &&
          a.event === "time-out"
      )
      .forEach((a) => {
        const dt = new Date(a.device_time);
        let outTotal = dt.getHours() * 60 + dt.getMinutes();
        if (outTotal < 3 * 60) {
          outTotal += 24 * 60;
        }
        if (outTotal > endTotal) {
          const otMins = outTotal - endTotal;
          if (otMins >= 60) {
            otHours += otMins / 60;
          }
        }
      });

    otHours = Math.round(otHours * 100) / 100;
    const otPay = Math.round(otHourlyRate * otHours * 100) / 100;

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
 * Calculates late deduction using the Base Penalty + Per-Minute Increment rule:
 * - Default Base Penalty: ₱40
 * - Default Per-Minute Increment: ₱1 / minute late
 * - Example (8:00 AM start): 8:01 AM (1m late) = ₱40 + (1 * ₱1) = ₱41
 */
export function calculateTieredLateDeduction(
  lateItems = [],
  dailyRate = 0,
  personLatePenalty = 0,
  settings = {}
) {
  let localTier = null;
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("late_tier_settings")
        : null;
    if (raw) localTier = JSON.parse(raw);
  } catch (e) {}

  const baseFee = Number(
    settings?.late_base_fee ?? localTier?.late_base_fee ?? 40
  );
  const perMinFee = Number(
    settings?.late_per_minute_fee ?? localTier?.late_per_minute_fee ?? 1
  );

  let totalDeduction = 0;
  const breakdown = [];

  for (const item of lateItems) {
    const mins = Math.max(1, Number(item.minutesLate) || 1);
    const minuteCharge = Math.round(mins * perMinFee * 100) / 100;
    const itemDeduction = Math.round((baseFee + minuteCharge) * 100) / 100;
    const tierLabel = `Late (${mins}m: ₱${baseFee} + ₱${minuteCharge})`;

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

