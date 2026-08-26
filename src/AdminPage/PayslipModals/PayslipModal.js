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
import { hasHolidayPayEligibility } from "../../utils/holidayPayEligibility";

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
          regular: Number(data.regular_holiday_rate ?? data.holiday_rate ?? 100),
          special: Number(data.special_holiday_rate ?? 30),
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

  // Safe date formatter to YYYY-MM-DD that never throws RangeError
  function safeFormatYMD(val) {
    if (!val) return "";
    if (typeof val === "string") {
      const trimmed = val.trim();
      const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (slash) {
        const mm = slash[1].padStart(2, "0");
        const dd = slash[2].padStart(2, "0");
        return `${slash[3]}-${mm}-${dd}`;
      }
    }
    try {
      const d = val instanceof Date ? val : new Date(val);
      if (!isNaN(d.getTime())) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      }
    } catch (e) {}
    return "";
  }

  // Calculate absent days in the 15-day period
  // Get the period start and end from the period string (e.g. 2024-03-01_to_2024-03-15)
  let absentDates = [];
  if (period) {
    const todayStr = safeFormatYMD(new Date());
    let startDate = null;
    let endDate = null;

    if (typeof period === "string" && period.includes("_to_")) {
      const [start, end] = period.split("_to_");
      startDate = new Date(start);
      endDate = new Date(end);
    } else if (typeof period === "string") {
      const matches = Array.from(period.matchAll(/(\d{4}[-/]\d{2}[-/]\d{2})/g)).map((m) => m[1]);
      if (matches.length >= 2) {
        startDate = new Date(matches[0]);
        endDate = new Date(matches[1]);
      } else if (matches.length === 1) {
        startDate = new Date(matches[0]);
        endDate = new Date(matches[0]);
      }
    }

    if (startDate && endDate && !isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
      // Build a set of holiday ISO dates for this period (if any)
      const holidaySet = new Set(
        (holidayDetails || [])
          .map((h) => {
            const raw = h && (h.date || h.holiday_date || h.holiday);
            return safeFormatYMD(raw);
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
        const dateStr = safeFormatYMD(d);
        if (!dateStr) continue;
        // Skip if this date is a holiday in the fetched holidayDetails
        if (holidaySet.has(dateStr)) continue;
        allDates.push(dateStr);
      }

      // Build a lookup by date for detailed attendance
      const attendanceByDate = {};
      (detailedAttendance || []).forEach((a) => {
        const dt = safeFormatYMD(a?.date || a?.device_time);
        if (dt) {
          attendanceByDate[dt] = a;
        }
      });

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
  }
  const absentCount = absentDates.length;

  // Calculate holiday pay for each holiday (accurate for payroll period)
  let holidayPayDetails = [];
  let totalHolidayPay = 0;

  if (!loadingHoliday && holidayDetails.length > 0) {
    holidayPayDetails = holidayDetails
      .map((h) => {
        if (
          !hasHolidayPayEligibility(
            (detailedAttendance || []).map((a) => ({ date: a.date })),
            h.date,
          )
        ) {
          return null;
        }
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
  const adjustedGrossPay =
    Math.round((standardPayAmount + otPay + totalHolidayPay) * 100) / 100;
  const adjustedNetPay =
    Math.round((adjustedGrossPay - totalDeductions) * 100) / 100;

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

  return (
    <div className="fixed inset-0 w-full h-full bg-black/50 flex justify-center items-center z-[1000] backdrop-blur-[4px] payslip-modal-wrapper">
      <div className="bg-white text-gray-800 p-8 rounded-[28px] max-w-[900px] w-[95%] overflow-y-auto max-h-[90%] shadow-[0_20px_40px_rgba(0,0,0,0.2)] border border-gray-200 font-sans">
        {/* ✅ PDF ONLY CONTENT */}
        <div className="payslip-modal-content-inner">
          <h2 className="text-[2rem] font-bold text-[#237227] text-center m-0 mb-2">Payslip</h2>
          <p className="text-center text-gray-500 mb-8 text-base">
            {person.name} • {person.department} • ID: {person.id}
          </p>
          {period && (
            <p className="text-center text-[#237227] font-semibold mb-2">
              Period: {formatPeriod(period)}
            </p>
          )}
          {released && (
            <p className="text-center text-[#237227] font-bold text-[1.1rem] mb-2">
              Payslip Released
            </p>
          )}

          {/* Holiday Table */}
          {!loadingHoliday && holidayPayDetails.length > 0 && (
            <>
              <h3 className="text-[1.4rem] font-semibold text-gray-800 mt-8 mb-4 border-b-2 border-[#237227] pb-2">
                <Icon
                  as={FiCalendar}
                  style={{ marginRight: 8 }}
                  ariaLabel="Holidays"
                />
                Holidays This Month
              </h3>
              <table className="w-full border-collapse mb-6 text-[0.95rem]">
                <thead>
                  <tr>
                    <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Date</th>
                    <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Type</th>
                    <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Rate (%)</th>
                    {/* <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Amount</th> */}
                  </tr>
                </thead>
                <tbody>
                  {holidayPayDetails.map((h, i) => (
                    <tr key={h.date + h.type} className={i % 2 === 0 ? "bg-gray-50" : "bg-white"}>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{h.date}</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        {h.type === "regular"
                          ? "Regular Holiday"
                          : "Special Holiday"}
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{h.ratePercent}</td>
                      {/* <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">₱{h.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td> */}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* Attendance Table */}
          <h3 className="text-[1.4rem] font-semibold text-gray-800 mt-8 mb-4 border-b-2 border-[#237227] pb-2">
            <Icon
              as={FiClipboard}
              style={{ marginRight: 8 }}
              ariaLabel="Attendance"
            />
            Attendance Details
          </h3>

          <table className="w-full border-collapse mb-6 text-[0.95rem]">
            <thead>
              <tr>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Date</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Morning In</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Afternoon Out</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">OT</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Late Count</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Late Details</th>
                {/* Removed unused OT (hrs) column */}
              </tr>
            </thead>
            <tbody>
              {detailedAttendance.length ? (
                detailedAttendance.map((rec, i) => {
                  const trClass = i % 2 === 0 ? "bg-gray-50" : "bg-white";

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
                    <tr key={i} className={trClass}>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{rec.date}</td>
                      <td className={`py-2.5 px-2 border-b border-gray-200 ${rec.morningInStatus === 'late' ? 'text-red-500' : 'text-gray-800'}`}>
                        {morningInDisplay}
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{afternoonOutDisplay}</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        {getHourMinute(recOtHours)} ({recOtHours.toFixed(2)})
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{rec.lateCount || 0}</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        {rec.lateDetails && rec.lateDetails.length ? (
                          <ul className="m-0 pl-4">
                            {rec.lateDetails.map((d, idx) => (
                              <li key={idx} className="text-red-500">
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
                    className="py-2.5 px-2 border-b border-gray-200 text-center text-gray-400"
                  >
                    No attendance records
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h3 className="text-[1.4rem] font-semibold text-gray-800 mt-8 mb-4 border-b-2 border-[#237227] pb-2">
            <Icon as={FiX} style={{ marginRight: 8 }} ariaLabel="Absent days" />
            Absent Days in Period
          </h3>
          <table className="w-full border-collapse mb-6 text-[0.95rem]">
            <thead>
              <tr>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Absent Day</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Missing Session</th>
              </tr>
            </thead>
            <tbody>
              {absentCount > 0 ? (
                absentDates.map((item, idx) => (
                  <tr
                    key={item.date}
                    className={idx % 2 === 0 ? "bg-gray-50" : "bg-white"}
                  >
                    <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                      {formatDateWithWeekday(item.date)}
                    </td>
                    <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{item.missing}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={2}
                    className="py-2.5 px-2 border-b border-gray-200 text-center text-[#237227]"
                  >
                    No absences in this period
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {/* Late Records */}
          <h3 className="text-[1.4rem] font-semibold text-gray-800 mt-8 mb-4 border-b-2 border-[#237227] pb-2">
            <Icon
              as={FiClock}
              style={{ marginRight: 8 }}
              ariaLabel="Late records"
            />
            All Late Records
          </h3>
          <table className="w-full border-collapse mb-6 text-[0.95rem]">
            <thead>
              <tr>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Date</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Session</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Time</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Status</th>
              </tr>
            </thead>
            <tbody>
              {allLateDetails.length ? (
                allLateDetails.map((d, i) => {
                  const trClass = i % 2 === 0 ? "bg-gray-50" : "bg-white";
                  return (
                    <tr key={i} className={trClass}>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{d.date}</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{d.session}</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{d.time}</td>
                      <td className={`py-2.5 px-2 border-b border-gray-200 ${d.status === 'late' ? 'text-red-500' : 'text-gray-800'}`}>
                        {d.status}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan="4"
                    className="py-2.5 px-2 border-b border-gray-200 text-center text-gray-400"
                  >
                    No late records
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Earnings */}

          <h3 className="text-[1.4rem] font-semibold text-gray-800 mt-8 mb-4 border-b-2 border-[#237227] pb-2">
            <span
              aria-label="Peso"
              className="mr-2 text-lg font-bold"
            >
              ₱
            </span>
            Earnings
          </h3>
          <table className="w-full border-collapse mb-6 text-[0.95rem]">
            <thead>
              <tr>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Type</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Days/Hours</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Rate</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-gray-50">
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">Standard Pay</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{daysWorkedDisplay}</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                  ₱{(payroll.dailyRate ?? 0).toFixed(2)}
                </td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                  ₱
                  {standardPayAmount.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                  })}
                </td>
              </tr>
              <tr className="bg-white">
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">Overtime Pay</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{getHourMinute(otHours)}</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                  (Daily Rate) ÷ 8hrs =₱{hourlyRate.toFixed(2)}
                </td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">₱{otPay.toFixed(2)}</td>
              </tr>
              {/* ✅ Holiday Pay */}
              {holidayPayDetails.length > 0 ? (
                <>
                  {holidayPayDetails.map((h, idx) => (
                    <tr
                      key={idx}
                      className={idx % 2 === 0 ? "bg-gray-50" : "bg-white"}
                    >
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">Holiday Pay</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        {h.date} (
                        {h.type === "regular"
                          ? "Regular Holiday"
                          : "Special Holiday"}
                        )
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        <span className="text-[#237227] font-semibold">
                          {" "}
                          ({h.ratePercent}%)
                        </span>
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        ₱{(h.amount ?? 0).toLocaleString()}
                      </td>
                    </tr>
                  ))}

                  <tr className="bg-gray-100 font-semibold">
                    <td colSpan="3" className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                      Total Holiday Pay
                    </td>
                    <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                      ₱{totalHolidayPay.toLocaleString()}
                    </td>
                  </tr>
                </>
              ) : (
                <tr>
                  <td
                    colSpan="4"
                    className="py-2.5 px-2 border-b border-gray-200 text-center text-gray-400"
                  >
                    No holiday pay for this period
                  </td>
                </tr>
              )}
              <tr className="bg-gray-100 font-semibold">
                <td colSpan="3" className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                  Gross Pay
                </td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                  ₱{adjustedGrossPay.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </td>
              </tr>
            </tbody>
          </table>

          {/* Deductions */}
          <h3 className="text-[1.4rem] font-semibold text-gray-800 mt-8 mb-4 border-b-2 border-[#237227] pb-2">
            <Icon
              as={FiTrendingDown}
              style={{ marginRight: 8 }}
              ariaLabel="Deductions"
            />
            Deductions
          </h3>
          <table className="w-full border-collapse mb-6 text-[0.95rem]">
            <tbody>
              <tr className="bg-gray-50">
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">Total Late Occurrences</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{totalLateOccurrences} occurrence(s)</td>
              </tr>
              <tr className="bg-white">
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">Late Count</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{payroll.lateCount} occurrence(s)</td>
              </tr>
              <tr className="bg-gray-50">
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">Late Count Limit for Deduction</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{lateCountLimit} occurrence(s)</td>
              </tr>
              <tr className="bg-white">
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">Total Late Deduction</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">₱{lateDeduction.toLocaleString()}</td>
              </tr>
              {deductions.map((d, i) => (
                <tr
                  key={d.label}
                  className={i % 2 === 0 ? "bg-gray-50" : "bg-white"}
                >
                  <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{d.label}</td>
                  <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                    {d.loading ? (
                      <span className="text-gray-500">Loading...</span>
                    ) : (
                      `₱${Number(d.value || 0).toLocaleString()}`
                    )}
                  </td>
                </tr>
              ))}
              {cashAdvanceEntries && cashAdvanceEntries.length > 0 && (
                <>
                  <tr>
                    <td colSpan={2} className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-bold">
                      Cash Advance Details
                    </td>
                  </tr>
                  {cashAdvanceEntries.map((h, idx) => (
                    <tr
                      key={h.id}
                      className={idx % 2 === 0 ? "bg-gray-50" : "bg-white"}
                    >
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        {h.created_at
                          ? new Date(h.created_at).toLocaleString()
                          : "-"}
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">₱{Number(h.amount).toFixed(2)}</td>
                    </tr>
                  ))}
                  <tr className="transition-colors duration-200">
                    <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-bold">
                      Cash Advance Total
                    </td>
                    <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-bold">
                      ₱{Number(cashAdvanceTotalInPeriod || 0).toFixed(2)}
                    </td>
                  </tr>
                </>
              )}
              <tr className="bg-gray-100 font-semibold">
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">Total Deductions</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">₱{totalDeductions.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>

          {/* Net Pay: use rounded OT pay in gross calculation */}
          <h3 className="text-right text-[1.6rem] font-bold text-[#237227] mt-4 mb-0">
            Net Pay: ₱{adjustedNetPay.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </h3>
        </div>

        {/* ✅ BUTTONS OUTSIDE PDF */}
        <div className="mt-6 flex justify-end gap-3">
          {showPrintButton && (
            <button
              onClick={handlePdf}
              className="py-2.5 px-6 rounded-lg text-[0.95rem] font-semibold border-none cursor-pointer inline-flex items-center justify-center bg-[#237227] text-white focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 shadow-none hover:shadow-none transition-none transform-none [-webkit-tap-highlight-color:transparent]"
            >
              <FiPrinter style={{ marginRight: 8, color: "#ffffff", fontSize: "1.1rem" }} />
              PDF
            </button>
          )}
          <button
            onClick={onClose}
            className="py-2.5 px-6 rounded-lg text-[0.95rem] font-semibold cursor-pointer inline-flex items-center justify-center bg-white text-gray-700 border border-gray-300 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 shadow-none hover:shadow-none transition-none transform-none [-webkit-tap-highlight-color:transparent]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}