const assert = require("assert");

// Extract parseTimeToMinutes logic
function parseTimeToMinutes(t) {
  if (!t) return null;
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([APap][Mm]))?/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[4];
  if (ampm) {
    if (/pm/i.test(ampm) && hour < 12) hour += 12;
    if (/am/i.test(ampm) && hour === 12) hour = 0;
  }
  return hour * 60 + minute;
}

// Replicate the exact computeRowOt logic from PayslipModal.js
function createComputeRowOt(person, settings, departmentRates) {
  const effectiveSettings =
    settings && Object.keys(settings).length > 0
      ? settings
      : {};

  const personDept = String(person?.department || "").trim().toLowerCase();
  const isUtilityPerson = personDept === "utility";
  const personDeptRate = (departmentRates || []).find(
    (d) => String(d.department || "").trim().toLowerCase() === personDept
  );

  const morningStart = personDeptRate?.has_custom_workhours && personDeptRate.morning_start
    ? personDeptRate.morning_start
    : isUtilityPerson
    ? "07:00"
    : effectiveSettings.morning_start || "08:00";

  const onTimeUntil = personDeptRate?.has_custom_workhours && personDeptRate.on_time_until
    ? personDeptRate.on_time_until
    : isUtilityPerson
    ? "08:00"
    : null;

  const morningEnd = personDeptRate?.has_custom_workhours && personDeptRate.morning_end
    ? personDeptRate.morning_end
    : effectiveSettings.morning_end || "12:00";

  const afternoonStart = personDeptRate?.has_custom_workhours && personDeptRate.afternoon_start
    ? personDeptRate.afternoon_start
    : effectiveSettings.afternoon_start || "13:00";

  const afternoonEnd = personDeptRate?.has_custom_workhours && personDeptRate.afternoon_end
    ? personDeptRate.afternoon_end
    : effectiveSettings.afternoon_end || "17:00";

  const afternoonGrace = Number.isFinite(Number(effectiveSettings.afternoon_grace_minutes))
    ? Number(effectiveSettings.afternoon_grace_minutes)
    : 30;

  const schedMorningStartMin = parseTimeToMinutes(morningStart) || (isUtilityPerson ? 420 : 480);
  const schedOnTimeUntilMin = onTimeUntil ? parseTimeToMinutes(onTimeUntil) : (isUtilityPerson ? 480 : null);
  const schedAfternoonEndMin = parseTimeToMinutes(afternoonEnd) || 1020;
  const schedAfternoonGrace = afternoonGrace;

  return (rec) => {
    let otMinutes = 0;
    let earlyInHoursForRow = 0;
    let isEarlyOutForRow = false;
    let canManageOtForRow = false;

    const morningInMin = parseTimeToMinutes(rec.attendanceIn || rec.morningIn);
    const afternoonOutMin = parseTimeToMinutes(rec.attendanceOut || rec.afternoonOut || rec.morningOut);

    // 1. Afternoon Out & Overtime
    if (typeof afternoonOutMin === "number" && typeof schedAfternoonEndMin === "number") {
      const effectiveAfternoonOutMin = afternoonOutMin < 3 * 60 ? afternoonOutMin + 24 * 60 : afternoonOutMin;

      // Manage button renders if time out is 5:30 PM (17:30) or above
      if (effectiveAfternoonOutMin >= 17 * 60 + 30) {
        canManageOtForRow = true;
      }

      if (effectiveAfternoonOutMin > schedAfternoonEndMin) {
        const mins = effectiveAfternoonOutMin - schedAfternoonEndMin;
        // Overtime applies when 5:30 PM or above (past grace)
        if (effectiveAfternoonOutMin >= 17 * 60 + 30 && mins > schedAfternoonGrace) {
          otMinutes += mins;
        }
      } else if (effectiveAfternoonOutMin < schedAfternoonEndMin) {
        isEarlyOutForRow = true;
      }
    }

    // 2. Morning Early-In OT
    // 7:00-8:00 is on-time window with NO early-in OT computed
    if (typeof morningInMin === "number" && morningInMin >= 3 * 60) {
      if (schedOnTimeUntilMin !== null) {
        if (morningInMin >= schedMorningStartMin && morningInMin <= schedOnTimeUntilMin) {
          // On-time window: NO early-in OT
        } else if (morningInMin < schedMorningStartMin - 30) {
          const earlyMins = schedMorningStartMin - morningInMin;
          otMinutes += earlyMins;
          earlyInHoursForRow = earlyMins / 60;
        }
      } else {
        if (morningInMin <= 7 * 60 + 30 && morningInMin < schedMorningStartMin) {
          const earlyMins = schedMorningStartMin - morningInMin;
          otMinutes += earlyMins;
          earlyInHoursForRow = earlyMins / 60;
        }
      }
    }

    return {
      otMinutes,
      recOtHours: otMinutes / 60,
      earlyInHoursForRow,
      isEarlyOutForRow,
      canManageOtForRow,
    };
  };
}

// TEST CASES matching the 10 rows from Roy's Payslip screenshot
const roy = { id: 11, name: "Roy", department: "UTILITY", daily_rate: 486 };
const settings = {
  morning_start: "08:00:00",
  afternoon_end: "17:00:00",
  morning_grace_minutes: 0,
  afternoon_grace_minutes: 30,
};
const departmentRates = [
  {
    department: "UTILITY",
    has_custom_workhours: 1,
    morning_start: "07:00:00",
    morning_end: "11:59:00",
    afternoon_start: "13:00:00",
    afternoon_end: "17:00:00",
    on_time_until: "08:00:00",
  },
];

const computeRowOt = createComputeRowOt(roy, settings, departmentRates);

console.log("=== Testing Roy's Payslip Rows under UTILITY Department ===");

const testRows = [
  { date: "2026-10-29", morningIn: "08:00", afternoonOut: "17:57", expectedOtMins: 57, expectedCanManage: true },
  { date: "2026-10-30", morningIn: "07:25", afternoonOut: "17:57", expectedOtMins: 57, expectedCanManage: true },
  { date: "2026-11-02", morningIn: "07:22", afternoonOut: "18:28", expectedOtMins: 88, expectedCanManage: true },
  { date: "2026-11-03", morningIn: "07:12", afternoonOut: "18:12", expectedOtMins: 72, expectedCanManage: true },
  { date: "2026-11-04", morningIn: "07:16", afternoonOut: "17:10", expectedOtMins: 0,  expectedCanManage: false },
  { date: "2026-11-05", morningIn: "07:14", afternoonOut: "18:01", expectedOtMins: 61, expectedCanManage: true },
  { date: "2026-11-06", morningIn: "07:20", afternoonOut: "17:28", expectedOtMins: 0,  expectedCanManage: false },
  { date: "2026-11-09", morningIn: "07:10", afternoonOut: "18:31", expectedOtMins: 91, expectedCanManage: true },
  { date: "2026-11-10", morningIn: "07:11", afternoonOut: "18:19", expectedOtMins: 79, expectedCanManage: true },
  { date: "2026-11-11", morningIn: "06:42", afternoonOut: "17:29", expectedOtMins: 0,  expectedCanManage: false },
];

testRows.forEach((row) => {
  const result = computeRowOt(row);
  console.log(
    `Date: ${row.date} | In: ${row.morningIn} | Out: ${row.afternoonOut} -> ` +
    `OT: ${result.otMinutes}m (${result.recOtHours.toFixed(2)}h) | ` +
    `CanManage: ${result.canManageOtForRow}`
  );
  assert.strictEqual(
    result.otMinutes,
    row.expectedOtMins,
    `Row ${row.date}: Expected ${row.expectedOtMins}m OT, got ${result.otMinutes}m`
  );
  assert.strictEqual(
    result.canManageOtForRow,
    row.expectedCanManage,
    `Row ${row.date}: Expected canManage=${row.expectedCanManage}, got ${result.canManageOtForRow}`
  );
});

console.log("\nALL 10 PAYSLIP ROWS PASSED VERIFICATION PERFECTLY! ✓✓✓");
