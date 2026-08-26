import React from "react";
import { useEffect, useState } from "react";
import {
  FiPrinter,
  FiCalendar,
  FiClipboard,
  FiX,
  FiClock,
  FiTrendingDown,
} from "react-icons/fi";
import Icon from "../../components/Icon";
import { supabase } from "../../supabaseClient";
import { generatePayslipPdf } from "./generatePayslipPdf";

// detailedAttendance: [{ date, morningIn, morningOut, afternoonIn, afternoonOut, lateCount, lateDetails: [{session, time, status}]}]
export default function PayslipModal({
  payroll,
  person,
  detailedAttendance = [],
  onClose,
  showPrintButton,
  period,
  released,
}) {
  // useState declarations (only once)
  const [holidayDetails, setHolidayDetails] = useState([]);
  const [deptHolidayRates, setDeptHolidayRates] = useState({
    regular: 0,
    special: 0,
  });
  const [loadingHoliday, setLoadingHoliday] = useState(true);
  const [cashAdvanceTotalInPeriod, setCashAdvanceTotalInPeriod] = useState(0);
  const [cashAdvanceEntries, setCashAdvanceEntries] = useState([]);

  // Debug output for troubleshooting
  React.useEffect(() => {
    if (!loadingHoliday) {
      console.log("Fetched holidays:", holidayDetails);
      console.log("Department holiday rates:", deptHolidayRates);
      console.log(
        "Attendance dates:",
        detailedAttendance.map((a) => a.date),
      );
    }
  }, [loadingHoliday, holidayDetails, deptHolidayRates, detailedAttendance]);

  // ✅ FETCH DEPARTMENT RATES
  useEffect(() => {
    async function getDeptHolidayRates() {
      if (!person?.department) return;

      const { data, error } = await supabase
        .from("department_rates")
        .select("*")
        .eq("department", person.department)
        .single();

      if (!error && data) {
        setDeptHolidayRates({
          regular: Number(data.regular_holiday_rate ?? data.holiday_rate ?? 0),
          special: Number(data.special_holiday_rate ?? 0),
        });
      }
    }

    getDeptHolidayRates();
  }, [person]);

  // ✅ FETCH HOLIDAYS (accurate for payroll period)
  useEffect(() => {
    async function getHolidays() {
      try {
        if (!person || !period) return;
        const [start, end] = period.split("_to_");
        // Fetch holidays for the department or global (department is null) within the period
        const { data: holidays, error } = await supabase
          .from("holidays")
          .select("*")
          .or(`department.eq.${person.department},department.is.null`)
          .gte("date", start)
          .lte("date", end);
        if (error) throw error;
        // Sort by date
        const all = (holidays || []).sort((a, b) =>
          a.date.localeCompare(b.date),
        );
        setHolidayDetails(all);
      } catch (err) {
        console.error("Error fetching holidays:", err);
        setHolidayDetails([]);
      } finally {
        setLoadingHoliday(false);
      }
    }
    getHolidays();
  }, [person, period]);

  // Fetch total cash advances for this person within the payroll period
  useEffect(() => {
    let mounted = true;
    async function fetchCashAdvanceTotal() {
      if (!person?.id || !period) {
        if (mounted) setCashAdvanceTotalInPeriod(0);
        return;
      }

      try {
        const [start, end] = period.split("_to_");
        const { data, error } = await supabase
          .from("cash_advances")
          .select("id, amount, created_at, note")
          .eq("person_id", person.id)
          .gte("created_at", start)
          .lte("created_at", end)
          .order("created_at", { ascending: true });
        if (error) throw error;
        const entries = data || [];
        const total = entries.reduce((s, r) => s + Number(r.amount || 0), 0);
        if (mounted) {
          setCashAdvanceEntries(entries);
          setCashAdvanceTotalInPeriod(Math.round(total * 100) / 100);
        }
      } catch (err) {
        console.error("Error fetching cash advance total:", err);
        if (mounted) setCashAdvanceTotalInPeriod(0);
      } finally {
        // finished
      }
    }
    fetchCashAdvanceTotal();
    return () => {
      mounted = false;
    };
  }, [person, period]);
  const handlePdf = async () => {
    const grossPay =
      Math.round((standardPayAmount + otPay + totalHolidayPay) * 100) / 100;
    // compute total OT hours for the period to include in PDF (decimal hours)
    let totalOtMinutesForPdf = 0;
    try {
      const sched = payroll && payroll.settings ? payroll.settings : {};
      const schedMorningEnd = sched.morning_end || "12:00";
      const schedAfternoonEnd = sched.afternoon_end || "17:00";
      (detailedAttendance || []).forEach((rec) => {
        try {
          const mOut = parseTimeToMinutes(rec.morningOut);
          const aOut = parseTimeToMinutes(rec.afternoonOut);
          const mEnd = parseTimeToMinutes(schedMorningEnd);
          const aEnd = parseTimeToMinutes(schedAfternoonEnd);
          if (
            typeof mOut === "number" &&
            typeof mEnd === "number" &&
            mOut > mEnd
          )
            totalOtMinutesForPdf += mOut - mEnd;
          if (
            typeof aOut === "number" &&
            typeof aEnd === "number" &&
            aOut > aEnd
          )
            totalOtMinutesForPdf += aOut - aEnd;
        } catch (e) {}
      });
    } catch (e) {}
    const totalOtHoursForPdf =
      Math.round((totalOtMinutesForPdf / 60) * 100) / 100;
    // ensure payroll.otHours is available for older code paths
    try {
      payroll.otHours = totalOtHoursForPdf;
    } catch (e) {}
    await generatePayslipPdf({
      payroll,
      person,
      period,
      holidayPayDetails,
      totalHolidayPay,
      absentCount,
      totalDeductions,
      daysWorked,
      standardPayAmount,
      otPay,
      otHours: totalOtHoursForPdf,
      gross: grossPay,
      cashAdvanceEntries,
      cashAdvanceTotalInPeriod,
    });
  };

  // Helper to display hours and minutes
  const getHourMinute = (hours) => {
    if (!hours || hours <= 0) return "-";
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    let str = "";
    if (h > 0 && m > 0) str = `${h}hr and ${m}min`;
    else if (h > 0) str = `${h}hr`;
    else if (m > 0) str = `${m}min`;
    return str || "0min";
  };

  // Format a period string like '2026-04-07_to_2026-04-21' into
  // 'April 07, 2026 to April 21, 2026'. Falls back to original string.
  function formatPeriod(period) {
    if (!period) return "";
    try {
      const s = String(period).replace(/_/g, " ");
      const matches = Array.from(s.matchAll(/(\d{4}[-/]\d{2}[-/]\d{2})/g)).map(
        (m) => m[1],
      );
      if (matches.length >= 2) {
        const d1 = new Date(matches[0].replace(/\//g, "-"));
        const d2 = new Date(matches[1].replace(/\//g, "-"));
        if (!Number.isNaN(d1.getTime()) && !Number.isNaN(d2.getTime())) {
          const f1 = d1.toLocaleDateString("en-US", {
            month: "long",
            day: "2-digit",
            year: "numeric",
          });
          const f2 = d2.toLocaleDateString("en-US", {
            month: "long",
            day: "2-digit",
            year: "numeric",
          });
          return `${f1} to ${f2}`;
        }
      }
      const single = s.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
      if (single) {
        const d = new Date(single[1].replace(/\//g, "-"));
        if (!Number.isNaN(d.getTime()))
          return d.toLocaleDateString("en-US", {
            month: "long",
            day: "2-digit",
            year: "numeric",
          });
      }
      const p = new Date(s);
      if (!Number.isNaN(p.getTime()))
        return p.toLocaleDateString("en-US", {
          month: "long",
          day: "2-digit",
          year: "numeric",
        });
    } catch (e) {}
    return String(period);
  }

  // Format an ISO date (yyyy-mm-dd) into 'April 15, 2026 (Thursday)'
  const formatDateWithWeekday = (isoDateStr) => {
    try {
      const d = new Date(isoDateStr);
      if (Number.isNaN(d.getTime())) return isoDateStr;
      const dateLabel = d.toLocaleDateString("en-US", {
        month: "long",
        day: "2-digit",
        year: "numeric",
      });
      const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
      return `${dateLabel} (${weekday})`;
    } catch (e) {
      return isoDateStr;
    }
  };

  // Helper: parse HH:MM or HH:MM:SS with optional AM/PM into minutes since midnight
  function parseTimeToMinutes(t) {
    if (!t) return null;
    const m = String(t)
      .trim()
      .match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?$/);
    if (!m) return null;
    let hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = m[3] ? Number(m[3]) : 0;
    const ampm = m[4];
    if (ampm) {
      const a = ampm.toLowerCase();
      if (a === "pm" && hh !== 12) hh += 12;
      if (a === "am" && hh === 12) hh = 0;
    }
    return hh * 60 + mm + Math.round(ss / 60);
  }

  if (!payroll || !person) return null;

  // Calculate absent days in the 15-day period
  // Get the period start and end from the period string (e.g. 2024-03-01_to_2024-03-15)
  let absentDates = [];
  if (period) {
    const [start, end] = period.split("_to_");
    const startDate = new Date(start);
    const endDate = new Date(end);
    const todayStr = new Date().toISOString().slice(0, 10);
    // Build a set of holiday ISO dates for this period (if any)
    const holidaySet = new Set(
      (holidayDetails || [])
        .map((h) => {
          const raw = h && (h.date || h.holiday_date || h.holiday);
          if (!raw) return null;
          try {
            return new Date(raw).toISOString().slice(0, 10);
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean),
    );

    // Build all non-weekend, non-holiday dates in the period
    let allDates = [];
    for (
      let d = new Date(startDate);
      d <= endDate;
      d.setDate(d.getDate() + 1)
    ) {
      // Exclude Saturday (6) and Sunday (0)
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const dateStr = new Date(d).toISOString().slice(0, 10);
      // Skip if this date is a holiday in the fetched holidayDetails
      if (holidaySet.has(dateStr)) continue;
      allDates.push(new Date(d));
    }
    // Build a lookup by date for detailed attendance
    const attendanceByDate = Object.fromEntries(
      (detailedAttendance || []).map((a) => {
        const dt = new Date(a.date).toISOString().slice(0, 10);
        return [dt, a];
      }),
    );

    // Determine expected sessions if person has shift/work_hours metadata
    const ps = String(
      person && (person.shift || person.work_hours || ""),
    ).toLowerCase();
    const expectsMorningOnly =
      (ps.includes("morning") && ps.includes("half")) ||
      ps === "morning" ||
      ps === "morning-half";
    const expectsAfternoonOnly =
      (ps.includes("afternoon") && ps.includes("half")) ||
      ps === "afternoon" ||
      ps === "afternoon-half";
    const expectsSingleSession =
      ps === "half" ||
      ps === "half-day" ||
      ps === "4" ||
      ps === "4h" ||
      ps.includes("half");

    // For each date in the period (weekdays only) that is before today, determine missing sessions
    absentDates = allDates
      .map((d) => d.toISOString().slice(0, 10))
      .filter((dateStr) => dateStr < todayStr)
      .map((dateStr) => {
        const rec = attendanceByDate[dateStr] || null;
        if (!rec) {
          // no attendance record at all -> full day absent
          return { date: dateStr, missing: "Full Day" };
        }
        const hasMorning = !!rec.morningIn;
        const hasAfternoon = !!rec.afternoonIn;

        if (expectsMorningOnly) {
          if (!hasMorning) return { date: dateStr, missing: "Morning" };
          return null;
        }
        if (expectsAfternoonOnly) {
          if (!hasAfternoon) return { date: dateStr, missing: "Afternoon" };
          return null;
        }
        if (expectsSingleSession) {
          // half-day staff: missing if neither session present
          if (!hasMorning && !hasAfternoon)
            return { date: dateStr, missing: "Session" };
          return null;
        }
        // default: if both sessions missing -> full day absent. If one session missing, mark which one
        if (!hasMorning && !hasAfternoon)
          return { date: dateStr, missing: "Full Day" };
        if (!hasMorning) return { date: dateStr, missing: "Morning" };
        if (!hasAfternoon) return { date: dateStr, missing: "Afternoon" };
        return null;
      })
      .filter(Boolean);
  }
  const absentCount = absentDates.length;

  // Calculate holiday pay for each holiday (accurate for payroll period)
  let holidayPayDetails = [];
  let totalHolidayPay = 0;

  if (!loadingHoliday && holidayDetails.length > 0) {
    holidayPayDetails = holidayDetails
      .map((h) => {
        let ratePercent = 0;
        if (h.type === "regular") {
          ratePercent = deptHolidayRates.regular;
        } else if (h.type === "special") {
          ratePercent = deptHolidayRates.special;
        }
        if (!ratePercent) return null;
        const amount = (payroll.dailyRate * ratePercent) / 100;
        totalHolidayPay += amount;
        return {
          date: h.date,
          type: h.type,
          rate: payroll.dailyRate,
          amount,
          ratePercent,
        };
      })
      .filter(Boolean);
  }

  // Calculate Standard Pay based on attendance (full/half days)
  // Prefer stored payroll values when available so modal matches table
  let daysWorked = 0;
  let daysWorkedDisplay = "";
  const payrollDaysPresent =
    payroll && (payroll.daysPresent ?? payroll.days_present ?? null);
  if (payrollDaysPresent != null) {
    daysWorked = Number(payrollDaysPresent) || 0;
    daysWorkedDisplay = `${daysWorked} day(s)`;
  } else if (detailedAttendance.length) {
    let totalHoursWorked = 0;
    const lunchStart = parseTimeToMinutes(payroll?.settings?.morning_end || "12:00") || 720;
    const lunchEnd = parseTimeToMinutes(payroll?.settings?.afternoon_start || "13:00") || 780;
    const lunchDuration = Math.max(0, lunchEnd - lunchStart);
    
    detailedAttendance.forEach((rec) => {
      if (!rec.morningIn || !rec.afternoonOut) return;
      const scheduledStart = parseTimeToMinutes(payroll?.settings?.morning_start || "08:00") || 480;
      const aOut = parseTimeToMinutes(rec.afternoonOut);
      if (aOut !== null) {
        const mIn = scheduledStart; // Use scheduled start to avoid double deduction with Late Penalty
        let workedMinutes = aOut - mIn;
        if (mIn <= lunchStart && aOut >= lunchEnd) {
          workedMinutes -= lunchDuration;
        } else if (mIn <= lunchStart && aOut > lunchStart && aOut < lunchEnd) {
          workedMinutes -= (aOut - lunchStart);
        } else if (mIn > lunchStart && mIn < lunchEnd && aOut >= lunchEnd) {
          workedMinutes -= (lunchEnd - mIn);
        }
        
        // Round to the nearest 15 minutes to handle tiny variations (e.g. clocking out at 4:59 PM)
        workedMinutes = Math.round(workedMinutes / 15) * 15;

        let standardWorkedMinutes = Math.min(workedMinutes, 480);
        if (standardWorkedMinutes > 0) {
          totalHoursWorked += standardWorkedMinutes / 60;
        }
      }
    });
    daysWorked = Math.round((totalHoursWorked / 8) * 1000) / 1000;
    daysWorkedDisplay = `${totalHoursWorked.toFixed(2)} hrs (${daysWorked} days)`;
  } else {
    daysWorked = payroll.daysPresent || 0;
    daysWorkedDisplay = `${daysWorked} day(s)`;
  }

  // Standard Pay calculation
  const standardPayAmount =
    Math.round(daysWorked * (payroll.dailyRate ?? 0) * 100) / 100;

  // Overtime calculation: always use dailyRate/8 (no premium) for display and calculation, and round to 2 decimals for all math
  const hourlyRate = Math.round(((payroll.dailyRate ?? 0) / 8) * 100) / 100;
  // Ensure otHours is rounded to 2 decimals for precision
  const otHours = Math.round((payroll.otHours ?? 0) * 100) / 100;
  // Round OT pay to 2 decimals for display and math
  const otPay = Math.round(hourlyRate * otHours * 100) / 100;
  const deductions = [
    { label: "SSS", value: person.sss ? Number(payroll.sss) : 0 },
    {
      label: "Pag-ibig",
      value: person.pag_ibig ? Number(payroll.pag_ibig) : 0,
    },
    {
      label: "PhilHealth",
      value: person.philhealth ? Number(payroll.philhealth) : 0,
    },
  ];

  const lateCountLimit =
    payroll.lateCountLimit || payroll.late_count_limit || 5;
  const latePenalty = person.late_penalty || 0;
  const lateDeduction =
    payroll.totalLateDeduction ??
    payroll.total_late_deduction ??
    (payroll.lateCount >= lateCountLimit ? payroll.lateCount * latePenalty : 0);
  const computedDeductionsSum =
    lateDeduction + deductions.reduce((acc, d) => acc + d.value, 0) +
    Number(cashAdvanceTotalInPeriod || 0);
  const totalDeductions =
    Math.round(
      (Number(payroll.totalDeductions ?? payroll.total_deductions ?? computedDeductionsSum) || computedDeductionsSum) *
        100,
    ) / 100;

  const totalLateOccurrences = detailedAttendance
    .map((rec) => (rec.lateDetails ? rec.lateDetails.length : 0))
    .reduce((sum, n) => sum + n, 0);

  const allLateDetails = detailedAttendance
    .map((rec) =>
      rec.lateDetails
        ? rec.lateDetails.map((ld) => ({ date: rec.date, ...ld }))
        : [],
    )
    .flat();

  const styles = {
    overlay: {
      position: "fixed",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      background: "rgba(0,0,0,0.5)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 1000,
      backdropFilter: "blur(4px)",
    },
    modal: {
      background: "#fff",
      color: "#1f2937",
      padding: "32px",
      borderRadius: "28px",
      maxWidth: "900px",
      width: "95%",
      overflowY: "auto",
      maxHeight: "90%",
      boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
      border: "1px solid #e5e7eb",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    },
    title: {
      fontSize: "2rem",
      fontWeight: 700,
      color: "#237227",
      textAlign: "center",
      margin: "0 0 8px 0",
    },
    subtitle: {
      textAlign: "center",
      color: "#6b7280",
      marginBottom: "32px",
      fontSize: "1rem",
    },
    sectionTitle: {
      fontSize: "1.4rem",
      fontWeight: 600,
      color: "#1f2937",
      margin: "32px 0 16px 0",
      borderBottom: "2px solid #237227",
      paddingBottom: "8px",
    },
    table: {
      width: "100%",
      borderCollapse: "collapse",
      marginBottom: "24px",
      fontSize: "0.95rem",
    },
    th: {
      background: "#f9fafb",
      color: "#4b5563",
      fontWeight: 600,
      padding: "12px 8px",
      textAlign: "left",
      borderBottom: "2px solid #e5e7eb",
      textTransform: "uppercase",
      fontSize: "0.8rem",
      letterSpacing: "0.03em",
    },
    td: {
      padding: "10px 8px",
      borderBottom: "1px solid #e5e7eb",
      color: "#1f2937",
    },
    trEven: { backgroundColor: "#f9fafb" },
    trOdd: { backgroundColor: "#ffffff" },
    summaryRow: { background: "#f3f4f6", fontWeight: 600 },
    lateText: { color: "#ef4444" },
    netPay: {
      textAlign: "right",
      fontSize: "1.6rem",
      fontWeight: 700,
      color: "#237227",
      margin: "16px 0 0 0",
    },
    buttonContainer: {
      marginTop: "24px",
      display: "flex",
      justifyContent: "flex-end",
      gap: "12px",
    },
    button: {
      padding: "10px 24px",
      borderRadius: "40px",
      fontSize: "0.95rem",
      fontWeight: 500,
      border: "none",
      cursor: "pointer",
      transition: "all 0.2s",
      boxShadow: "0 4px 10px rgba(0,0,0,0.1)",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
    },
    buttonPrimary: { background: "#237227", color: "#fff" },
    buttonSecondary: {
      background: "#e5e7eb",
      color: "#1f2937",
      border: "1px solid #d1d5db",
    },
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        {/* ✅ PDF ONLY CONTENT */}
        <div className="payslip-modal-content-inner">
          <h2 style={styles.title}>Payslip</h2>
          <p style={styles.subtitle}>
            {person.name} • {person.department} • ID: {person.id}
          </p>
          {period && (
            <p
              style={{
                textAlign: "center",
                color: "#237227",
                fontWeight: 600,
                marginBottom: 8,
              }}
            >
              Period: {formatPeriod(period)}
            </p>
          )}
          {released && (
            <p
              style={{
                textAlign: "center",
                color: "#237227",
                fontWeight: 700,
                fontSize: "1.1rem",
                marginBottom: 8,
              }}
            >
              Payslip Released
            </p>
          )}

          {/* Holiday Table */}
          {!loadingHoliday && holidayPayDetails.length > 0 && (
            <>
              <h3 style={styles.sectionTitle}>
                <Icon
                  as={FiCalendar}
                  style={{ marginRight: 8 }}
                  ariaLabel="Holidays"
                />
                Holidays This Month
              </h3>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Date</th>
                    <th style={styles.th}>Type</th>
                    <th style={styles.th}>Rate (%)</th>
                    {/* <th style={styles.th}>Amount</th> */}
                  </tr>
                </thead>
                <tbody>
                  {holidayPayDetails.map((h, i) => (
                    <tr key={h.date + h.type}>
                      <td style={styles.td}>{h.date}</td>
                      <td style={styles.td}>
                        {h.type === "regular"
                          ? "Regular Holiday"
                          : "Special Holiday"}
                      </td>
                      <td style={styles.td}>{h.ratePercent}</td>
                      {/* <td style={styles.td}>₱{h.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td> */}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* Attendance Table */}
          <h3 style={styles.sectionTitle}>
            <Icon
              as={FiClipboard}
              style={{ marginRight: 8 }}
              ariaLabel="Attendance"
            />
            Attendance Details
          </h3>

          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Date</th>
                <th style={styles.th}>Morning In</th>
                <th style={styles.th}>Afternoon Out</th>
                <th style={styles.th}>OT</th>
                <th style={styles.th}>Late Count</th>
                <th style={styles.th}>Late Details</th>
                {/* Removed unused OT (hrs) column */}
              </tr>
            </thead>
            <tbody>
              {detailedAttendance.length ? (
                detailedAttendance.map((rec, i) => {
                  const rowStyle = i % 2 === 0 ? styles.trEven : styles.trOdd;
                  // Removed unused otDisplay variable

                  // Settings for time-in/time-out
                  const settings =
                    payroll && payroll.settings ? payroll.settings : {};

                  const morningStart = settings.morning_start || "08:00";
                  const morningEnd = settings.morning_end || "12:00";
                  const afternoonStart = settings.afternoon_start || "13:00";
                  const afternoonEnd = settings.afternoon_end || "17:00";

                  // Helper to check if it's not yet time for time-in/time-out
                  function isNotYetTime(session, date, type) {
                    // type: 'in' or 'out'
                    const now = new Date();
                    const dateObj = new Date(date);
                    let sessionTime;
                    if (session === "morning") {
                      sessionTime = type === "in" ? morningStart : morningEnd;
                    } else {
                      sessionTime =
                        type === "in" ? afternoonStart : afternoonEnd;
                    }
                    const [h, m] = sessionTime.split(":").map(Number);
                    dateObj.setHours(h, m, 0, 0);
                    return now < dateObj;
                  }

                  // Morning In
                  let morningInDisplay = "-";
                  if (rec.morningIn) {
                    morningInDisplay = rec.morningIn;
                  } else if (!isNotYetTime("morning", rec.date, "in")) {
                    morningInDisplay = "Not time-in";
                  }

                  // Afternoon Out
                  let afternoonOutDisplay = "-";
                  if (rec.afternoonOut) {
                    afternoonOutDisplay = rec.afternoonOut;
                  } else if (!isNotYetTime("afternoon", rec.date, "out")) {
                    afternoonOutDisplay = "Missing (Rate: 0)";
                  }

                  // Compute per-row overtime (minutes) by comparing out times to scheduled end times.
                  let otMinutes = 0;
                  try {
                    const scheduledMorningEnd =
                      (settings && settings.morning_end) || "12:00";
                    const scheduledAfternoonEnd =
                      (settings && settings.afternoon_end) || "17:00";
                    const morningOutMin = parseTimeToMinutes(rec.morningOut);
                    const afternoonOutMin = parseTimeToMinutes(
                      rec.afternoonOut,
                    );
                    const schedMorningEndMin =
                      parseTimeToMinutes(scheduledMorningEnd);
                    const schedAfternoonEndMin = parseTimeToMinutes(
                      scheduledAfternoonEnd,
                    );
                    if (
                      typeof afternoonOutMin === "number" &&
                      typeof schedAfternoonEndMin === "number" &&
                      afternoonOutMin > schedAfternoonEndMin
                    ) {
                      const mins = afternoonOutMin - schedAfternoonEndMin;
                      if (mins >= 60) otMinutes += mins;
                    }
                    // include morning overtime if present (rare)
                    if (
                      typeof morningOutMin === "number" &&
                      typeof schedMorningEndMin === "number" &&
                      morningOutMin > schedMorningEndMin
                    ) {
                      const mins = morningOutMin - schedMorningEndMin;
                      if (mins >= 60) otMinutes += mins;
                    }
                  } catch (e) {
                    otMinutes = 0;
                  }

                  const recOtHours = Math.round((otMinutes / 60) * 100) / 100;

                  return (
                    <tr key={i} style={rowStyle}>
                      <td style={styles.td}>{rec.date}</td>
                      <td
                        style={{
                          ...styles.td,
                          color:
                            rec.morningInStatus === "late"
                              ? styles.lateText.color
                              : undefined,
                        }}
                      >
                        {morningInDisplay}
                      </td>
                      <td style={styles.td}>{afternoonOutDisplay}</td>
                      <td style={styles.td}>
                        {getHourMinute(recOtHours)} ({recOtHours.toFixed(2)})
                      </td>
                      <td style={styles.td}>{rec.lateCount || 0}</td>
                      <td style={styles.td}>
                        {rec.lateDetails && rec.lateDetails.length ? (
                          <ul style={{ margin: 0, paddingLeft: 16 }}>
                            {rec.lateDetails.map((d, idx) => (
                              <li key={idx} style={styles.lateText}>
                                {d.session}: {d.time} ({d.status})
                              </li>
                            ))}
                          </ul>
                        ) : (
                          "-"
                        )}
                      </td>
                      {/* Removed unused otDisplay cell */}
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan="9"
                    style={{
                      ...styles.td,
                      textAlign: "center",
                      color: "#9ca3af",
                    }}
                  >
                    No attendance records
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h3 style={styles.sectionTitle}>
            <Icon as={FiX} style={{ marginRight: 8 }} ariaLabel="Absent days" />
            Absent Days in Period
          </h3>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Absent Day</th>
                <th style={styles.th}>Missing Session</th>
              </tr>
            </thead>
            <tbody>
              {absentCount > 0 ? (
                absentDates.map((item, idx) => (
                  <tr
                    key={item.date}
                    style={idx % 2 === 0 ? styles.trEven : styles.trOdd}
                  >
                    <td style={styles.td}>
                      {formatDateWithWeekday(item.date)}
                    </td>
                    <td style={styles.td}>{item.missing}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={2}
                    style={{
                      ...styles.td,
                      color: "#237227",
                      textAlign: "center",
                    }}
                  >
                    No absences in this period
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {/* Late Records */}
          <h3 style={styles.sectionTitle}>
            <Icon
              as={FiClock}
              style={{ marginRight: 8 }}
              ariaLabel="Late records"
            />
            All Late Records
          </h3>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Date</th>
                <th style={styles.th}>Session</th>
                <th style={styles.th}>Time</th>
                <th style={styles.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {allLateDetails.length ? (
                allLateDetails.map((d, i) => {
                  const rowStyle = i % 2 === 0 ? styles.trEven : styles.trOdd;
                  return (
                    <tr key={i} style={rowStyle}>
                      <td style={styles.td}>{d.date}</td>
                      <td style={styles.td}>{d.session}</td>
                      <td style={styles.td}>{d.time}</td>
                      <td
                        style={{
                          ...styles.td,
                          color:
                            d.status === "late"
                              ? styles.lateText.color
                              : undefined,
                        }}
                      >
                        {d.status}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan="4"
                    style={{
                      ...styles.td,
                      textAlign: "center",
                      color: "#9ca3af",
                    }}
                  >
                    No late records
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Earnings */}

          <h3 style={styles.sectionTitle}>
            <span
              aria-label="Peso"
              style={{ marginRight: 8, fontSize: 18, fontWeight: 700 }}
            >
              ₱
            </span>
            Earnings
          </h3>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Days/Hours</th>
                <th style={styles.th}>Rate</th>
                <th style={styles.th}>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr style={styles.trEven}>
                <td style={styles.td}>Standard Pay</td>
                <td style={styles.td}>{daysWorkedDisplay}</td>
                <td style={styles.td}>
                  ₱{(payroll.dailyRate ?? 0).toFixed(2)}
                </td>
                <td style={styles.td}>
                  ₱
                  {standardPayAmount.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                  })}
                </td>
              </tr>
              <tr style={styles.trOdd}>
                <td style={styles.td}>Overtime Pay</td>
                <td style={styles.td}>{getHourMinute(otHours)}</td>
                <td style={styles.td}>
                  (Daily Rate) ÷ 8hrs =₱{hourlyRate.toFixed(2)}
                </td>
                <td style={styles.td}>₱{otPay.toFixed(2)}</td>
              </tr>
              {/* ✅ Holiday Pay */}
              {holidayPayDetails.length > 0 ? (
                <>
                  {holidayPayDetails.map((h, idx) => (
                    <tr
                      key={idx}
                      style={idx % 2 === 0 ? styles.trEven : styles.trOdd}
                    >
                      <td style={styles.td}>Holiday Pay</td>
                      <td style={styles.td}>
                        {h.date} (
                        {h.type === "regular"
                          ? "Regular Holiday"
                          : "Special Holiday"}
                        )
                      </td>
                      <td style={styles.td}>
                        <span style={{ color: "#237227", fontWeight: 600 }}>
                          {" "}
                          ({h.ratePercent}%)
                        </span>
                      </td>
                      <td style={styles.td}>
                        ₱{(h.amount ?? 0).toLocaleString()}
                      </td>
                    </tr>
                  ))}

                  <tr style={styles.summaryRow}>
                    <td colSpan="3" style={styles.td}>
                      Total Holiday Pay
                    </td>
                    <td style={styles.td}>
                      ₱{totalHolidayPay.toLocaleString()}
                    </td>
                  </tr>
                </>
              ) : (
                <tr>
                  <td
                    colSpan="4"
                    style={{ textAlign: "center", color: "#9ca3af" }}
                  >
                    No holiday pay for this period
                  </td>
                </tr>
              )}
              <tr style={styles.summaryRow}>
                <td colSpan="3" style={styles.td}>
                  Gross Pay
                </td>
                <td style={styles.td}>
                  ₱{(
                    Number(
                      payroll.gross ??
                        Math.round((standardPayAmount + otPay + totalHolidayPay) * 100) / 100,
                    )
                  ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
              </tr>
            </tbody>
          </table>

          {/* Deductions */}
          <h3 style={styles.sectionTitle}>
            <Icon
              as={FiTrendingDown}
              style={{ marginRight: 8 }}
              ariaLabel="Deductions"
            />
            Deductions
          </h3>
          <table style={styles.table}>
            <tbody>
              <tr style={styles.trEven}>
                <td style={styles.td}>Total Late Occurrences</td>
                <td style={styles.td}>{totalLateOccurrences} occurrence(s)</td>
              </tr>
              <tr style={styles.trOdd}>
                <td style={styles.td}>Late Count</td>
                <td style={styles.td}>{payroll.lateCount} occurrence(s)</td>
              </tr>
              <tr style={styles.trEven}>
                <td style={styles.td}>Late Count Limit for Deduction</td>
                <td style={styles.td}>{lateCountLimit} occurrence(s)</td>
              </tr>
              <tr style={styles.trOdd}>
                <td style={styles.td}>Total Late Deduction</td>
                <td style={styles.td}>₱{lateDeduction.toLocaleString()}</td>
              </tr>
              {deductions.map((d, i) => (
                <tr
                  key={d.label}
                  style={i % 2 === 0 ? styles.trEven : styles.trOdd}
                >
                  <td style={styles.td}>{d.label}</td>
                  <td style={styles.td}>
                    {d.loading ? (
                      <span style={{ color: "#6b7280" }}>Loading...</span>
                    ) : (
                      `₱${Number(d.value || 0).toLocaleString()}`
                    )}
                  </td>
                </tr>
              ))}
              {cashAdvanceEntries && cashAdvanceEntries.length > 0 && (
                <>
                  <tr>
                    <td colSpan={2} style={{ ...styles.td, fontWeight: 700 }}>
                      Cash Advance Details
                    </td>
                  </tr>
                  {cashAdvanceEntries.map((h, idx) => (
                    <tr
                      key={h.id}
                      style={idx % 2 === 0 ? styles.trEven : styles.trOdd}
                    >
                      <td style={styles.td}>
                        {h.created_at
                          ? new Date(h.created_at).toLocaleString()
                          : "-"}
                      </td>
                      <td style={styles.td}>₱{Number(h.amount).toFixed(2)}</td>
                    </tr>
                  ))}
                  <tr style={styles.tr}>
                    <td style={{ ...styles.td, fontWeight: 700 }}>
                      Cash Advance Total
                    </td>
                    <td style={{ ...styles.td, fontWeight: 700 }}>
                      ₱{Number(cashAdvanceTotalInPeriod || 0).toFixed(2)}
                    </td>
                  </tr>
                </>
              )}
              <tr style={styles.summaryRow}>
                <td style={styles.td}>Total Deductions</td>
                <td style={styles.td}>₱{totalDeductions.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>

          {/* Net Pay: use rounded OT pay in gross calculation */}
          <h3 style={styles.netPay}>
            Net Pay: ₱{(
              Number(
                payroll.net ??
                  (Math.round(
                    ((standardPayAmount ?? 0) +
                      otPay +
                      totalHolidayPay -
                      totalDeductions) *
                      100,
                  ) / 100),
              )
            ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </h3>
        </div>

        {/* ✅ BUTTONS OUTSIDE PDF */}
        <div style={styles.buttonContainer}>
          {showPrintButton && (
            <button
              onClick={handlePdf}
              style={{ ...styles.button, ...styles.buttonPrimary }}
            >
              <Icon
                as={FiPrinter}
                style={{ marginRight: 8, color: "#ffff" }}
                ariaLabel="Print PDF"
              />
              PDF
            </button>
          )}
          <button
            onClick={onClose}
            style={{ ...styles.button, ...styles.buttonSecondary }}
          >
            <Icon as={FiX} style={{ marginRight: 8 }} ariaLabel="Close" />
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
