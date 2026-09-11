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
