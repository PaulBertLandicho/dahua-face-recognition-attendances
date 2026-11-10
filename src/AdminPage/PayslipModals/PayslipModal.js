import React, { useEffect, useState } from "react";
import {
  FiPrinter,
  FiCalendar,
  FiClipboard,
  FiX,
  FiClock,
  FiTrendingDown,
  FiBriefcase,
  FiCheckCircle,
} from "react-icons/fi";
import Icon from "../../components/Icon";
import { supabase } from "../../mysqlClient";
import { generatePayslipPdf } from "./generatePayslipPdf";
import { hasHolidayPayEligibility } from "../../utils/holidayPayEligibility";
import { calculateTieredLateDeduction } from "../Payroll";
import { getSavedOtStatus, saveOtStatusLocal } from "../attendanceDetails";

// detailedAttendance: [{ date, morningIn, morningOut, afternoonIn, afternoonOut, lateCount, lateDetails: [{session, time, status}]}]
export default function PayslipModal({
  payroll,
  person,
  detailedAttendance = [],
  onClose,
  showPrintButton,
  period,
  released,
  onRelease,
  onToggleWaiveEarlyIn,
  onToggleWaiveOvertime,
  onOtApprovalChange,
}) {
  // useState declarations (only once)
  const [holidayDetails, setHolidayDetails] = useState([]);
  const [deptHolidayRates, setDeptHolidayRates] = useState({
    regular: 100,
    special: 30,
  });
  const [loadingHoliday, setLoadingHoliday] = useState(true);
  const [cashAdvanceTotalInPeriod, setCashAdvanceTotalInPeriod] = useState(0);
  const [cashAdvanceEntries, setCashAdvanceEntries] = useState([]);
  const [expensesTotalInPeriod, setExpensesTotalInPeriod] = useState(0);
  const [expensesEntries, setExpensesEntries] = useState([]);
  const [otApprovalOverrides, setOtApprovalOverrides] = useState({});
  const [updatingOtDate, setUpdatingOtDate] = useState(null);
  const [openOtMenuDate, setOpenOtMenuDate] = useState(null);

  useEffect(() => {
    setOtApprovalOverrides({});
    setOpenOtMenuDate(null);
  }, [person?.id, period]);

  useEffect(() => {
    if (!openOtMenuDate) return;
    const handleOutsideClick = () => setOpenOtMenuDate(null);
    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, [openOtMenuDate]);

  const getRowOtStatus = (rec) => {
    const rawDate = rec?.date || rec?.device_time || "";
    const dStr = typeof rawDate === "string" ? rawDate.slice(0, 10) : "";
    if (dStr && otApprovalOverrides[dStr]) {
      return otApprovalOverrides[dStr];
    }
    if (dStr && otApprovalOverrides[dStr]) {
      return otApprovalOverrides[dStr];
    }
    if (person?.id && dStr) {
      const saved = getSavedOtStatus(person.id, dStr);
      if (saved === "approved" || saved === "denied" || saved === "pending") {
        return saved;
      }
    }
    return rec?.otApprovalStatus || "pending";
  };


  const handleOtApproval = async (rec, newStatus) => {
    if (!rec || !rec.date || released) return;
    const dStr = String(rec.date).slice(0, 10);
    if (person?.id && dStr) {
      saveOtStatusLocal(person.id, dStr, newStatus);
    }
    setOtApprovalOverrides((prev) => ({ ...prev, [dStr]: newStatus }));
    const ids = Array.isArray(rec.recordIds) ? rec.recordIds.filter(Boolean) : [];
    if (typeof onOtApprovalChange === "function") {
      onOtApprovalChange({
        personId: person?.id,
        date: dStr,
        recordIds: ids,
        status: newStatus,
      });
    }
    setUpdatingOtDate(dStr);
    try {
      const ids = Array.isArray(rec.recordIds) ? rec.recordIds.filter(Boolean) : [];
      if (ids.length > 0) {
        await supabase
          .from("attendance")
          .update({ ot_status: newStatus })
          .in("id", ids);
      } else if (person?.id && dStr) {
        await supabase
          .from("attendance")
          .update({ ot_status: newStatus })
          .eq("person_id", person.id)
          .eq("attendance_work_date", dStr);
      }
      if (typeof onOtApprovalChange === "function") {
        onOtApprovalChange({
          personId: person.id,
          date: dStr,
          recordIds: ids,
          status: newStatus,
        });
      }
    } catch (err) {
      console.error("Failed to update OT approval status:", err);
    } finally {
      setUpdatingOtDate(null);
    }
  };

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
          regular: Number(data.regular_holiday_rate) || Number(data.holiday_rate) || 100,
          special: Number(data.special_holiday_rate) || 30,
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
        // Fetch holidays within the period, then match global (department is null/empty) or person's department
        const { data: holidays, error } = await supabase
          .from("holidays")
          .select("*")
          .gte("date", start)
          .lte("date", end);
        if (error) throw error;
        const personDept = String(person.department || "").toLowerCase().trim();
        const filtered = (holidays || []).filter((h) => {
          const hDept = String(h.department || "").toLowerCase().trim();
          return !hDept || hDept === personDept;
        });
        // Sort by date
        const all = filtered.sort((a, b) =>
          String(a.date || "").localeCompare(String(b.date || "")),
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

  // Fetch total expenses for this person within the payroll period
  const fetchExpensesTotal = async () => {
    if (!person?.id || !period) {
      setExpensesTotalInPeriod(0);
      setExpensesEntries([]);
      return;
    }

    try {
      const [start, end] = period.split("_to_");
      const { data, error } = await supabase
        .from("expenses")
        .select("id, person_id, period, item_name, amount, expense_date, note, created_at")
        .eq("person_id", person.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const allExpenses = data || [];
      const periodExpenses = allExpenses.filter((e) => {
        if (e.period && e.period === period) return true;
        const eDate = e.expense_date || (e.created_at ? e.created_at.slice(0, 10) : null);
        if (eDate && start && end && eDate >= start && eDate <= end) return true;
        return false;
      });
      const total = periodExpenses.reduce((s, r) => s + Number(r.amount || 0), 0);
      setExpensesEntries(periodExpenses);
      setExpensesTotalInPeriod(Math.round(total * 100) / 100);
    } catch (err) {
      console.error("Error fetching expenses total:", err);
      setExpensesTotalInPeriod(0);
      setExpensesEntries([]);
    }
  };

  useEffect(() => {
    fetchExpensesTotal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person, period]);

  const handlePdf = async () => {
    const grossPay =
      Math.round((standardPayAmount + otPay + totalHolidayPay) * 100) / 100;
    // compute total OT hours for the period to include in PDF (decimal hours)
    let totalOtMinutesForPdf = 0;
    try {
      const sched = payroll && payroll.settings ? payroll.settings : {};
      const schedMorningStart = parseTimeToMinutes(sched.morning_start || "08:00") || 480;
      const schedAfternoonEnd = sched.afternoon_end || "17:00";
      const schedAfternoonGrace = Number.isFinite(Number(sched.afternoon_grace_minutes))
        ? Number(sched.afternoon_grace_minutes)
        : 0;
      (detailedAttendance || []).forEach((rec) => {
        try {
          if (getRowOtStatus(rec) !== "approved") return;
          const mIn = parseTimeToMinutes(rec.morningIn || rec.attendanceIn);
          const aOut = parseTimeToMinutes(rec.afternoonOut || rec.morningOut || rec.attendanceOut);
          const aEnd = parseTimeToMinutes(schedAfternoonEnd);

          // Early-in computation: 03:00 AM - 07:30 AM only added to OT
          if (
            typeof mIn === "number" &&
            mIn >= 3 * 60 &&
            mIn <= 7 * 60 + 30 &&
            mIn < schedMorningStart
          ) {
            totalOtMinutesForPdf += schedMorningStart - mIn;
          }

          if (
            typeof aOut === "number" &&
            typeof aEnd === "number"
          ) {
            const effectiveAOut = aOut < 3 * 60 ? aOut + 24 * 60 : aOut;
            if (effectiveAOut > aEnd && effectiveAOut - aEnd > schedAfternoonGrace) {
              totalOtMinutesForPdf += effectiveAOut - aEnd;
            }
          }
        } catch (e) {}
      });
    } catch (e) {}
    const totalOtHoursForPdf = totalOtMinutesForPdf / 60;
    // ensure payroll.otHours is available for older code paths
    try {
      payroll.otHours = Math.round(totalOtHoursForPdf * 100) / 100;
    } catch (e) {}
    const totalLateMinutes = (allLateDetails || []).reduce(
      (sum, item) => sum + (Number(item.minutesLate) || 0),
      0
    );

    await generatePayslipPdf({
      payroll,
      person,
      period,
      holidayPayDetails,
      totalHolidayPay,
      absentCount,
      lateDeduction,
      lateMinutes: totalLateMinutes,
      totalDeductions: computedDeductionsSum,
      daysWorked,
      standardPayAmount,
      otPay,
      otHours: totalOtHoursForPdf,
      gross: grossPay,
      cashAdvanceEntries,
      cashAdvanceTotalInPeriod,
      expensesEntries,
      expensesTotalInPeriod,
    });
  };

  // Helper to display hours and minutes
  const getHourMinute = (hours) => {
    if (!hours || hours <= 0) return "N/A";
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

  // Settings for shift time-in/time-out
  const settings = payroll && payroll.settings ? payroll.settings : {};
  const morningStart = settings.morning_start || "08:00";
  const morningEnd = settings.morning_end || "12:00";
  const afternoonStart = settings.afternoon_start || "13:00";
  const afternoonEnd = settings.afternoon_end || "17:00";

  // Helper to check if it's not yet time for time-in/time-out
  function isNotYetTime(session, dateStr, type) {
    if (!dateStr) return false;
    const now = new Date();
    const todayFormatted = safeFormatYMD(now);
    const dateFormatted = safeFormatYMD(dateStr);
    if (dateFormatted < todayFormatted) {
      return false;
    }
    if (dateFormatted > todayFormatted) {
      return true;
    }
    let sessionTime;
    if (session === "morning") {
      sessionTime = type === "in" ? morningStart : morningEnd;
    } else {
      sessionTime = type === "in" ? afternoonStart : afternoonEnd;
    }
    const [h, m] = String(sessionTime).split(":").map(Number);
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 0, m || 0, 0, 0);
    return now < target;
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

      // For each date in the period (weekdays only) that is on or before today, determine missing sessions
      absentDates = allDates
        .filter((dateStr) => dateStr <= todayStr)
        .map((dateStr) => {
          const morningEnded = dateStr < todayStr || !isNotYetTime("morning", dateStr, "out");
          const afternoonEnded = dateStr < todayStr || !isNotYetTime("afternoon", dateStr, "out");

          // If neither session has ended yet (e.g. earlier today before morning cutoff), don't mark anything absent yet
          if (!morningEnded && !afternoonEnded) return null;

          const rec = attendanceByDate[dateStr] || null;

          const hasMorning = Boolean(
            rec && (
              (rec.morningIn && rec.morningIn !== "-" && rec.morningIn !== "Not time-in") ||
              (rec.morningOut && rec.morningOut !== "-")
            )
          );

          const hasAfternoon = Boolean(
            rec && (
              (rec.afternoonOut && rec.afternoonOut !== "-" && rec.afternoonOut !== "Not time-out" && !String(rec.afternoonOut).includes("Missing")) ||
              (rec.afternoonIn && rec.afternoonIn !== "-")
            )
          );

          if (expectsMorningOnly) {
            if (morningEnded && !hasMorning) return { date: dateStr, missing: "Morning" };
            return null;
          }
          if (expectsAfternoonOnly) {
            if (afternoonEnded && !hasAfternoon) return { date: dateStr, missing: "Afternoon" };
            return null;
          }
          if (expectsSingleSession) {
            // half-day staff: missing if neither session present after the workday has ended
            if (afternoonEnded && !hasMorning && !hasAfternoon)
              return { date: dateStr, missing: "Session" };
            return null;
          }

          // Default 2-session expectation
          if (morningEnded && afternoonEnded) {
            if (!hasMorning && !hasAfternoon)
              return { date: dateStr, missing: "Whole Day" };
            if (!hasMorning) return { date: dateStr, missing: "Morning" };
            if (!hasAfternoon) return { date: dateStr, missing: "Afternoon" };
            return null;
          }

          // If morning has ended but afternoon has not ended yet
          if (morningEnded && !afternoonEnded) {
            if (!hasMorning) return { date: dateStr, missing: "Morning" };
            return null;
          }

          return null;
        })
        .filter(Boolean);
    }
  }
  const absentCount = absentDates.length;

  // Organize and list all dates of the Payroll Cutoff Period in sequential order (e.g. 2026-09-14, 2026-09-15)
  const organizedAttendance = (() => {
    const mapByDate = {};
    (detailedAttendance || []).forEach((item) => {
      const dStr = safeFormatYMD(item?.date || item?.device_time);
      if (dStr) {
        mapByDate[dStr] = item;
      }
    });

    if (typeof period === "string") {
      let startDateVal = null;
      let endDateVal = null;
      if (period.includes("_to_")) {
        const [start, end] = period.split("_to_");
        startDateVal = new Date(start);
        endDateVal = new Date(end);
      } else {
        const matches = Array.from(
          period.matchAll(/(\d{4}[-/]\d{2}[-/]\d{2})/g),
        ).map((m) => m[1]);
        if (matches.length >= 2) {
          startDateVal = new Date(matches[0]);
          endDateVal = new Date(matches[1]);
        }
      }

      if (
        startDateVal &&
        endDateVal &&
        !isNaN(startDateVal.getTime()) &&
        !isNaN(endDateVal.getTime())
      ) {
        const periodDatesList = [];
        for (
          let cur = new Date(startDateVal);
          cur <= endDateVal;
          cur.setDate(cur.getDate() + 1)
        ) {
          const curDateStr = safeFormatYMD(cur);
          if (!curDateStr) continue;

          // Exclude Saturday (6) and Sunday (0) if there is NO attendance record on that day
          const dayOfWeek = cur.getDay();
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
          if (isWeekend && !mapByDate[curDateStr]) {
            continue;
          }

          if (mapByDate[curDateStr]) {
            periodDatesList.push({
              ...mapByDate[curDateStr],
              date: curDateStr,
            });
          } else {
            periodDatesList.push({
              date: curDateStr,
              attendanceIn: null,
              attendanceOut: null,
              morningIn: null,
              afternoonOut: null,
              morningInStatus: null,
              lateCount: 0,
              lateDetails: [],
              status: "absent",
              otHours: 0,
            });
          }
        }
        return periodDatesList.sort((a, b) => a.date.localeCompare(b.date));
      }
    }

    return [...(detailedAttendance || [])].sort((a, b) =>
      String(a.date || "").localeCompare(String(b.date || "")),
    );
  })();

  // Calculate holiday pay for each holiday (accurate for payroll period)
  let holidayPayDetails = [];
  let totalHolidayPay = 0;

  if (!loadingHoliday && holidayDetails.length > 0) {
    const baseRateForHoliday = Number(payroll.dailyRate ?? person.daily_rate ?? 0);
    holidayPayDetails = holidayDetails
      .map((h) => {
        const hDate = safeFormatYMD(h.date || h.holiday_date);
        if (
          !hDate ||
          !hasHolidayPayEligibility(detailedAttendance || [], hDate)
        ) {
          return null;
        }
        let ratePercent = 0;
        const hType = String(h.type || "regular").toLowerCase().trim();
        if (hType === "regular") {
          ratePercent = Number(deptHolidayRates.regular) || 100;
        } else if (hType === "special") {
          ratePercent = Number(deptHolidayRates.special) || 30;
        }
        if (!ratePercent) return null;
        const amount =
          Math.round(((baseRateForHoliday * ratePercent) / 100) * 100) / 100;
        totalHolidayPay = Math.round((totalHolidayPay + amount) * 100) / 100;
        return {
          date: hDate,
          type: hType,
          description: h.description || h.name || "",
          rate: baseRateForHoliday,
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
    let totalAttendedDays = 0;
    detailedAttendance.forEach((rec) => {
      const hasMorning = Boolean(
        (rec.morningIn && rec.morningIn !== "-" && rec.morningIn !== "Not time-in") ||
        (rec.morningOut && rec.morningOut !== "-")
      );
      const hasAfternoon = Boolean(
        (rec.afternoonOut && rec.afternoonOut !== "-" && rec.afternoonOut !== "Not time-out" && !String(rec.afternoonOut).includes("Missing")) ||
        (rec.afternoonIn && rec.afternoonIn !== "-")
      );
      if (hasMorning && hasAfternoon) {
        totalAttendedDays += 1;
      } else if (hasMorning || hasAfternoon) {
        totalAttendedDays += 0.5;
      }
    });
    daysWorked = totalAttendedDays;
    daysWorkedDisplay = `${daysWorked} day(s)`;
  } else {
    daysWorked = Number(payroll?.daysPresent ?? payroll?.days_present ?? 0) || 0;
    daysWorkedDisplay = `${daysWorked} day(s)`;
  }

  // Standard Pay calculation
  const standardPayAmount =
    Math.round(daysWorked * (payroll.dailyRate ?? 0) * 100) / 100;

  // Overtime calculation: includes 1.25x OT rate & Night Shift Differential (past 10:00 PM) when enabled
  const baseHourlyRate = Math.round(((payroll.dailyRate ?? 0) / 8) * 100) / 100;
  const hasNsdEnabled = person.night_shift_diff !== 0;
  let dynamicOtMinutes = 0;
  let dynamicNsdMinutes = 0;

  if (detailedAttendance && detailedAttendance.length) {
    const schedMorningStart = (settings && settings.morning_start) || "08:00";
    const schedAfternoonEnd = (settings && settings.afternoon_end) || "17:00";
    const schedAfternoonGrace = Number.isFinite(Number(settings && settings.afternoon_grace_minutes))
      ? Number(settings.afternoon_grace_minutes)
      : 0;
    const schedMorningStartMin = parseTimeToMinutes(schedMorningStart) || 480;
    const schedAfternoonEndMin = parseTimeToMinutes(schedAfternoonEnd);

    detailedAttendance.forEach((rec) => {
      if (getRowOtStatus(rec) !== "approved") return;
      const mIn = parseTimeToMinutes(rec.attendanceIn || rec.morningIn);
      const aOut = parseTimeToMinutes(rec.attendanceOut || rec.afternoonOut || rec.morningOut);
      // Early-in computation: 03:00 AM - 07:00 AM only added to OT
      if (
        typeof mIn === "number" &&
        mIn >= 3 * 60 &&
        mIn <= 7 * 60 + 30 &&
        mIn < schedMorningStartMin
      ) {
        dynamicOtMinutes += schedMorningStartMin - mIn;
      }
      if (typeof aOut === "number" && typeof schedAfternoonEndMin === "number") {
        const effectiveAOut = aOut < 3 * 60 ? aOut + 24 * 60 : aOut;
        if (effectiveAOut > schedAfternoonEndMin) {
          const mins = effectiveAOut - schedAfternoonEndMin;
          if (mins > schedAfternoonGrace) {
            dynamicOtMinutes += mins;
            // Night shift differential (work past 22:00 = 10:00 PM)
            if (hasNsdEnabled && effectiveAOut > 22 * 60) {
              dynamicNsdMinutes += Math.min(effectiveAOut - 22 * 60, mins);
            }
          }
        }
      }
    });
  }

  const manualNsd = Number(person.night_shift_diff || 0);
  const otHours = detailedAttendance && detailedAttendance.length
    ? dynamicOtMinutes / 60
    : Number(payroll.otHours ?? 0);
  const nsdHours =
    manualNsd > 0 && dynamicNsdMinutes === 0
      ? manualNsd
      : detailedAttendance && detailedAttendance.length
      ? Math.max(dynamicNsdMinutes / 60, manualNsd)
      : Number(payroll.nsdHours ?? manualNsd ?? 0);

  const otMultiplier = 1;
  const nsdMultiplier = 0.10;
  const standardOtPay = Math.round(baseHourlyRate * otMultiplier * otHours * 100) / 100;
  const nsdPay = 0;
  const otPay = Math.round((standardOtPay + nsdPay) * 100) / 100;
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
  const baseDailyRate = Number(payroll.dailyRate ?? person.daily_rate ?? 0);
  const lateDeduction =
    payroll.totalLateDeduction ??
    payroll.total_late_deduction ??
    (payroll.lateCount >= lateCountLimit ? payroll.lateCount * latePenalty : 0);
  const computedDeductionsSum =
    lateDeduction + deductions.reduce((acc, d) => acc + d.value, 0) +
    Number(cashAdvanceTotalInPeriod || 0) +
    Number(expensesTotalInPeriod || 0);
  const totalDeductions =
    Math.round(computedDeductionsSum * 100) / 100;
  const adjustedGrossPay =
    Math.round((standardPayAmount + otPay + totalHolidayPay) * 100) / 100;
  const adjustedNetPay =
    Math.max(0, Math.round((adjustedGrossPay - totalDeductions) * 100) / 100);



  const allLateDetails = detailedAttendance
    .map((rec) =>
      rec.lateDetails
        ? rec.lateDetails.map((ld) => ({ date: rec.date, ...ld }))
        : [],
    )
    .flat();

  return (
    <div className="fixed inset-0 w-full h-full bg-black/50 flex justify-center items-center z-[1000] backdrop-blur-[4px] payslip-modal-wrapper">
      <div className="bg-white text-gray-800 p-8 rounded-[28px] max-w-[1180px] w-[96%] overflow-y-auto max-h-[90%] shadow-[0_20px_40px_rgba(0,0,0,0.2)] border border-gray-200 font-sans">
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
                    <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Holiday / Remarks</th>
                    <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Type</th>
                    <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Rate (%)</th>
                    <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Holiday Pay</th>
                  </tr>
                </thead>
                <tbody>
                  {holidayPayDetails.map((h, i) => (
                    <tr key={h.date + h.type} className={i % 2 === 0 ? "bg-gray-50" : "bg-white"}>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-mono text-sm font-semibold">{h.date}</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-medium">{h.description || "N/A"}</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        {h.type === "regular" ? (
                          <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-[#237227]">
                            Regular Holiday
                          </span>
                        ) : (
                          <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">
                            Special Holiday
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{h.ratePercent}%</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-[#237227] font-semibold">
                        ₱{h.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
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

          <div className="overflow-x-auto mb-6">
            <table className="w-full border-collapse text-[0.95rem]">
              <thead>
                <tr>
                  <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Date</th>
                  <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Time In</th>
                  <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Time Out</th>
                  <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">OT</th>
                  <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Late Count</th>
                  <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide whitespace-nowrap">Late Details</th>
                  <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Daily Rate</th>
                  <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Late Deduct</th>
                  <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide min-w-[210px]">Computed OT</th>
                </tr>
              </thead>
              <tbody>
                {organizedAttendance.length ? (
                  organizedAttendance.map((rec, i) => {
                    const trClass = i % 2 === 0 ? "bg-gray-50" : "bg-white";

                    const recDayOfWeek = rec.date ? new Date(rec.date).getDay() : -1;
                    const isWeekend = recDayOfWeek === 0 || recDayOfWeek === 6;
                    const isHolidayDate = holidayDetails.some(
                      (h) => safeFormatYMD(h.date || h.holiday_date) === rec.date,
                    );

                    // Attendance In (1st attempt of attendance)
                    let attendanceInDisplay = "N/A";
                    const inTime = rec.attendanceIn || rec.morningIn;
                    if (inTime) {
                      attendanceInDisplay = inTime;
                    } else if (isWeekend) {
                      attendanceInDisplay = "- (Rest Day)";
                    } else if (isHolidayDate) {
                      attendanceInDisplay = "- (Holiday)";
                    } else if (!isNotYetTime("morning", rec.date, "in")) {
                      attendanceInDisplay = "Not time-in";
                    }

                    // Attendance Out (2nd / last attempt of attendance)
                    let attendanceOutDisplay = "N/A";
                    const outTime = rec.attendanceOut || rec.afternoonOut || rec.morningOut;
                    if (outTime) {
                      attendanceOutDisplay = outTime;
                    } else if (isWeekend || isHolidayDate) {
                      attendanceOutDisplay = "-";
                    } else if (!isNotYetTime("afternoon", rec.date, "out")) {
                      attendanceOutDisplay = "Not time-out";
                    }

                    // Compute per-row overtime (minutes) by comparing afternoon out time to scheduled afternoon end time.
                    // Also compute Early In (3:00 AM - 7:00 AM) and Early Out (< 17:00).
                    let otMinutes = 0;
                    let earlyInHoursForRow = 0;
                    let isEarlyOutForRow = false;
                    let canManageOtForRow = false;
                    try {
                      const scheduledMorningStart =
                        (settings && settings.morning_start) || "08:00";
                      const scheduledAfternoonEnd =
                        (settings && settings.afternoon_end) || "17:00";
                      const schedAfternoonGrace = Number.isFinite(
                        Number(settings && settings.afternoon_grace_minutes),
                      )
                        ? Number(settings.afternoon_grace_minutes)
                        : 0;
                      const schedMorningStartMin =
                        parseTimeToMinutes(scheduledMorningStart) || 480;
                      const morningInMin = parseTimeToMinutes(
                        rec.attendanceIn || rec.morningIn,
                      );
                      const afternoonOutMin = parseTimeToMinutes(
                        rec.attendanceOut || rec.afternoonOut || rec.morningOut,
                      );
                      const schedAfternoonEndMin = parseTimeToMinutes(
                        scheduledAfternoonEnd,
                      );

                      // Early In (03:00 AM to 07:00 AM only) - computed and added to Afternoon OT
                      if (
                        typeof morningInMin === "number" &&
                        morningInMin >= 3 * 60 &&
                        morningInMin <= 7 * 60 + 30 &&
                        morningInMin < schedMorningStartMin
                      ) {
                        const earlyMins = schedMorningStartMin - morningInMin;
                        otMinutes += earlyMins;
                        earlyInHoursForRow = earlyMins / 60;
                      }

                      if (
                        typeof afternoonOutMin === "number" &&
                        typeof schedAfternoonEndMin === "number"
                      ) {
                        const effectiveAfternoonOutMin = afternoonOutMin < 3 * 60 ? afternoonOutMin + 24 * 60 : afternoonOutMin;
                        if (effectiveAfternoonOutMin >= 17 * 60 + 30) {
                          canManageOtForRow = true;
                        }
                        if (effectiveAfternoonOutMin > schedAfternoonEndMin) {
                          const mins = effectiveAfternoonOutMin - schedAfternoonEndMin;
                          if (mins > schedAfternoonGrace) {
                            otMinutes += mins;
                          }
                        } else if (effectiveAfternoonOutMin < schedAfternoonEndMin) {
                          isEarlyOutForRow = true;
                        }
                      }
                    } catch (e) {
                      otMinutes = 0;
                    }

                    const recOtHours = otMinutes / 60;
                    const rowOtStatus = getRowOtStatus(rec);


                    // Daily Salary and Late Deduction calculations
                    const baseDailyRate = Number(payroll.dailyRate ?? person.daily_rate ?? 0);
                    const hourlyRateForDaily = Math.round((baseDailyRate / 8) * 100) / 100;
                    const hasMorningPunch = Boolean(
                      (rec.morningIn && rec.morningIn !== "-" && rec.morningIn !== "N/A" && rec.morningIn !== "Not time-in") ||
                      (rec.morningOut && rec.morningOut !== "-" && rec.morningOut !== "N/A")
                    );
                    const hasAfternoonPunch = Boolean(
                      (rec.afternoonOut && rec.afternoonOut !== "-" && rec.afternoonOut !== "N/A" && rec.afternoonOut !== "Not time-out" && !String(rec.afternoonOut).includes("Missing")) ||
                      (rec.afternoonIn && rec.afternoonIn !== "-" && rec.afternoonIn !== "N/A")
                    );

                    let dayFraction = 0;
                    if (hasMorningPunch && hasAfternoonPunch) {
                      dayFraction = 1.0;
                    } else if (hasMorningPunch || hasAfternoonPunch) {
                      dayFraction = 0.5;
                    }
                    const dayBaseSalary = Math.round(baseDailyRate * dayFraction * 100) / 100;


                    const isOtApproved = rowOtStatus === "approved";
                    const isOtDenied = rowOtStatus === "denied" || rowOtStatus === "waived";
                    const potentialDayOtPay = Math.round(recOtHours * hourlyRateForDaily * 100) / 100;
                    const dayOtPay = isOtApproved ? potentialDayOtPay : 0;
                    const dayLateItems = rec.lateDetails || [];
                    const dayLateCalc = calculateTieredLateDeduction(
                      dayLateItems,
                      baseDailyRate,
                      latePenalty,
                      payroll.settings || {}
                    );
                    const dayLateDeduction = dayLateCalc.totalLateDeduction;
                    const matchedHolidayPay = holidayPayDetails.find(
                      (hp) => hp.date === rec.date && hp.type !== "restday",
                    );

                    return (
                      <tr key={i} className={trClass}>
                        <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-mono text-sm font-semibold">
                          {rec.date}
                          {matchedHolidayPay && (
                            <span className="block text-[10px] font-sans font-semibold text-emerald-700 mt-0.5">
                              {matchedHolidayPay.description ||
                                (matchedHolidayPay.type === "regular"
                                  ? "Regular Holiday"
                                  : "Special Holiday")}
                            </span>
                          )}
                        </td>
                        <td className={`py-2.5 px-2 border-b border-gray-200 ${rec.morningInStatus === 'late' ? 'text-red-500' : earlyInHoursForRow > 0 || rec.morningInStatus === 'early-in' ? 'text-[#237227] font-semibold' : 'text-gray-800'}`}>
                          {attendanceInDisplay}
                        </td>
                        <td className={`py-2.5 px-2 border-b border-gray-200 ${isEarlyOutForRow ? 'text-orange-600 font-semibold' : 'text-gray-800'}`}>
                          {attendanceOutDisplay}
                        </td>
                        <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                          {recOtHours > 0 ? `${getHourMinute(recOtHours)} (${recOtHours.toFixed(2)})` : "N/A"}
                        </td>
                        <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{rec.lateCount || 0}</td>
                        <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 whitespace-nowrap">
                          {rec.lateDetails && rec.lateDetails.length ? (
                            <div className="flex flex-col gap-1 whitespace-nowrap">
                              {rec.lateDetails.map((d, idx) => (
                                <span key={idx} className="text-red-500 text-xs whitespace-nowrap inline-block">
                                  {d.minutesLate ? `${d.minutesLate}m late` : d.status}
                                </span>
                              ))}
                            </div>
                          ) : (
                            "N/A"
                          )}
                        </td>
                        <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 whitespace-nowrap">
                          ₱{dayBaseSalary.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          {dayFraction === 0.5 && (
                            <span className="text-xs text-amber-600 block">(0.5 day)</span>
                          )}
                          {dayFraction === 0 && isWeekend && (
                            <span className="text-xs text-gray-400 block">(Rest Day)</span>
                          )}
                          {dayFraction === 0 && isHolidayDate && !isWeekend && (
                            <span className="text-xs text-emerald-600 font-semibold block">(Holiday)</span>
                          )}
                          {dayFraction === 0 && !isWeekend && !isHolidayDate && (
                            <span className="text-xs text-red-500 block">(0 day)</span>
                          )}
                        </td>
                        <td className="py-2.5 px-2 border-b border-gray-200 whitespace-nowrap">
                          {dayLateDeduction > 0 ? (
                            <span className="text-red-500 font-medium">
                              -₱{dayLateDeduction.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="py-2.5 px-2 border-b border-gray-200 font-semibold whitespace-nowrap min-w-[210px]">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              {recOtHours > 0 && canManageOtForRow ? (
                                isOtApproved ? (
                                  <span className="text-[#237227] font-semibold">
                                    +₱{dayOtPay.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </span>
                                ) : (
                                  <span className="text-gray-400 font-normal">₱0.00</span>
                                )
                              ) : (
                                <span className="text-gray-400 font-normal">-</span>
                              )}
                              {recOtHours > 0 && canManageOtForRow && isOtDenied && (
                                <span className="text-xs text-red-500 block font-normal">(OT Denied)</span>
                              )}
                              {recOtHours > 0 && canManageOtForRow && !isOtApproved && !isOtDenied && (
                                <span className="text-xs text-amber-600 block font-normal">(OT Pending)</span>
                              )}
                            </div>
                            {recOtHours > 0 && canManageOtForRow && !released && (
                              <div className="relative flex items-center gap-1 whitespace-nowrap">
                                <div className="relative">
                                  <button
                                    type="button"
                                    disabled={updatingOtDate === rec.date}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenOtMenuDate((prev) =>
                                        prev === rec.date ? null : rec.date
                                      );
                                    }}
                                    className="px-2.5 py-1 rounded text-[11px] font-semibold border !bg-white hover:!bg-white text-gray-700 border-gray-300 flex items-center gap-1 cursor-pointer shadow-sm"
                                  >
                                    Manage <span className="text-[9px]">▾</span>
                                  </button>
                                  {openOtMenuDate === rec.date && (
                                    <div
                                      onClick={(e) => e.stopPropagation()}
                                      className={`absolute right-0 ${
                                        i >= organizedAttendance.length - 2
                                          ? "bottom-full mb-1"
                                          : "top-full mt-1"
                                      } z-50 w-28 bg-white border border-gray-200 rounded-md shadow-lg p-1 flex flex-col gap-1`}
                                    >
                                      {isOtApproved ? (
                                        <>
                                          <span className="w-full text-left px-2.5 py-1 rounded text-xs font-semibold border !bg-[#237227] !text-white !border-[#237227] shadow-sm flex items-center gap-1.5">
                                            ✓ Approved
                                          </span>
                                          <button
                                            type="button"
                                            disabled={updatingOtDate === rec.date}
                                            onClick={() => {
                                              setOpenOtMenuDate(null);
                                              handleOtApproval(rec, "pending");
                                            }}
                                            className="w-full text-left px-2.5 py-1 rounded text-xs font-semibold text-gray-600 !bg-transparent hover:!bg-transparent border-0 flex items-center gap-1.5 cursor-pointer"
                                            title="Cancel Approval"
                                          >
                                            Cancel
                                          </button>
                                        </>
                                      ) : isOtDenied ? (
                                        <>
                                          <span className="w-full text-left px-2.5 py-1 rounded text-xs font-semibold border !bg-red-600 !text-white !border-red-600 shadow-sm flex items-center gap-1.5">
                                            ✕ Denied
                                          </span>
                                          <button
                                            type="button"
                                            disabled={updatingOtDate === rec.date}
                                            onClick={() => {
                                              setOpenOtMenuDate(null);
                                              handleOtApproval(rec, "pending");
                                            }}
                                            className="w-full text-left px-2.5 py-1 rounded text-xs font-semibold text-gray-600 !bg-transparent hover:!bg-transparent border-0 flex items-center gap-1.5 cursor-pointer"
                                            title="Cancel Denial"
                                          >
                                            Cancel
                                          </button>
                                        </>
                                      ) : (
                                        <>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setOpenOtMenuDate(null);
                                              handleOtApproval(rec, "approved");
                                            }}
                                            className="w-full text-left px-2.5 py-1 rounded text-xs font-semibold text-[#237227] !bg-transparent hover:!bg-transparent border-0 flex items-center gap-1.5 cursor-pointer"
                                          >
                                            ✓ Approve
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setOpenOtMenuDate(null);
                                              handleOtApproval(rec, "denied");
                                            }}
                                            className="w-full text-left px-2.5 py-1 rounded text-xs font-semibold text-red-600 !bg-transparent hover:!bg-transparent border-0 flex items-center gap-1.5 cursor-pointer"
                                          >
                                            ✕ Deny
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
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
              {organizedAttendance.length > 0 && (() => {
                const baseDailyRate = Number(payroll.dailyRate ?? person.daily_rate ?? 0);
                const hourlyRateForDaily = Math.round((baseDailyRate / 8) * 100) / 100;

                const totals = organizedAttendance.reduce(
                  (acc, rec) => {
                    const hasM = Boolean(
                      (rec.morningIn && rec.morningIn !== "-" && rec.morningIn !== "Not time-in") ||
                      (rec.morningOut && rec.morningOut !== "-")
                    );
                    const hasA = Boolean(
                      (rec.afternoonOut && rec.afternoonOut !== "-" && rec.afternoonOut !== "Not time-out" && !String(rec.afternoonOut).includes("Missing")) ||
                      (rec.afternoonIn && rec.afternoonIn !== "-")
                    );
                    let frac = 0;
                    if (hasM && hasA) frac = 1.0;
                    else if (hasM || hasA) frac = 0.5;

                    let otM = 0;
                    try {
                      const scheduledMorningStart = (settings && settings.morning_start) || "08:00";
                      const scheduledAfternoonEnd = (settings && settings.afternoon_end) || "17:00";
                      const schedAfternoonGrace = Number.isFinite(
                        Number(settings && settings.afternoon_grace_minutes),
                      )
                        ? Number(settings.afternoon_grace_minutes)
                        : 0;
                      const schedMorningStartMin = parseTimeToMinutes(scheduledMorningStart) || 480;
                      const morningInMin = parseTimeToMinutes(rec.attendanceIn || rec.morningIn);
                      const afternoonOutMin = parseTimeToMinutes(rec.attendanceOut || rec.afternoonOut || rec.morningOut);
                      const schedAfternoonEndMin = parseTimeToMinutes(scheduledAfternoonEnd);

                      // Early-in computation: 03:00 AM - 07:30 AM only added to OT
                      if (
                        typeof morningInMin === "number" &&
                        morningInMin >= 3 * 60 &&
                        morningInMin <= 7 * 60 + 30 &&
                        morningInMin < schedMorningStartMin
                      ) {
                        otM += schedMorningStartMin - morningInMin;
                      }

                      if (typeof afternoonOutMin === "number" && typeof schedAfternoonEndMin === "number") {
                        const effectiveAfternoonOutMin = afternoonOutMin < 3 * 60 ? afternoonOutMin + 24 * 60 : afternoonOutMin;
                        if (effectiveAfternoonOutMin > schedAfternoonEndMin) {
                          const mins = effectiveAfternoonOutMin - schedAfternoonEndMin;
                          if (mins > schedAfternoonGrace) otM += mins;
                        }
                      }
                    } catch (e) {}

                    const otHrs = getRowOtStatus(rec) === "approved" ? otM / 60 : 0;
                    const baseSalary = Math.round(baseDailyRate * frac * 100) / 100;
                    const otPay = Math.round(otHrs * hourlyRateForDaily * 100) / 100;
                    const lCalc = calculateTieredLateDeduction(
                      rec.lateDetails || [],
                      baseDailyRate,
                      latePenalty,
                      payroll.settings || {}
                    );
                    const lDed = lCalc.totalLateDeduction;
                    const netSalary = Math.max(0, Math.round((baseSalary - lDed) * 100) / 100);

                    return {
                      baseRate: acc.baseRate + baseSalary,
                      lateDeduct: acc.lateDeduct + lDed,
                      netSalary: acc.netSalary + netSalary,
                      otPay: (acc.otPay || 0) + otPay,
                    };
                  },
                  { baseRate: 0, lateDeduct: 0, netSalary: 0 }
                );

                return (
                  <tfoot>
                    <tr className="bg-gray-100 font-semibold text-gray-800">
                      <td colSpan="6" className="py-2.5 px-2 text-right border-t-2 border-gray-300">
                        Total:
                      </td>
                      <td className="py-2.5 px-2 border-t-2 border-gray-300 whitespace-nowrap">
                        ₱{totals.baseRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-2.5 px-2 border-t-2 border-gray-300 whitespace-nowrap text-red-500">
                        {totals.lateDeduct > 0 ? `-₱${totals.lateDeduct.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "N/A"}
                      </td>
                      <td className="py-2.5 px-2 border-t-2 border-gray-300 whitespace-nowrap text-[#237227] font-bold">
                        {totals.otPay > 0
                          ? `+₱${totals.otPay.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : "-"}
                      </td>
                    </tr>
                  </tfoot>
                );
              })()}
            </table>
          </div>

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
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Duration</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-left border-b-2 border-gray-200 uppercase text-sm tracking-wide">Applied Tier</th>
                <th className="bg-gray-50 text-gray-600 font-semibold py-3 px-2 text-right border-b-2 border-gray-200 uppercase text-sm tracking-wide">Deduction</th>
              </tr>
            </thead>
            <tbody>
              {allLateDetails.length ? (
                allLateDetails.map((d, i) => {
                  const trClass = i % 2 === 0 ? "bg-gray-50" : "bg-white";
                  const itemCalc = calculateTieredLateDeduction(
                    [d],
                    baseDailyRate,
                    latePenalty,
                    payroll.settings || {}
                  );
                  const breakdownItem = itemCalc.lateBreakdown?.[0] || {};
                  return (
                    <tr key={i} className={trClass}>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-mono text-sm font-semibold">{d.date}</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{d.session}</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{d.time}</td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-red-600 font-semibold">
                        {d.minutesLate ? `${d.minutesLate} mins late` : "Late"}
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-700">
                        {breakdownItem.tierLabel || "Standard Late"}
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-right font-bold text-red-600 whitespace-nowrap">
                        -₱{itemCalc.totalLateDeduction.toFixed(2)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan="6"
                    className="py-3 px-2 border-b border-gray-200 text-center text-gray-400"
                  >
                    No late records for this period
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
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                  Overtime Pay
                  {false && hasNsdEnabled && nsdHours > 0 && (
                    <span className="block text-xs text-indigo-700 font-semibold mt-0.5">
                      Includes {getHourMinute(nsdHours)} Night Diff (NSD)
                    </span>
                  )}
                </td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">{getHourMinute(otHours)}</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                  Daily Rate ÷ 8 = ₱{(baseHourlyRate * otMultiplier).toFixed(2)}/hr
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
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        Holiday Pay
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        {h.date}
                        {h.description ? ` - ${h.description}` : ""}
                        {` (${h.type === "regular" ? "Regular Holiday" : "Special Holiday"})`}
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        <span className="text-[#237227] font-semibold">
                          {" "}
                          ({h.ratePercent}%)
                        </span>
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        ₱{(h.amount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}

                  <tr className="bg-gray-100 font-semibold">
                    <td colSpan="3" className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                      Total Holiday Pay
                    </td>
                    <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                      ₱{totalHolidayPay.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
              <tr className="bg-gray-50 font-medium">
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-semibold">
                  Monthly Share:
                </td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-semibold">
                  ₱{deductions.reduce((acc, d) => acc + Number(d.value || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
              </tr>
              <tr className="bg-green-50/50 font-medium">
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">Employer Share (Total):</span>
                    <span className="text-[0.68rem] text-white font-bold uppercase bg-[#237227] px-2.5 py-0.5 rounded ml-2">
                      Company Paid
                    </span>
                  </div>
                </td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-[#237227] font-bold">
                  ₱{Number(payroll.totalEmployerShare || ((payroll.sss_employer || 0) + (payroll.philhealth_employer || 0) + (payroll.pag_ibig_employer || 0))).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
              </tr>
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
                          : "N/A"}
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

              {expensesEntries && expensesEntries.length > 0 && (
                <>
                  <tr>
                    <td colSpan={2} className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-bold">
                      Expenses / Product Purchases Details
                    </td>
                  </tr>
                  {expensesEntries.map((h, idx) => (
                    <tr
                      key={h.id || idx}
                      className={idx % 2 === 0 ? "bg-gray-50" : "bg-white"}
                    >
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        <span className="font-semibold">{h.item_name}</span>
                        {h.note && <span className="text-gray-500 text-xs ml-2">({h.note})</span>}
                        <div className="text-[0.75rem] text-gray-400">
                          {h.expense_date || (h.created_at ? new Date(h.created_at).toLocaleDateString() : "N/A")}
                        </div>
                      </td>
                      <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">
                        ₱{Number(h.amount).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  <tr className="transition-colors duration-200">
                    <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-bold">
                      Expenses Total
                    </td>
                    <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800 font-bold">
                      ₱{Number(expensesTotalInPeriod || 0).toFixed(2)}
                    </td>
                  </tr>
                </>
              )}

              <tr className="bg-gray-100 font-semibold">
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">Total Deductions</td>
                <td className="py-2.5 px-2 border-b border-gray-200 text-gray-800">₱{totalDeductions.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
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

          {/* Employer Share (Company Paid Contributions) */}
          {((payroll.sss_employer || 0) > 0 || (payroll.philhealth_employer || 0) > 0 || (payroll.pag_ibig_employer || 0) > 0 || (payroll.totalEmployerShare || 0) > 0) && (
            <div className="mt-6 p-4 rounded-xl bg-gray-50 border border-gray-200">
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-[0.92rem] font-bold text-gray-700 flex items-center gap-1.5">
                  <Icon as={FiBriefcase} size={16} color="#237227" ariaLabel="Company Share" />
                  Employer Contributions (Company Paid)
                </span>
                <span className="text-[0.68rem] font-semibold text-gray-500 bg-gray-200 px-2 py-0.5 rounded">
                  Not deducted from employee salary
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="flex flex-col bg-white p-2.5 rounded-lg border border-gray-200">
                  <span className="text-[0.7rem] text-gray-500 font-semibold uppercase tracking-wider">SSS Employer</span>
                  <span className="font-bold text-gray-800 text-sm mt-0.5">₱{Number(payroll.sss_employer || 0).toFixed(2)}</span>
                </div>
                <div className="flex flex-col bg-white p-2.5 rounded-lg border border-gray-200">
                  <span className="text-[0.7rem] text-gray-500 font-semibold uppercase tracking-wider">PhilHealth Employer</span>
                  <span className="font-bold text-gray-800 text-sm mt-0.5">₱{Number(payroll.philhealth_employer || 0).toFixed(2)}</span>
                </div>
                <div className="flex flex-col bg-white p-2.5 rounded-lg border border-gray-200">
                  <span className="text-[0.7rem] text-gray-500 font-semibold uppercase tracking-wider">Pag-IBIG Employer</span>
                  <span className="font-bold text-gray-800 text-sm mt-0.5">₱{Number(payroll.pag_ibig_employer || 0).toFixed(2)}</span>
                </div>
              </div>
              <div className="mt-2 text-right text-xs text-gray-500 font-medium">
                Total Company Share: <strong className="text-gray-800">₱{Number((payroll.sss_employer || 0) + (payroll.philhealth_employer || 0) + (payroll.pag_ibig_employer || 0)).toFixed(2)}</strong>
              </div>
            </div>
          )}
        </div>

        {/* ✅ BUTTONS OUTSIDE PDF */}
        <div className="mt-6 flex justify-end gap-3">
          {!released && onRelease && (
            <button
              onClick={onRelease}
              className="py-2.5 px-6 rounded-lg text-[0.95rem] font-semibold border-none cursor-pointer inline-flex items-center justify-center bg-[#237227] text-white hover:bg-[#1b5e20] shadow-sm transition-colors"
            >
              <FiCheckCircle style={{ marginRight: 8, color: "#ffffff", fontSize: "1.1rem" }} />
              Release Payslip
            </button>
          )}
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