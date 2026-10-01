// Utility to generate detailed attendance for PayslipModal
// Returns [{ date, morningIn, morningOut, afternoonIn, afternoonOut, lateCount, lateDetails }]
export function getDetailedAttendance(attendance, personId, settings = {}) {
  // Group attendance by date
  const byDate = {};
  attendance
    .filter((r) => r.person_id === personId)
    .forEach((r) => {
      const dt = new Date(r.device_time);
      if (isNaN(dt.getTime())) return;
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const d = String(dt.getDate()).padStart(2, "0");
      const dateStr = `${y}-${m}-${d}`;
      if (!byDate[dateStr]) byDate[dateStr] = [];
      byDate[dateStr].push({ ...r, dt });
    });

  const morningStart = settings.morning_start || "08:00";
  const morningLateMinutes = Number(
    settings.morning_late_minutes ?? settings.morning_grace_minutes ?? 0
  );
  const afternoonStart = settings.afternoon_start || "13:00";
  const afternoonLateMinutes = Number(
    settings.afternoon_late_minutes ?? settings.afternoon_grace_minutes ?? 0
  );

  function isEarlyIn(dt) {
    const mins = dt.getHours() * 60 + dt.getMinutes();
    const [h, m] = morningStart.split(":").map(Number);
    const startMins = h * 60 + m;
    return mins < startMins;
  }

  function isLate(dt, session) {
    // Returns true if dt is after (start + late_minutes)
    const mins = dt.getHours() * 60 + dt.getMinutes();
    if (session === "morning") {
      const [h, m] = morningStart.split(":").map(Number);
      const startMins = h * 60 + m;
      return mins > startMins + morningLateMinutes;
    } else {
      const [h, m] = afternoonStart.split(":").map(Number);
      const startMins = h * 60 + m;
      return mins > startMins + afternoonLateMinutes;
    }
  }

  function getMinutesLate(dt, session) {
    const mins = dt.getHours() * 60 + dt.getMinutes();
    if (session === "morning") {
      const [h, m] = morningStart.split(":").map(Number);
      const startMins = h * 60 + m;
      return Math.max(1, mins - startMins);
    } else {
      const [h, m] = afternoonStart.split(":").map(Number);
      const startMins = h * 60 + m;
      return Math.max(1, mins - startMins);
    }
  }

  return Object.entries(byDate)
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([date, recs]) => {
    // Sort by time
    recs.sort((a, b) => a.dt - b.dt);
    // Find morning/afternoon in/out
    let morningIn = null,
      afternoonOut = null;
    let morningInStatus = null;
    let lateCount = 0;
    let lateDetails = [];
    // Separate morning (< 12:00) and afternoon (>= 12:00) punches
    recs.forEach((r) => {
      const hour = r.dt.getHours();
      const timeStr = r.dt.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      // Morning punch (before 12 PM) - only morning arrivals are evaluated for lateness
      if (hour < 12) {
        if (!morningIn) {
          morningIn = timeStr;
          if (r.status === "late" || isLate(r.dt, "morning")) {
            morningInStatus = "late";
            lateCount++;
            const minutesLate = getMinutesLate(r.dt, "morning");
            lateDetails.push({
              session: "Time In",
              time: timeStr,
              status: "late",
              minutesLate,
            });
          } else if (r.status === "early-in" || isEarlyIn(r.dt)) {
            morningInStatus = "early-in";
          } else {
            morningInStatus = "on-time";
          }
        }
      } else {
        // Afternoon punch
        afternoonOut = timeStr;
      }
    });

    // Attendance In = 1st attempt of attendance on that day
    // Attendance Out = 2nd / last attempt of attendance on that day
    let attendanceIn = null;
    let attendanceOut = null;
    if (recs.length >= 2) {
      attendanceIn = recs[0].dt.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      attendanceOut = recs[recs.length - 1].dt.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } else if (recs.length === 1) {
      const singleTime = recs[0].dt.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      if (recs[0].dt.getHours() < 12) {
        attendanceIn = singleTime;
        attendanceOut = null;
      } else {
        attendanceIn = null;
        attendanceOut = singleTime;
      }
    }

    // Overtime calculation (supports Early-In at 7:00 AM and below, plus Afternoon Out OT)
    let status = "on-time";
    let otHours = 0;
    const checkoutTime = attendanceOut || afternoonOut;
    const checkinTime = attendanceIn || morningIn;

    function parseTimeToMinutes(timeStr) {
      if (!timeStr) return 0;
      let hour = 0,
        minute = 0;
      let match = String(timeStr).match(/(\d{1,2}):(\d{2})(?:\s*([APap][Mm]))?/);
      if (match) {
        hour = parseInt(match[1], 10);
        minute = parseInt(match[2], 10);
        const ampm = match[3];
        if (ampm) {
          if (/pm/i.test(ampm) && hour < 12) hour += 12;
          if (/am/i.test(ampm) && hour === 12) hour = 0;
        }
      }
      return hour * 60 + minute;
    }

    const schedMorningStart = (settings && settings.morning_start) || "08:00";
    const schedAfternoonEnd = (settings && settings.afternoon_end) || "17:00";
    const startTotal = parseTimeToMinutes(schedMorningStart) || 480;
    const endTotal = parseTimeToMinutes(schedAfternoonEnd) || 1020;
    // Early-in overtime triggers at 7:00 AM and below
    const earlyOtLimit = Math.min(startTotal - 60, parseTimeToMinutes("07:00") || 420);

    let dayOtMinutes = 0;

    if (checkinTime) {
      const inTotal = parseTimeToMinutes(checkinTime);
      if (inTotal > 0 && inTotal <= earlyOtLimit && inTotal < startTotal) {
        dayOtMinutes += (startTotal - inTotal);
      }
    }

    if (checkoutTime) {
      const outTotal = parseTimeToMinutes(checkoutTime);
      if (outTotal > endTotal) {
        const afterMins = outTotal - endTotal;
        if (afterMins >= 60) {
          dayOtMinutes += afterMins;
        }
      }
    }

    if (dayOtMinutes > 0) {
      status = "overtime";
      otHours = Math.round((dayOtMinutes / 60) * 100) / 100;
    }
    return {
      date,
      attendanceIn,
      attendanceOut,
      morningIn,
      afternoonOut,
      morningInStatus,
      lateCount,
      lateDetails,
      status,
      otHours,
    };
  });
}
