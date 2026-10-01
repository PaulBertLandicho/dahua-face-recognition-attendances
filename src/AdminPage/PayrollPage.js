import React, { useEffect, useState, useCallback } from "react";
import Swal from "sweetalert2";
import { calculatePayroll, calculateTieredLateDeduction } from "./Payroll";
import PayslipModal from "../AdminPage/PayslipModals/PayslipModal";
import { getDetailedAttendance } from "./attendanceDetails";
import { generateAllPayslipsPdf } from "./PayslipModals/generatePayslipPdf";
import { hasHolidayPayEligibility } from "../utils/holidayPayEligibility";
import * as XLSX from "xlsx";
import {
  FiSearch,
  FiEye,
  FiDownload,
  FiPrinter,
  FiDollarSign,
  FiBriefcase,
  FiUsers,
  FiPlus,
  FiTrash2,
  FiShoppingBag,
  FiX,
  FiCalendar,
  FiChevronLeft,
  FiChevronRight,
  FiRefreshCw,
  FiCheckCircle,
  FiSend,
  FiClock,
} from "react-icons/fi";

import { supabase } from "../mysqlClient";

export default function PayrollPage() {
  const [persons, setPersons] = useState([]);
  const [deptRates, setDeptRates] = useState([]);
  const [payrollPeriods, setPayrollPeriods] = useState([]); // [{personId, period, payroll, released}]
  const [, setHolidays] = useState([]);
  const [settings, setSettings] = useState({});
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [showPayslip, setShowPayslip] = useState(false);

  // Raw cached datasets so changing date range recalculates instantly without re-fetching
  const [rawAttendance, setRawAttendance] = useState([]);
  const [rawPersons, setRawPersons] = useState([]);
  const [rawDeptRates, setRawDeptRates] = useState([]);
  const [rawSettings, setRawSettings] = useState({});
  const [rawHolidays, setRawHolidays] = useState([]);
  const [rawExpenses, setRawExpenses] = useState([]);
  const [rawPayrollDb, setRawPayrollDb] = useState([]);

  // Period state
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [releasingAll, setReleasingAll] = useState(false);

  // Expenses Modal State
  const [showExpensesModal, setShowExpensesModal] = useState(false);
  const [selectedExpensesRecord, setSelectedExpensesRecord] = useState(null);
  const [newExpItem, setNewExpItem] = useState("");
  const [newExpAmount, setNewExpAmount] = useState("");
  const [newExpDate, setNewExpDate] = useState("");
  const [newExpNote, setNewExpNote] = useState("");
  const [expActionLoading, setExpActionLoading] = useState(false);

  // Add filter, sort, export, and pagination state
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [sortOrder, setSortOrder] = useState("asc");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  useEffect(() => {
    setCurrentPage(1);
  }, [search, departmentFilter, sortOrder, startDate, endDate]);

  const Icons = {
    search: <FiSearch />,
    download: <FiDownload />,
    eye: <FiEye />,
  };

  // Helper to determine the initial default cutoff period based on latest attendance or today
  const getDefaultPeriod = (attList) => {
    let refDate = new Date();
    if (attList && attList.length > 0) {
      const latestTimestamp = attList.reduce((max, a) => {
        const t = new Date(a.device_time).getTime();
        return t > max ? t : max;
      }, 0);
      if (latestTimestamp > 0) {
        refDate = new Date(latestTimestamp);
      }
    }
    const year = refDate.getFullYear();
    const month = refDate.getMonth();
    const day = refDate.getDate();
    const pad = (n) => String(n).padStart(2, "0");
    const yStr = String(year);
    const mStr = pad(month + 1);

    if (day <= 15) {
      return {
        start: `${yStr}-${mStr}-01`,
        end: `${yStr}-${mStr}-15`,
      };
    } else {
      const lastDay = new Date(year, month + 1, 0).getDate();
      return {
        start: `${yStr}-${mStr}-16`,
        end: `${yStr}-${mStr}-${pad(lastDay)}`,
      };
    }
  };

  // Compute payroll for all persons for the chosen date range [sDate, eDate]
  const computePayrollForPeriod = useCallback(
    async (
      sDate,
      eDate,
      attData,
      personsData,
      deptData,
      settingsData,
      payrollDb,
      holidaysData,
      expensesData,
      showAll = false,
    ) => {
      if (!sDate || !eDate || !personsData || !personsData.length) {
        return [];
      }
      const periodStr = `${sDate}_to_${eDate}`;
      const pStart = new Date(`${sDate}T00:00:00`);
      const pEnd = new Date(`${eDate}T23:59:59.999`);

      const payrollDbByKey = new Map(
        (payrollDb || []).map((row) => [`${row.person_id}|${row.period}`, row]),
      );

      const parseTime = (timeStr) => {
        if (!timeStr) return null;
        let match = String(timeStr).match(/(\d{1,2}):(\d{2})(?:\s*([APap][Mm]))?/);
        if (match) {
          let hour = parseInt(match[1], 10);
          let minute = parseInt(match[2], 10);
          const ampm = match[3];
          if (ampm) {
            if (/pm/i.test(ampm) && hour < 12) hour += 12;
            if (/am/i.test(ampm) && hour === 12) hour = 0;
          }
          return hour * 60 + minute;
        }
        return null;
      };

      const schedMorningStart =
        parseTime(settingsData.morning_start || "08:00") || 480;
      const schedEarlyInLimit = Math.min(
        schedMorningStart - 60,
        parseTime("07:00") || 420,
      );
      const lunchStart =
        parseTime(settingsData.morning_end || "12:00") || 720;
      const schedAfternoonEnd =
        parseTime(settingsData.afternoon_end || "17:00") || 1020;
      const schedMorningEnd = lunchStart;

      const formatYMD = (val) => {
        if (!val) return "";
        if (typeof val === "string") {
          const trimmed = val.trim();
          const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
          if (m) return `${m[1]}-${m[2]}-${m[3]}`;
          const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (slash) {
            return `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
          }
        }
        try {
          const d = val instanceof Date ? val : new Date(val);
          if (!isNaN(d.getTime())) {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          }
        } catch (e) {}
        return "";
      };

      const todayStr = formatYMD(new Date());

      const results = await Promise.all(
        personsData.map(async (person) => {
          // Attendance for this person inside the selected period
          const personAttendance = (attData || []).filter((a) => {
            if (String(a.person_id) !== String(person.id)) return false;
            const dt = new Date(a.device_time);
            return dt >= pStart && dt <= pEnd;
          });

          // Expenses for this person inside the selected period
          const periodExpenses = (expensesData || []).filter((exp) => {
            if (String(exp.person_id) !== String(person.id)) return false;
            if (exp.period && exp.period === periodStr) return true;
            const eDateVal =
              exp.expense_date ||
              (exp.created_at ? String(exp.created_at).slice(0, 10) : null);
            if (eDateVal && eDateVal >= sDate && eDateVal <= eDate) return true;
            return false;
          });
          const totalExpenses =
            Math.round(
              periodExpenses.reduce(
                (acc, curr) => acc + Number(curr.amount || 0),
                0,
              ) * 100,
            ) / 100;

          // If no attendance and no expenses, skip unless showAll is toggled
          const hasActivity =
            personAttendance.length > 0 || periodExpenses.length > 0;
          if (!showAll && !hasActivity) {
            return null;
          }

          const basePayroll =
            calculatePayroll(
              personAttendance,
              [person],
              deptData,
              settingsData,
            )[0] || {};

          const detailed = getDetailedAttendance(
            personAttendance,
            person.id,
            settingsData,
          );

          let totalOtHours = 0;
          detailed.forEach((rec) => {
            const mIn = parseTime(rec.morningIn || rec.attendanceIn);
            const mOut = parseTime(rec.morningOut);
            const aOut = parseTime(rec.afternoonOut || rec.attendanceOut);
            let dayOtMins = 0;

            if (
              mIn !== null &&
              mIn <= schedEarlyInLimit &&
              mIn < schedMorningStart
            ) {
              dayOtMins += schedMorningStart - mIn;
            }
            if (aOut !== null && aOut > schedAfternoonEnd) {
              const otMins = aOut - schedAfternoonEnd;
              if (otMins >= 60) dayOtMins += otMins;
            }
            if (mOut !== null && mOut > schedMorningEnd) {
              const otMins = mOut - schedMorningEnd;
              if (otMins >= 60) dayOtMins += otMins;
            }
            if (dayOtMins > 0) totalOtHours += dayOtMins / 60;
          });

          let attendedDays = 0;
          detailed.forEach((rec) => {
            const hasMorning = Boolean(
              (rec.morningIn &&
                rec.morningIn !== "-" &&
                rec.morningIn !== "Not time-in") ||
                (rec.morningOut && rec.morningOut !== "-"),
            );
            const hasAfternoon = Boolean(
              (rec.afternoonOut &&
                rec.afternoonOut !== "-" &&
                rec.afternoonOut !== "Not time-out" &&
                !String(rec.afternoonOut).includes("Missing")) ||
                (rec.afternoonIn && rec.afternoonIn !== "-"),
            );
            if (hasMorning && hasAfternoon) attendedDays += 1;
            else if (hasMorning || hasAfternoon) attendedDays += 0.5;
          });

          basePayroll.daysPresent = Number(attendedDays) || 0;
          basePayroll.otHours =
            Number(Math.round(totalOtHours * 100) / 100) || 0;
          const otHourlyRate = Number(
            basePayroll.otHourlyRate ||
              Number(basePayroll.dailyRate || 0) / 8,
          );
          basePayroll.otPay =
            Number(
              Math.round(otHourlyRate * basePayroll.otHours * 100) / 100,
            ) || 0;
          basePayroll.gross =
            Number(
              Number(basePayroll.dailyRate || 0) * basePayroll.daysPresent +
                basePayroll.otPay,
            ) || 0;

          const allPersonLateDetails = detailed
            .map((rec) => rec.lateDetails || [])
            .flat();
          const lateCount = allPersonLateDetails.length;
          const latePenalty = Number(person.late_penalty || 0);
          const lateCountLimit = Number(settingsData.late_count_limit || 5);
          
          // Tiered late deduction: 1-15m (minor), 16-30m (mid), 31-60m (1 hr employee rate), >60m (pro-rated hrs)
          const { totalLateDeduction, lateBreakdown } = calculateTieredLateDeduction(
            allPersonLateDetails,
            basePayroll.dailyRate,
            latePenalty,
            settingsData
          );

          const totalDeductions =
            Number(basePayroll.sss || 0) +
            Number(basePayroll.pag_ibig || 0) +
            Number(basePayroll.philhealth || 0) +
            Number(basePayroll.cashAdvance || 0) +
            totalLateDeduction +
            totalExpenses;

          const net = Math.max(
            0,
            Math.round((basePayroll.gross - totalDeductions) * 100) / 100,
          );

          // Absent count for weekdays in selected range up to today
          let absentCount = 0;
          try {
            const allDates = [];
            for (
              let d = new Date(pStart);
              d <= pEnd;
              d.setDate(d.getDate() + 1)
            ) {
              if (d.getDay() === 0 || d.getDay() === 6) continue;
              const ds = formatYMD(d);
              if (ds) allDates.push(ds);
            }
            const attendedDatesSet = new Set(
              (detailed || [])
                .map((a) => formatYMD(a.date || a.device_time))
                .filter(Boolean),
            );
            const holidaysForDept = (holidaysData || []).filter(
              (h) =>
                (h.department || "").toLowerCase().trim() ===
                (person.department || "").toLowerCase().trim(),
            );
            const holidaySet = new Set(
              (holidaysForDept || [])
                .map((h) => formatYMD(h.date || h.holiday_date))
                .filter(Boolean),
            );
            const absentDates = allDates.filter(
              (dateStr) =>
                dateStr < todayStr &&
                !attendedDatesSet.has(dateStr) &&
                !holidaySet.has(dateStr),
            );
            absentCount = absentDates.length;
          } catch (e) {
            absentCount = 0;
          }

          // DB sync with payroll_periods table
          let dbRow = payrollDbByKey.get(`${person.id}|${periodStr}`) || null;
          if (dbRow && !dbRow.released) {
            const payload = {
              days_present: basePayroll.daysPresent,
              daily_rate: Number(basePayroll.dailyRate ?? 0),
              late_penalty: Number(person.late_penalty || 0),
              late_count: lateCount,
              gross: basePayroll.gross,
              total_late_deduction: totalLateDeduction,
              total_deductions: totalDeductions,
              net,
            };
            try {
              const { data: updated, error: updErr } = await supabase
                .from("payroll_periods")
                .update(payload)
                .eq("id", dbRow.id)
                .select()
                .single();
              if (!updErr && updated) dbRow = updated;
            } catch (e) {
              console.error("Error updating payroll_periods", e);
            }
          } else if (!dbRow) {
            const payload = {
              person_id: person.id,
              period: periodStr,
              days_present: basePayroll.daysPresent,
              daily_rate: Number(basePayroll.dailyRate ?? 0),
              late_penalty: Number(person.late_penalty || 0),
              late_count: lateCount,
              gross: basePayroll.gross,
              total_late_deduction: totalLateDeduction,
              total_deductions: totalDeductions,
              net,
              released: false,
            };
            try {
              const { data: upserted, error: upsertErr } = await supabase
                .from("payroll_periods")
                .upsert([payload], { onConflict: ["person_id", "period"] })
                .select()
                .single();
              if (upsertErr) {
                const { data: inserted, error: insertError } = await supabase
                  .from("payroll_periods")
                  .insert([payload])
                  .select()
                  .single();
                dbRow =
                  !insertError && inserted
                    ? inserted
                    : { id: null, released: false };
              } else {
                dbRow = upserted;
              }
            } catch (e) {
              console.error("Error upserting/inserting payroll_periods", e);
              dbRow = { id: null, released: false };
            }
          }

          return {
            personId: person.id,
            person,
            period: periodStr,
            payroll: {
              ...basePayroll,
              expenses: totalExpenses,
              expensesEntries: periodExpenses,
              lateCount,
              lateCountLimit,
              lateBreakdown,
              totalLateDeduction,
              totalDeductions,
              net,
            },
            expenses: totalExpenses,
            expensesEntries: periodExpenses,
            attendance: personAttendance,
            released: !!dbRow?.released,
            dbId: dbRow?.id || null,
            absentCount,
          };
        }),
      );

      return results.filter(Boolean);
    },
    [],
  );

  // Recalculate helper using stored raw data
  const triggerRecalculate = useCallback(
    async (sDate, eDate) => {
      if (!sDate || !eDate) return;
      setIsRecalculating(true);
      try {
        const computed = await computePayrollForPeriod(
          sDate,
          eDate,
          rawAttendance,
          rawPersons,
          rawDeptRates,
          rawSettings,
          rawPayrollDb,
          rawHolidays,
          rawExpenses,
          false,
        );
        setPayrollPeriods(computed);
      } catch (err) {
        console.error("Failed to recalculate payroll for period:", err);
      } finally {
        setIsRecalculating(false);
      }
    },
    [
      computePayrollForPeriod,
      rawAttendance,
      rawPersons,
      rawDeptRates,
      rawSettings,
      rawPayrollDb,
      rawHolidays,
      rawExpenses,
    ],
  );

  // Initial load
  useEffect(() => {
    async function fetchData() {
      const [
        attRes,
        personsRes,
        deptRes,
        settingsRes,
        payrollRes,
        holidaysRes,
        expensesRes,
      ] = await Promise.all([
        (function () {
          const cutoff = new Date();
          cutoff.setMonth(cutoff.getMonth() - 6);
          return supabase
            .from("attendance")
            .select(
              "id, person_id, name, event, method, device_time, status, archived",
            )
            .gte("device_time", cutoff.toISOString());
        })(),
        supabase
          .from("persons")
          .select(
            "id, name, department, daily_rate, late_penalty, sss, pag_ibig, philhealth, cash_advance, registration_photo",
          ),
        supabase.from("department_rates").select("*"),
        supabase.from("settings").select("*").eq("id", 1).maybeSingle(),
        supabase.from("payroll_periods").select("*").limit(5000),
        supabase.from("holidays").select("*").limit(5000),
        supabase.from("expenses").select("*").limit(10000),
      ]);

      const attData = Array.isArray(attRes.data) ? attRes.data : [];
      const personsData = Array.isArray(personsRes.data) ? personsRes.data : [];
      const deptData = deptRes.data || [];
      const settingsData = settingsRes.data || {};
      const holidaysData = holidaysRes.data || [];
      const expensesData = Array.isArray(expensesRes.data)
        ? expensesRes.data
        : [];
      const payrollDb = Array.isArray(payrollRes.data)
        ? payrollRes.data.filter(Boolean)
        : [];

      if (attRes.error)
        console.error("Payroll attendance query failed:", attRes.error);
      if (personsRes.error)
        console.error("Payroll persons query failed:", personsRes.error);
      if (settingsRes.error)
        console.error("Payroll settings query failed:", settingsRes.error);

      // Cache raw data in state
      setRawAttendance(attData);
      setRawPersons(personsData);
      setRawDeptRates(deptData);
      setRawSettings(settingsData);
      setRawHolidays(holidaysData);
      setRawExpenses(expensesData);
      setRawPayrollDb(payrollDb);

      setPersons(personsData);
      setDeptRates(deptData);
      setSettings(settingsData);
      setHolidays(holidaysData);

      // Initialize default cutoff period based on attendance/current date
      const defaultPeriod = getDefaultPeriod(attData);
      setStartDate(defaultPeriod.start);
      setEndDate(defaultPeriod.end);

      // Compute payroll for this default period
      const computed = await computePayrollForPeriod(
        defaultPeriod.start,
        defaultPeriod.end,
        attData,
        personsData,
        deptData,
        settingsData,
        payrollDb,
        holidaysData,
        expensesData,
        false,
      );
      setPayrollPeriods(computed);
    }

    fetchData();
  }, [computePayrollForPeriod]);

  // Quick Preset Selection Handlers
  const handlePresetCutoff = (type) => {
    let baseDate = new Date();
    if (startDate) {
      const parsed = new Date(startDate);
      if (!isNaN(parsed.getTime())) baseDate = parsed;
    }
    const year = baseDate.getFullYear();
    const month = baseDate.getMonth();
    const pad = (n) => String(n).padStart(2, "0");
    const yStr = String(year);
    const mStr = pad(month + 1);

    let s = "";
    let e = "";
    if (type === "1-15") {
      s = `${yStr}-${mStr}-01`;
      e = `${yStr}-${mStr}-15`;
    } else if (type === "16-end") {
      const lastDay = new Date(year, month + 1, 0).getDate();
      s = `${yStr}-${mStr}-16`;
      e = `${yStr}-${mStr}-${pad(lastDay)}`;
    } else if (type === "month") {
      const lastDay = new Date(year, month + 1, 0).getDate();
      s = `${yStr}-${mStr}-01`;
      e = `${yStr}-${mStr}-${pad(lastDay)}`;
    }

    setStartDate(s);
    setEndDate(e);
    triggerRecalculate(s, e);
  };

  const handlePrevPeriod = () => {
    let baseDate = new Date();
    if (startDate) {
      const parsed = new Date(startDate);
      if (!isNaN(parsed.getTime())) baseDate = parsed;
    }
    const day = baseDate.getDate();
    const year = baseDate.getFullYear();
    const month = baseDate.getMonth();
    const pad = (n) => String(n).padStart(2, "0");

    let s = "";
    let e = "";
    if (day > 15) {
      s = `${year}-${pad(month + 1)}-01`;
      e = `${year}-${pad(month + 1)}-15`;
    } else {
      const prevDate = new Date(year, month - 1, 1);
      const prevY = prevDate.getFullYear();
      const prevM = pad(prevDate.getMonth() + 1);
      const prevMonthLastDay = new Date(prevY, prevDate.getMonth() + 1, 0).getDate();
      s = `${prevY}-${prevM}-16`;
      e = `${prevY}-${prevM}-${pad(prevMonthLastDay)}`;
    }

    setStartDate(s);
    setEndDate(e);
    triggerRecalculate(s, e);
  };

  const handleNextPeriod = () => {
    let baseDate = new Date();
    if (startDate) {
      const parsed = new Date(startDate);
      if (!isNaN(parsed.getTime())) baseDate = parsed;
    }
    const day = baseDate.getDate();
    const year = baseDate.getFullYear();
    const month = baseDate.getMonth();
    const pad = (n) => String(n).padStart(2, "0");

    let s = "";
    let e = "";
    if (day <= 15) {
      const lastDay = new Date(year, month + 1, 0).getDate();
      s = `${year}-${pad(month + 1)}-16`;
      e = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
    } else {
      const nextDate = new Date(year, month + 1, 1);
      const nextY = nextDate.getFullYear();
      const nextM = pad(nextDate.getMonth() + 1);
      s = `${nextY}-${nextM}-01`;
      e = `${nextY}-${nextM}-15`;
    }

    setStartDate(s);
    setEndDate(e);
    triggerRecalculate(s, e);
  };

  const isPresetActive = (type) => {
    if (!startDate || !endDate) return false;
    const sParts = startDate.split("-").map(Number);
    const eParts = endDate.split("-").map(Number);
    if (sParts.length < 3 || eParts.length < 3) return false;
    const [sy, sm, sd] = sParts;
    const [ey, em, ed] = eParts;
    if (sy !== ey || sm !== em) return false;
    const lastDay = new Date(sy, sm, 0).getDate();
    if (type === "1-15") return sd === 1 && ed === 15;
    if (type === "16-end") return sd === 16 && ed === lastDay;
    if (type === "month") return sd === 1 && ed === lastDay;
    return false;
  };

  const handleApplyPeriod = () => {
    if (!startDate || !endDate) {
      Swal.fire(
        "Incomplete Period",
        "Please select both From and To dates.",
        "warning",
      );
      return;
    }
    if (startDate > endDate) {
      Swal.fire(
        "Invalid Date Range",
        "The 'From' date must be before or equal to the 'To' date.",
        "warning",
      );
      return;
    }
    triggerRecalculate(startDate, endDate);
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

  const generateUUID = () => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };

  const handleReleasePayroll = async (record, isAdvance = false) => {
    if (!record) return;
    const personName = record.person?.name || record.personId;
    const periodDisplay = formatPeriod(record.period);
    const netAmount = Number(record.payroll?.net ?? 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    const result = await Swal.fire({
      title: "Release Payroll Payslip?",
      html: `
        <div style="text-align: left; font-size: 0.95rem; line-height: 1.6;">
          <p>Are you sure you want to release the payslip for <strong>${personName}</strong>?</p>
          <p style="margin: 6px 0; color: #555;"><strong>Period:</strong> ${periodDisplay}</p>
          <p style="margin: 6px 0; color: #555;"><strong>Net Payout:</strong> ₱${netAmount}</p>
          <p style="font-size: 0.82rem; color: #777; margin-top: 10px;">This will mark the payroll as <strong>Released</strong> and record it in the Released Payroll History.</p>
        </div>
      `,
      icon: "question",
      showCancelButton: true,
      confirmButtonText: "Yes, Release Payslip",
      cancelButtonText: "Cancel",
      confirmButtonColor: "#237227",
    });

    if (!result.isConfirmed) return;

    try {
      Swal.fire({
        title: "Releasing Payslip...",
        text: "Please wait while the payslip is being finalized...",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });

      let targetId = record.dbId;
      const periodStr = record.period;
      const personId = record.personId || record.person?.id;

      const payload = {
        person_id: personId,
        period: periodStr,
        days_present: record.payroll.daysPresent,
        daily_rate: Number(record.payroll.dailyRate ?? 0),
        late_penalty: Number(record.person?.late_penalty || 0),
        late_count: record.payroll.lateCount,
        gross: record.payroll.gross,
        total_late_deduction: record.payroll.totalLateDeduction,
        total_deductions: record.payroll.totalDeductions,
        net: record.payroll.net,
        released: true,
      };

      if (targetId) {
        const { error: updErr } = await supabase
          .from("payroll_periods")
          .update({ released: true, ...payload })
          .eq("id", targetId);
        if (updErr) throw updErr;
      } else {
        const insertPayload = { id: generateUUID(), ...payload };
        const { data: upserted, error: upsErr } = await supabase
          .from("payroll_periods")
          .upsert([insertPayload], { onConflict: ["person_id", "period"] })
          .select()
          .single();
        if (upsErr) {
          const { data: insRow, error: insErr } = await supabase
            .from("payroll_periods")
            .insert([insertPayload])
            .select()
            .single();
          if (insErr) throw insErr;
          targetId = insRow?.id || insertPayload.id;
        } else {
          targetId = upserted?.id || insertPayload.id;
        }
      }

      let releasedBy = "admin";
      try {
        const sessionStr = localStorage.getItem("sb-session");
        if (sessionStr) {
          const sess = JSON.parse(sessionStr);
          if (sess && sess.user && sess.user.email) releasedBy = sess.user.email;
        }
      } catch (e) {}

      const actionType = isAdvance ? "Advance Release" : "Period Released";
      const nowIso = new Date().toISOString();

      try {
        await supabase.from("payroll_activity_logs").insert([
          {
            id: generateUUID(),
            payroll_period_id: targetId,
            person_id: personId,
            person_name: record.person?.name || null,
            released_by: releasedBy,
            action: actionType,
            timestamp: nowIso,
          },
        ]);
      } catch (logErr) {
        console.warn("Activity log insert notice:", logErr);
      }

      try {
        const historyPayload = {
          id: generateUUID(),
          payroll_period_id: targetId,
          person_id: personId,
          person_name: record.person?.name || null,
          department: record.person?.department || null,
          period: periodStr,
          days_present: record.payroll.daysPresent,
          daily_rate: Number(record.payroll.dailyRate ?? 0),
          late_penalty: Number(record.person?.late_penalty || 0),
          late_count: record.payroll.lateCount,
          gross: record.payroll.gross,
          total_late_deduction: record.payroll.totalLateDeduction,
          total_deductions: record.payroll.totalDeductions,
          net: record.payroll.net,
          detailed_attendance: record.attendance ? JSON.stringify(record.attendance) : "[]",
          released: true,
          action: actionType,
          released_by: releasedBy,
          released_at: nowIso,
        };

        const { data: existingHist } = await supabase
          .from("payroll_released_history")
          .select("id")
          .eq("payroll_period_id", targetId)
          .maybeSingle();

        if (existingHist) {
          await supabase
            .from("payroll_released_history")
            .update({
              action: actionType,
              released_by: releasedBy,
              released_at: nowIso,
            })
            .eq("payroll_period_id", targetId);
        } else {
          await supabase
            .from("payroll_released_history")
            .insert([historyPayload]);
        }
      } catch (histErr) {
        console.warn("Release history snapshot notice:", histErr);
      }

      setPayrollPeriods((prev) =>
        prev.map((item) =>
          item.personId === personId && item.period === periodStr
            ? { ...item, released: true, dbId: targetId }
            : item
        )
      );

      setSelected((prev) =>
        prev && prev.person?.id === personId && prev.period === periodStr
          ? { ...prev, released: true }
          : prev
      );

      Swal.fire({
        title: "Released Successfully!",
        text: `Payslip for ${personName} has been released.`,
        icon: "success",
        confirmButtonColor: "#237227",
      });
    } catch (err) {
      console.error("Error releasing payroll:", err);
      Swal.fire("Release Failed", err.message || "Could not release payroll.", "error");
    }
  };

  const handleReleaseAllPeriodPayroll = async () => {
    const pendingRecords = payrollPeriods.filter((p) => !p.released);
    if (pendingRecords.length === 0) {
      Swal.fire({
        title: "All Released",
        text: "All employee payslips for this cutoff period are already marked as released.",
        icon: "info",
        confirmButtonColor: "#237227",
      });
      return;
    }

    const periodDisplay = formatPeriod(`${startDate}_to_${endDate}`);
    const result = await Swal.fire({
      title: "Release All Payslips for Period?",
      html: `
        <div style="text-align: left; font-size: 0.95rem; line-height: 1.6;">
          <p>Are you sure you want to release payroll payslips for <strong>all ${pendingRecords.length} pending employee(s)</strong>?</p>
          <p style="margin: 6px 0; color: #555;"><strong>Cutoff Period:</strong> ${periodDisplay}</p>
          <p style="font-size: 0.82rem; color: #777; margin-top: 10px;">This will finalize all pending payslips for this period, update their status to <strong>Released</strong>, and record them in the Released Payroll History.</p>
        </div>
      `,
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: `Yes, Release All (${pendingRecords.length})`,
      cancelButtonText: "Cancel",
      confirmButtonColor: "#237227",
    });

    if (!result.isConfirmed) return;

    setReleasingAll(true);
    Swal.fire({
      title: "Releasing All Payslips...",
      text: `Processing 0 of ${pendingRecords.length}...`,
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });

    let releasedBy = "admin";
    try {
      const sessionStr = localStorage.getItem("sb-session");
      if (sessionStr) {
        const sess = JSON.parse(sessionStr);
        if (sess && sess.user && sess.user.email) releasedBy = sess.user.email;
      }
    } catch (e) {}

    let successCount = 0;
    let failCount = 0;
    const periodStr = `${startDate}_to_${endDate}`;
    const nowIso = new Date().toISOString();

    for (let i = 0; i < pendingRecords.length; i++) {
      const record = pendingRecords[i];
      try {
        Swal.update({
          text: `Processing ${i + 1} of ${pendingRecords.length} (${record.person?.name || record.personId})...`,
        });

        let targetId = record.dbId;
        const personId = record.personId || record.person?.id;
        const payload = {
          person_id: personId,
          period: periodStr,
          days_present: record.payroll.daysPresent,
          daily_rate: Number(record.payroll.dailyRate ?? 0),
          late_penalty: Number(record.person?.late_penalty || 0),
          late_count: record.payroll.lateCount,
          gross: record.payroll.gross,
          total_late_deduction: record.payroll.totalLateDeduction,
          total_deductions: record.payroll.totalDeductions,
          net: record.payroll.net,
          released: true,
        };

        if (targetId) {
          await supabase
            .from("payroll_periods")
            .update({ released: true, ...payload })
            .eq("id", targetId);
        } else {
          const insertPayload = { id: generateUUID(), ...payload };
          const { data: upserted } = await supabase
            .from("payroll_periods")
            .upsert([insertPayload], { onConflict: ["person_id", "period"] })
            .select()
            .single();
          targetId = upserted?.id || insertPayload.id;
        }

        try {
          await supabase.from("payroll_activity_logs").insert([
            {
              id: generateUUID(),
              payroll_period_id: targetId,
              person_id: personId,
              person_name: record.person?.name || null,
              released_by: releasedBy,
              action: "Period Released",
              timestamp: nowIso,
            },
          ]);
        } catch (e) {}

        try {
          const historyPayload = {
            id: generateUUID(),
            payroll_period_id: targetId,
            person_id: personId,
            person_name: record.person?.name || null,
            department: record.person?.department || null,
            period: periodStr,
            days_present: record.payroll.daysPresent,
            daily_rate: Number(record.payroll.dailyRate ?? 0),
            late_penalty: Number(record.person?.late_penalty || 0),
            late_count: record.payroll.lateCount,
            gross: record.payroll.gross,
            total_late_deduction: record.payroll.totalLateDeduction,
            total_deductions: record.payroll.totalDeductions,
            net: record.payroll.net,
            detailed_attendance: record.attendance ? JSON.stringify(record.attendance) : "[]",
            released: true,
            action: "Period Released",
            released_by: releasedBy,
            released_at: nowIso,
          };

          const { data: existingHist } = await supabase
            .from("payroll_released_history")
            .select("id")
            .eq("payroll_period_id", targetId)
            .maybeSingle();

          if (existingHist) {
            await supabase
              .from("payroll_released_history")
              .update({
                action: "Period Released",
                released_by: releasedBy,
                released_at: nowIso,
              })
              .eq("payroll_period_id", targetId);
          } else {
            await supabase
              .from("payroll_released_history")
              .insert([historyPayload]);
          }
        } catch (e) {}

        successCount++;
      } catch (err) {
        console.error(`Error batch releasing payroll for ${record.personId}:`, err);
        failCount++;
      }
    }

    setReleasingAll(false);
    setPayrollPeriods((prev) =>
      prev.map((item) =>
        item.period === periodStr ? { ...item, released: true } : item
      )
    );

    Swal.fire({
      title: "Batch Release Completed",
      html: `
        <div style="font-size: 0.95rem;">
          <p><strong>${successCount}</strong> payslip(s) successfully released.</p>
          ${failCount > 0 ? `<p style="color: red; margin-top: 8px;">${failCount} payslip(s) could not be released.</p>` : ""}
        </div>
      `,
      icon: failCount > 0 ? "warning" : "success",
      confirmButtonColor: "#237227",
    });
  };



  // Expenses Modal Handlers
  const handleOpenExpensesModal = (record) => {
    setSelectedExpensesRecord(record);
    const [start] = (record.period || "").split("_to_");
    setNewExpDate(start || new Date().toISOString().slice(0, 10));
    setNewExpItem("");
    setNewExpAmount("");
    setNewExpNote("");
    setShowExpensesModal(true);
  };

  const handleCloseExpensesModal = () => {
    setShowExpensesModal(false);
    setSelectedExpensesRecord(null);
    setNewExpItem("");
    setNewExpAmount("");
    setNewExpDate("");
    setNewExpNote("");
  };

  const handleAddExpense = async (e) => {
    if (e) e.preventDefault();
    if (!selectedExpensesRecord) return;
    if (!newExpItem || !newExpItem.trim()) {
      Swal.fire("Required", "Please enter the expense / product name.", "warning");
      return;
    }
    const amt = Number(newExpAmount);
    if (isNaN(amt) || amt <= 0) {
      Swal.fire("Invalid Amount", "Please enter a valid positive expense amount.", "warning");
      return;
    }

    setExpActionLoading(true);
    try {
      const expDate = newExpDate || (selectedExpensesRecord.period ? selectedExpensesRecord.period.split("_to_")[0] : new Date().toISOString().slice(0, 10));
      const payload = {
        person_id: selectedExpensesRecord.person.id,
        period: selectedExpensesRecord.period || null,
        item_name: newExpItem.trim(),
        amount: amt,
        expense_date: expDate,
        note: newExpNote ? newExpNote.trim() : null,
      };

      const { data: inserted, error } = await supabase
        .from("expenses")
        .insert(payload)
        .select()
        .single();
      if (error) throw error;

      // Update local state
      const newEntry = inserted || { ...payload, id: Date.now() };
      const currentEntries = selectedExpensesRecord.expensesEntries || [];
      const updatedEntries = [...currentEntries, newEntry];
      const updatedTotalExpenses = Math.round(updatedEntries.reduce((s, r) => s + Number(r.amount || 0), 0) * 100) / 100;
      const baseGross = Number(selectedExpensesRecord.payroll?.gross || 0);
      const newTotalDeductions = Math.round(((selectedExpensesRecord.payroll?.totalDeductions || 0) + amt) * 100) / 100;
      const newNet = Math.max(0, Math.round((baseGross - newTotalDeductions) * 100) / 100);

      const updatedRecord = {
        ...selectedExpensesRecord,
        expenses: updatedTotalExpenses,
        expensesEntries: updatedEntries,
        payroll: {
          ...selectedExpensesRecord.payroll,
          expenses: updatedTotalExpenses,
          expensesEntries: updatedEntries,
          totalDeductions: newTotalDeductions,
          net: newNet,
        },
      };
      setSelectedExpensesRecord(updatedRecord);

      // Update in payrollPeriods
      setPayrollPeriods((prev) =>
        prev.map((item) => {
          if (
            item.person?.id === selectedExpensesRecord.person?.id &&
            item.period === selectedExpensesRecord.period
          ) {
            return updatedRecord;
          }
          return item;
        })
      );

      // Reset form
      setNewExpItem("");
      setNewExpAmount("");
      setNewExpNote("");

      Swal.fire({
        icon: "success",
        title: "Expense Added",
        text: `₱${amt.toFixed(2)} deducted from ${selectedExpensesRecord.person?.name}'s salary.`,
        timer: 1800,
        showConfirmButton: false,
      });
    } catch (err) {
      console.error("Error adding expense:", err);
      Swal.fire("Error", err.message || "Failed to add expense", "error");
    } finally {
      setExpActionLoading(false);
    }
  };

  const handleDeleteExpense = async (expenseId) => {
    const res = await Swal.fire({
      title: "Delete Expense?",
      text: "This expense deduction will be removed and added back to the employee's salary.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonColor: "#d33",
      cancelButtonColor: "#3085d6",
      confirmButtonText: "Yes, delete",
    });
    if (!res.isConfirmed) return;

    try {
      const { error } = await supabase
        .from("expenses")
        .delete()
        .eq("id", expenseId);
      if (error) throw error;

      const currentEntries = selectedExpensesRecord.expensesEntries || [];
      const targetEntry = currentEntries.find((e) => e.id === expenseId);
      const deductedAmt = Number(targetEntry?.amount || 0);
      const updatedEntries = currentEntries.filter((e) => e.id !== expenseId);
      const updatedTotalExpenses = Math.round(updatedEntries.reduce((s, r) => s + Number(r.amount || 0), 0) * 100) / 100;
      const baseGross = Number(selectedExpensesRecord.payroll?.gross || 0);
      const newTotalDeductions = Math.max(0, Math.round(((selectedExpensesRecord.payroll?.totalDeductions || 0) - deductedAmt) * 100) / 100);
      const newNet = Math.max(0, Math.round((baseGross - newTotalDeductions) * 100) / 100);

      const updatedRecord = {
        ...selectedExpensesRecord,
        expenses: updatedTotalExpenses,
        expensesEntries: updatedEntries,
        payroll: {
          ...selectedExpensesRecord.payroll,
          expenses: updatedTotalExpenses,
          expensesEntries: updatedEntries,
          totalDeductions: newTotalDeductions,
          net: newNet,
        },
      };
      setSelectedExpensesRecord(updatedRecord);

      setPayrollPeriods((prev) =>
        prev.map((item) => {
          if (
            item.person?.id === selectedExpensesRecord.person?.id &&
            item.period === selectedExpensesRecord.period
          ) {
            return updatedRecord;
          }
          return item;
        })
      );

      Swal.fire({
        icon: "success",
        title: "Deleted",
        text: "Expense removed successfully.",
        timer: 1500,
        showConfirmButton: false,
      });
    } catch (err) {
      console.error("Error deleting expense:", err);
      Swal.fire("Error", "Failed to delete expense", "error");
    }
  };

  // OPEN PAYSLIP for a period
  const handleShowPayslip = (payrollPeriod) => {
    const { person, payroll, attendance, period } = payrollPeriod;
    const detailedAttendance = getDetailedAttendance(
      attendance,
      person.id,
      settings,
    );
    setSelected({
      person,
      payslip: payroll,
      detailedAttendance,
      period,
    });
    setShowPayslip(true);
  };



  const handleClosePayslip = () => {
    setShowPayslip(false);
    setSelected(null);
  };

  const handlePrintPayslip = () => {
    if (!selected) return;

    const printWindow = window.open("", "_blank");

    printWindow.document.write(
      document.querySelector(".payslip-container")?.outerHTML || "",
    );

    printWindow.document.close();
    printWindow.print();
  };

  // Generate one combined PDF containing payslips for all payroll records
  const handleGenerateAllPayslipPdf = async () => {
    if (!payrollPeriods.length) {
      Swal.fire(
        "No payroll records",
        "There are no payroll records to generate.",
        "info",
      );
      return;
    }

    const pdfParamsList = [];

    for (const periodEntry of payrollPeriods) {
      try {
        const { person, payroll, attendance, period } = periodEntry;
        if (!person || !payroll) continue;

        const detailedAttendance = getDetailedAttendance(
          attendance,
          person.id,
          settings,
        );

        const formatYMD = (val) => {
          if (!val) return "";
          if (typeof val === "string") {
            const trimmed = val.trim();
            const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (m) return `${m[1]}-${m[2]}-${m[3]}`;
            const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
            if (slash) {
              return `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
            }
          }
          try {
            const d = val instanceof Date ? val : new Date(val);
            if (!isNaN(d.getTime())) {
              return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            }
          } catch (e) {}
          return "";
        };

        let absentDates = [];
        if (period) {
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
            }
          }

          const todayStr = formatYMD(new Date());

          if (startDate && endDate && !isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
            const allDates = [];
            for (
              let d = new Date(startDate);
              d <= endDate;
              d.setDate(d.getDate() + 1)
            ) {
              if (d.getDay() !== 0 && d.getDay() !== 6) {
                const ds = formatYMD(d);
                if (ds) allDates.push(ds);
              }
            }

            const attendedDates = detailedAttendance.map((a) => formatYMD(a.date || a.device_time)).filter(Boolean);

            absentDates = allDates.filter(
              (dateStr) =>
                dateStr < todayStr && !attendedDates.includes(dateStr),
            );
          }
        }
        const absentCount = absentDates.length;

        let holidayDetails = [];
        try {
          if (person && period) {
            const [start, end] = period.split("_to_");
            const { data: holidays, error } = await supabase
              .from("holidays")
              .select("*")
              .or(`department.eq.${person.department},department.is.null`)
              .gte("date", start)
              .lte("date", end);
            if (error) throw error;
            holidayDetails = holidays || [];
          }
        } catch (err) {
          console.error("Error fetching holidays for bulk PDF:", err);
          holidayDetails = [];
        }

        const deptRate =
          deptRates.find(
            (d) =>
              (d.department || "").toLowerCase().trim() ===
              (person.department || "").toLowerCase().trim(),
          ) || {};

        const deptHolidayRates = {
          regular: Number(
            deptRate.regular_holiday_rate ?? deptRate.holiday_rate ?? 100,
          ),
          special: Number(deptRate.special_holiday_rate ?? 30),
        };

        let holidayPayDetails = [];
        let totalHolidayPay = 0;
        if (holidayDetails.length > 0) {
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

        // Fetch cash advance entries for this person within the period (for accurate per-period deduction)
        let cashAdvanceEntries = [];
        let cashAdvanceTotalInPeriod = 0;
        try {
          if (person && period) {
            const [start, end] = period.split("_to_");
            const { data: caData, error: caErr } = await supabase
              .from("cash_advances")
              .select("id, amount, created_at, note")
              .eq("person_id", person.id)
              .gte("created_at", start)
              .lte("created_at", end)
              .order("created_at", { ascending: true });
            if (caErr) throw caErr;
            cashAdvanceEntries = caData || [];
            cashAdvanceTotalInPeriod = cashAdvanceEntries.reduce(
              (s, r) => s + Number(r.amount || 0),
              0,
            );
          }
        } catch (err) {
          console.error("Error fetching cash advances for bulk PDF:", err);
          cashAdvanceEntries = [];
          cashAdvanceTotalInPeriod = 0;
        }

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
          {
            label: "Cash Advance",
            value: Number(cashAdvanceTotalInPeriod || 0),
          },
        ];

        const lateCountLimit =
          payroll.lateCountLimit || payroll.late_count_limit || 5;
        const latePenalty = person.late_penalty || 0;
        const lateDeduction =
          payroll.lateCount >= lateCountLimit
            ? payroll.lateCount * latePenalty
            : 0;
        const totalDeductions =
          lateDeduction + deductions.reduce((acc, d) => acc + d.value, 0);

        // compute total OT hours (decimal) for this period to include in PDF
        let totalOtMinutes = 0;
        try {
          const sched = payroll && payroll.settings ? payroll.settings : {};
          const schedMorningEnd = sched.morning_end || "12:00";
          const schedAfternoonEnd = sched.afternoon_end || "17:00";
          (detailedAttendance || []).forEach((rec) => {
            try {
              const mOut =
                (rec.morningOut && String(rec.morningOut).trim()) || null;
              const aOut =
                (rec.afternoonOut && String(rec.afternoonOut).trim()) || null;
              // parse time HH:MM into minutes
              const parseT = (t) => {
                if (!t) return null;
                const mm = String(t)
                  .trim()
                  .match(/^(\d{1,2}):(\d{2})/);
                if (!mm) return null;
                return Number(mm[1]) * 60 + Number(mm[2]);
              };
              const mOutMin = parseT(mOut);
              const aOutMin = parseT(aOut);
              const mEndMin = parseT(schedMorningEnd);
              const aEndMin = parseT(schedAfternoonEnd);
              if (
                typeof mOutMin === "number" &&
                typeof mEndMin === "number" &&
                mOutMin > mEndMin
              )
                totalOtMinutes += mOutMin - mEndMin;
              if (
                typeof aOutMin === "number" &&
                typeof aEndMin === "number" &&
                aOutMin > aEndMin
              )
                totalOtMinutes += aOutMin - aEndMin;
            } catch (e) {}
          });
        } catch (e) {}
        const totalOtHours = Math.round((totalOtMinutes / 60) * 100) / 100;

        pdfParamsList.push({
          payroll,
          person,
          period,
          holidayPayDetails,
          totalHolidayPay,
          absentCount,
          totalDeductions,
          cashAdvanceEntries,
          cashAdvanceTotalInPeriod,
          expensesEntries: periodEntry.expensesEntries || [],
          expensesTotalInPeriod: periodEntry.expenses || payroll.expenses || 0,
          otHours: totalOtHours,
        });
      } catch (err) {
        console.error(
          "Failed to prepare payslip PDF data for",
          periodEntry.person?.name,
          err,
        );
      }
    }

    if (!pdfParamsList.length) {
      Swal.fire(
        "No data",
        "Could not prepare any payslip data for PDF.",
        "warning",
      );
      return;
    }

    const currentPeriodStr =
      startDate && endDate
        ? `${startDate}_to_${endDate}`
        : (payrollPeriods[0]?.period || "");
    await generateAllPayslipsPdf(pdfParamsList, currentPeriodStr);
    Swal.fire(
      "PDF generated",
      `A combined PDF with all payslips for ${formatPeriod(currentPeriodStr) || "the active period"} has been downloaded.`,
      "success",
    );
  };

  const handleExportPayslipExcel = () => {
    const listToExport = filteredPayrollPeriods.length ? filteredPayrollPeriods : payrollPeriods;
    if (!listToExport || !listToExport.length) return;
    const currentPeriodStr =
      startDate && endDate
        ? `${startDate}_to_${endDate}`
        : (listToExport[0]?.period || "");

    const exportData = listToExport.map((p) => {
      const { person, payroll } = p;
      return {
        "Person ID": person.id || "",
        "Employee Name": person.name || "",
        Department: person.department || "",
        "Daily Rate (₱)": person.daily_rate ?? 0,
        "Late Penalty (₱)": person.late_penalty ?? 0,
        "Days Present": payroll.daysPresent ?? 0,
        "Absent Count": p.absentCount ?? 0,
        "Late Count": payroll.lateCount ?? 0,
        "Gross Pay (₱)": payroll.gross ?? 0,
        "Late Deduction (₱)": payroll.totalLateDeduction ?? 0,
        "Expenses (₱)": p.expenses ?? payroll.expenses ?? 0,
        "SSS (Employee) (₱)": payroll.sss ?? 0,
        "Pag-ibig (Employee) (₱)": payroll.pag_ibig ?? 0,
        "PhilHealth (Employee) (₱)": payroll.philhealth ?? 0,
        "Total Deductions (₱)": payroll.totalDeductions ?? 0,
        "Net Pay (₱)": payroll.net ?? 0,
        "SSS (Employer) (₱)": payroll.sss_employer ?? 0,
        "Pag-ibig (Employer) (₱)": payroll.pag_ibig_employer ?? 0,
        "PhilHealth (Employer) (₱)": payroll.philhealth_employer ?? 0,
        "Total Employer Share (₱)": payroll.totalEmployerShare ?? 0,
        "Total Company Cost (₱)": (Number(payroll.gross || 0) + Number(payroll.totalEmployerShare || 0)),
      };
    });
    if (exportData.length === 0) return;
    const ws = XLSX.utils.json_to_sheet(exportData);

    const colWidths = Object.keys(exportData[0]).map((key) => {
      let maxLen = key ? String(key).length : 10;
      exportData.forEach((row) => {
        const val = row[key];
        if (val !== undefined && val !== null) {
          const len = String(val).length;
          if (len > maxLen) maxLen = len;
        }
      });
      return { wch: Math.max(maxLen + 4, 14) };
    });
    ws["!cols"] = colWidths;
    if (ws["!ref"]) ws["!autofilter"] = { ref: ws["!ref"] };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Payroll Summary");
    const filename = currentPeriodStr
      ? `payroll_summary_${String(currentPeriodStr).replace(/[^\w-]/g, "_")}.xlsx`
      : "payroll_summary.xlsx";
    XLSX.writeFile(wb, filename);
  };

  // Compute filtered and sorted payroll periods for display
  const filteredPayrollPeriods = (payrollPeriods || [])
    .filter((entry) => {
      if (!entry) return false;
      const { person } = entry;
      if (!person) return false;
      // Department filter
      if (departmentFilter && (person.department || "") !== departmentFilter)
        return false;
      // Search (by name or id)
      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        const idMatch = String(person.id || "")
          .toLowerCase()
          .includes(q);
        const nameMatch = (person.name || "").toLowerCase().includes(q);
        return idMatch || nameMatch;
      }
      return true;
    })
    .sort((a, b) => {
      const nameA = (a.person?.name || "").toLowerCase();
      const nameB = (b.person?.name || "").toLowerCase();
      if (nameA < nameB) return sortOrder === "asc" ? -1 : 1;
      if (nameA > nameB) return sortOrder === "asc" ? 1 : -1;
      // fallback to id
      const idA = String(a.person?.id || "");
      const idB = String(b.person?.id || "");
      return sortOrder === "asc"
        ? idA.localeCompare(idB)
        : idB.localeCompare(idA);
    });

  // Summary calculations across current filtered records
  const totalEmployeesCount = filteredPayrollPeriods.length;
  const totalNetPayout = filteredPayrollPeriods.reduce((acc, p) => acc + Number(p.payroll?.net || 0), 0);
  const totalEmployerShare = filteredPayrollPeriods.reduce((acc, p) => acc + Number(p.payroll?.totalEmployerShare || 0), 0);
  const totalGrossPay = filteredPayrollPeriods.reduce((acc, p) => acc + Number(p.payroll?.gross || 0), 0);
  const totalCompanyCost = totalGrossPay + totalEmployerShare;

  // Pagination logic
  const activeRecords = filteredPayrollPeriods;
  const totalRecords = activeRecords.length;
  const totalPages = Math.ceil(totalRecords / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentRecords = activeRecords.slice(startIndex, startIndex + itemsPerPage);

  return (
    <div className="payroll-page-container mx-auto pt-0 pb-6 px-0 max-w-full bg-white min-h-screen text-gray-800 font-sans">
      <style>{`
        .payroll-page-container button,
        .payroll-page-container button:hover,
        .payroll-page-container button:focus,
        .payroll-page-container button:active,
        .payroll-page-container svg,
        .payroll-page-container span,
        .payroll-page-container * {
          transform: none !important;
        }
        .payroll-page-container button:hover {
          box-shadow: none !important;
        }
        .payroll-page-container input:focus,
        .payroll-page-container select:focus {
          border-color: #dce3dd !important;
          outline: none !important;
          box-shadow: none !important;
        }
        .payroll-page-container button:focus,
        .payroll-page-container button:focus-visible,
        .payroll-page-container *:focus {
          outline: none !important;
          box-shadow: none !important;
        }
      `}</style>
      <div className="mb-6 flex flex-col items-start gap-1.5">
        <h1 className="text-[2.5rem] font-extrabold m-0 tracking-[-0.02em] inline-block">
          <span className="text-[#2c382d]">Payroll </span>
          <span className="text-[#237227]">Summary</span>
        </h1>
      </div>

      {/* Unified Payroll Cutoff Period Selector */}
      <div className="bg-white p-5 rounded-2xl border border-[#edf2ee] shadow-[0_2px_8px_rgba(0,0,0,0.04)] mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#237227]/10 flex items-center justify-center text-[#237227] shrink-0">
              <FiCalendar size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-800 m-0">Payroll Cutoff Period</h2>
              <p className="text-xs text-gray-500 m-0 mt-0.5">
                Set cutoff period for all employees. Attendance, overtime, and payslips will adjust automatically.
              </p>
            </div>
          </div>

          {/* Quick Cutoff Preset Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handlePrevPeriod}
              title="Previous Period"
              className="p-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 cursor-pointer text-xs font-semibold inline-flex items-center transition-colors"
            >
              <FiChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => handlePresetCutoff("1-15")}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border transition-colors ${
                isPresetActive("1-15")
                  ? "!bg-[#237227] !text-white !border-[#237227]"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
              }`}
            >
              1st – 15th
            </button>
            <button
              type="button"
              onClick={() => handlePresetCutoff("16-end")}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border transition-colors ${
                isPresetActive("16-end")
                  ? "!bg-[#237227] !text-white !border-[#237227]"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
              }`}
            >
              16th – End
            </button>
            <button
              type="button"
              onClick={() => handlePresetCutoff("month")}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border transition-colors ${
                isPresetActive("month")
                  ? "!bg-[#237227] !text-white !border-[#237227]"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
              }`}
            >
              Full Month
            </button>
            <button
              type="button"
              onClick={handleNextPeriod}
              title="Next Period"
              className="p-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 cursor-pointer text-xs font-semibold inline-flex items-center transition-colors"
            >
              <FiChevronRight size={16} />
            </button>
          </div>
        </div>

        {/* Date Inputs, Recalculate button & options */}
        <div className="mt-4 pt-3.5 border-t border-gray-100 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold uppercase text-gray-600 tracking-wider">From:</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="py-1.5 px-3 text-sm rounded-lg border border-gray-300 bg-white text-gray-800 outline-none focus:border-[#237227]"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold uppercase text-gray-600 tracking-wider">To:</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="py-1.5 px-3 text-sm rounded-lg border border-gray-300 bg-white text-gray-800 outline-none focus:border-[#237227]"
              />
            </div>
            <button
              type="button"
              onClick={handleApplyPeriod}
              disabled={isRecalculating || !startDate || !endDate}
              className="inline-flex items-center gap-1.5 py-1.5 px-4 rounded-lg text-sm font-semibold bg-[#237227] text-white border-none cursor-pointer hover:bg-[#1e6121] disabled:opacity-50 transition-all shadow-[0_1px_4px_rgba(35,114,39,0.2)]"
            >
              <FiRefreshCw className={isRecalculating ? "animate-spin" : ""} size={14} />
              {isRecalculating ? "Calculating..." : "Apply Period"}
            </button>
          </div>

          {/* Active Period Display Badge */}
          <div className="bg-[#237227]/10 text-[#237227] px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5">
            <FiCheckCircle size={14} />
            <span>Active Period: {formatPeriod(`${startDate}_to_${endDate}`)}</span>
          </div>
        </div>
      </div>

      {/* Executive Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white p-4 rounded-xl border border-[#edf2ee] shadow-[0_1px_4px_rgba(0,0,0,0.04)] flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-green-50 flex items-center justify-center text-[#237227] shrink-0">
            <FiDollarSign className="text-2xl" />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Total Employee Net Payout
            </div>
            <div className="text-xl font-bold text-gray-800">
              ₱{totalNetPayout.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="text-[0.75rem] text-gray-400">
              {totalEmployeesCount} employee record(s)
            </div>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-[#edf2ee] shadow-[0_1px_4px_rgba(0,0,0,0.04)] flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 shrink-0">
            <FiBriefcase className="text-2xl" />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Total Employer Share (Company Paid)
            </div>
            <div className="text-xl font-bold text-blue-700">
              ₱{totalEmployerShare.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="text-[0.75rem] text-gray-400">
              SSS, PhilHealth, Pag-IBIG contributions
            </div>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-[#edf2ee] shadow-[0_1px_4px_rgba(0,0,0,0.04)] flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center text-purple-600 shrink-0">
            <FiUsers className="text-2xl" />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Total Company Payroll Cost
            </div>
            <div className="text-xl font-bold text-purple-800">
              ₱{totalCompanyCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="text-[0.75rem] text-gray-400">
              Gross Salaries + Employer Contributions
            </div>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-nowrap justify-between items-center gap-3.5 mb-5 py-3 px-4 bg-white rounded-xl border border-[#edf2ee] shadow-[0_1px_4px_rgba(0,0,0,0.04)] overflow-x-auto">
        <div className="flex flex-nowrap gap-2.5 items-center">
          <div className="relative">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none" />
            <input
              type="text"
              placeholder="Search by name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="py-2 pr-3.5 pl-9 text-[0.85rem] rounded-md border border-[#dce3dd] bg-white text-[#2c382d] min-w-[180px] outline-none focus:outline-none focus:border-[#dce3dd] focus:ring-0"
            />
          </div>
          <select
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            className="py-2 px-3 text-[0.85rem] rounded-md border border-[#dce3dd] bg-white text-[#2c382d] cursor-pointer min-w-[130px] outline-none focus:outline-none focus:border-[#dce3dd] focus:ring-0"
          >
            <option value="">All Departments</option>
            {Array.from(
              new Set(persons.map((p) => p.department).filter(Boolean)),
            ).map((dept) => (
              <option key={dept} value={dept}>
                {dept}
              </option>
            ))}
          </select>
          <button
            aria-label="Toggle sort order"
            onClick={() => setSortOrder((s) => (s === "asc" ? "desc" : "asc"))}
            className="py-2 px-4 rounded-md bg-[#237227] border-none text-white text-[0.85rem] cursor-pointer min-w-[60px] text-center font-semibold outline-none focus:outline-none"
          >
            {sortOrder === "asc" ? "Asc" : "Desc"}
          </button>
        </div>
        <div className="flex gap-2.5 flex-wrap items-center">
          <button
            onClick={handleReleaseAllPeriodPayroll}
            disabled={payrollPeriods.filter((p) => !p.released).length === 0 || releasingAll}
            className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-[0.85rem] font-semibold border-none cursor-pointer tracking-[0.01em] whitespace-nowrap bg-[#166534] text-white shadow-[0_1px_4px_rgba(22,101,52,0.2)] hover:bg-[#14532d] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
            title={
              payrollPeriods.filter((p) => !p.released).length > 0
                ? `Release payslips for all ${payrollPeriods.filter((p) => !p.released).length} pending employee(s)`
                : "All payslips for this period are already released"
            }
          >
            <FiSend className="mr-1" />
            {releasingAll
              ? "Releasing..."
              : payrollPeriods.filter((p) => !p.released).length > 0
              ? `Release All (${payrollPeriods.filter((p) => !p.released).length})`
              : "All Released"}
          </button>
          <button
            onClick={handleExportPayslipExcel}
            className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-[0.85rem] font-semibold border-none cursor-pointer tracking-[0.01em] whitespace-nowrap bg-[#237227] text-white shadow-[0_1px_4px_rgba(35,114,39,0.2)] transition-all duration-200"
            title="Export Excel"
          >
            {Icons.download} Export Excel
          </button>
          <button
            onClick={handleGenerateAllPayslipPdf}
            className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-[0.85rem] font-semibold border-none cursor-pointer tracking-[0.01em] whitespace-nowrap bg-[#237227] text-white shadow-[0_1px_4px_rgba(35,114,39,0.2)] transition-all duration-200"
            title="Generate All Payslips PDF"
          >
            <FiPrinter className="mr-1" />
            Generate All Payslips PDF
          </button>
        </div>
      </div>

      {/* Table: Payroll for Selected Period */}
      <div className="rounded-2xl overflow-hidden bg-white shadow-[0_2px_14px_rgba(44,56,45,0.06)] border-none">
        <div className="overflow-x-auto max-h-[600px]">
          <table className="w-full border-collapse text-[0.95rem] min-w-[1250px]">
            <thead>
              <tr>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">ID</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Name</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Department</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Period</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Daily Rate (₱)</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Late Penalty (₱)</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Days Present</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Late Count</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Absent</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Expenses (₱)</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Status</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {currentRecords.length === 0 ? (
                <tr>
                  <td colSpan={12} className="text-center py-16 px-5 text-gray-500 text-base">
                    No payroll records found for this period.
                  </td>
                </tr>
              ) : (
                currentRecords.map((p, idx) => {
                  const { person, period, payroll } = p;
                  return (
                    <tr key={person.id + period} className="even:bg-[#f9fafb] odd:bg-white">
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800 font-mono">
                        {person.id}
                      </td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">{person.name}</td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">{person.department}</td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">{formatPeriod(period)}</td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">
                        {person.daily_rate != null
                          ? `₱${Number(person.daily_rate).toFixed(2)}`
                          : "N/A"}
                      </td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">
                        {person.late_penalty != null
                          ? `₱${Number(person.late_penalty).toFixed(2)}`
                          : "N/A"}
                      </td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">{payroll.daysPresent}</td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">{payroll.lateCount}</td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">{p.absentCount ?? 0}</td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800 whitespace-nowrap">
                        <span className={`text-sm ${Number(p.expenses || p.payroll?.expenses || 0) > 0 ? "text-red-600 font-semibold" : "text-gray-500 font-medium"}`}>
                          ₱{Number(p.expenses || p.payroll?.expenses || 0).toFixed(2)}
                        </span>
                      </td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">
                        {p.released ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                            <FiCheckCircle size={13} /> Released
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                              <FiClock size={13} /> Pending
                            </span>
                            <button
                              onClick={() => handleReleasePayroll(p)}
                              className="py-1 px-2.5 rounded-md border-none text-[0.78rem] font-semibold cursor-pointer transition-all duration-200 inline-flex items-center gap-1 bg-[#237227] text-white hover:bg-[#1b5e20] shadow-sm whitespace-nowrap"
                              title="Release payslip for this employee"
                            >
                              <FiSend size={11} /> Release
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 whitespace-nowrap">
                          <button
                            onClick={() => handleOpenExpensesModal(p)}
                            className="py-1.5 px-2.5 rounded-md border border-[#237227]/30 text-xs font-semibold cursor-pointer transition-all duration-200 inline-flex items-center gap-1 bg-[#237227]/10 text-[#237227] hover:bg-[#237227] hover:text-white whitespace-nowrap"
                            title="Add or manage employee expenses for this period"
                          >
                            <FiPlus size={12} /> Expense
                          </button>
                          <button
                            onClick={() => handleShowPayslip(p)}
                            className="py-1.5 px-3 rounded-md border-none text-xs font-semibold cursor-pointer transition-all duration-200 inline-flex items-center gap-1.5 bg-[#237227] text-white hover:bg-[#1b5e20] whitespace-nowrap shadow-sm"
                          >
                            {Icons.eye} View
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="flex justify-between items-center py-4 px-5 bg-white border-t border-[#edf2ee] rounded-b-xl">
          <div className="text-gray-500 text-sm">
            Showing <strong>{totalRecords === 0 ? 0 : startIndex + 1}</strong> to <strong>{Math.min(startIndex + itemsPerPage, totalRecords)}</strong> of <strong>{totalRecords}</strong> records
          </div>
          <div className="flex gap-1.5 items-center">
            <button 
              className="flex items-center justify-center min-w-[32px] h-8 px-1.5 rounded-lg border border-gray-300 bg-white text-gray-500 text-[0.85rem] font-semibold cursor-pointer transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              &lt;
            </button>
            
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(currentPage - p) <= 1)
              .map((p, idx, arr) => {
                const renderButton = (
                  <button
                    key={p}
                    className={`flex items-center justify-center min-w-[32px] h-8 px-1.5 rounded-lg border text-[0.85rem] font-semibold cursor-pointer transition-all duration-200 ${p === currentPage ? '!bg-[#237227] !text-white !border-[#237227]' : 'border-gray-300 bg-white text-gray-500'}`}
                    onClick={() => setCurrentPage(p)}
                  >
                    {p}
                  </button>
                );

                if (idx > 0 && arr[idx] - arr[idx - 1] > 1) {
                  return (
                    <div key={`group-${p}`} className="flex items-center gap-1.5">
                      <span className="text-[#677368] px-0.5">...</span>
                      {renderButton}
                    </div>
                  );
                }
                return renderButton;
              })}
            
            <button 
              className="flex items-center justify-center min-w-[32px] h-8 px-1.5 rounded-lg border border-gray-300 bg-white text-gray-500 text-[0.85rem] font-semibold cursor-pointer transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              &gt;
            </button>
          </div>
        </div>
      </div>

      {/* Expenses Management Modal */}
      {showExpensesModal && selectedExpensesRecord && (
        <div className="fixed inset-0 w-full h-full bg-black/50 flex justify-center items-center z-[1000] backdrop-blur-[4px]">
          <div className="bg-white text-gray-800 p-6 md:p-8 rounded-[24px] max-w-[650px] w-[95%] overflow-y-auto max-h-[90%] shadow-[0_20px_40px_rgba(0,0,0,0.2)] border border-gray-200 font-sans">
            <div className="flex justify-between items-start mb-4 border-b border-gray-100 pb-3">
              <div>
                <h2 className="text-xl font-bold text-[#237227] m-0 flex items-center gap-2">
                  <FiShoppingBag className="text-[#237227]" />
                  Manage Employee Expenses
                </h2>
                <p className="text-sm text-gray-500 m-0 mt-1">
                  {selectedExpensesRecord.person?.name} • {selectedExpensesRecord.person?.department} (ID: {selectedExpensesRecord.person?.id})
                </p>
                <p className="text-xs font-semibold text-[#237227] m-0 mt-0.5">
                  Period: {formatPeriod(selectedExpensesRecord.period)}
                </p>
              </div>
              <button
                onClick={handleCloseExpensesModal}
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 bg-transparent border-none cursor-pointer"
              >
                <FiX size={20} />
              </button>
            </div>

            {/* Total Expenses Badge */}
            <div className="bg-red-50/70 border border-red-200 rounded-xl p-3.5 mb-5 flex justify-between items-center">
              <div>
                <span className="text-xs font-bold text-red-700 uppercase tracking-wide">
                  Total Expenses Deducted from Salary
                </span>
                <div className="text-2xl font-bold text-red-700 mt-0.5">
                  ₱{Number(selectedExpensesRecord.expenses || 0).toFixed(2)}
                </div>
              </div>
              <div className="text-right">
                <span className="text-xs font-medium text-gray-500 block">
                  Current Net Pay:
                </span>
                <span className="text-base font-bold text-[#237227]">
                  ₱{Number(selectedExpensesRecord.payroll?.net || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            {/* Add Expense Form */}
            <form onSubmit={handleAddExpense} className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6">
              <h3 className="text-xs font-bold uppercase text-gray-700 tracking-wide m-0 mb-3 flex items-center gap-1.5">
                <FiPlus className="text-[#237227]" />
                Add New Expense / Product Purchase
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    Item / Product Name *
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Uniform, Coffee, Company Goods"
                    value={newExpItem}
                    onChange={(e) => setNewExpItem(e.target.value)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-gray-300 bg-white outline-none focus:border-[#237227]"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    Amount (₱) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={newExpAmount}
                    onChange={(e) => setNewExpAmount(e.target.value)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-gray-300 bg-white outline-none focus:border-[#237227]"
                    required
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    Expense Date
                  </label>
                  <input
                    type="date"
                    value={newExpDate}
                    onChange={(e) => setNewExpDate(e.target.value)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-gray-300 bg-white outline-none focus:border-[#237227]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    Note / Remarks
                  </label>
                  <input
                    type="text"
                    placeholder="Optional remarks"
                    value={newExpNote}
                    onChange={(e) => setNewExpNote(e.target.value)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-gray-300 bg-white outline-none focus:border-[#237227]"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={expActionLoading}
                  className="py-2 px-5 rounded-lg text-sm font-semibold bg-[#237227] text-white border-none cursor-pointer inline-flex items-center gap-1.5 shadow-[0_1px_4px_rgba(35,114,39,0.2)] disabled:opacity-50"
                >
                  <FiPlus />
                  {expActionLoading ? "Adding..." : "Add Expense Deduction"}
                </button>
              </div>
            </form>

            {/* List of Existing Expenses for this Period */}
            <div className="mb-4">
              <h3 className="text-sm font-bold text-gray-800 m-0 mb-2.5">
                Recorded Expenses for this Period
              </h3>
              {selectedExpensesRecord.expensesEntries && selectedExpensesRecord.expensesEntries.length > 0 ? (
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="py-2.5 px-3 text-left font-semibold text-gray-600 text-xs uppercase">Item</th>
                        <th className="py-2.5 px-3 text-left font-semibold text-gray-600 text-xs uppercase">Date</th>
                        <th className="py-2.5 px-3 text-left font-semibold text-gray-600 text-xs uppercase">Amount</th>
                        <th className="py-2.5 px-3 text-center font-semibold text-gray-600 text-xs uppercase">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedExpensesRecord.expensesEntries.map((exp, idx) => (
                        <tr
                          key={exp.id || idx}
                          className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}
                        >
                          <td className="py-2.5 px-3 border-b border-gray-100 text-gray-800 font-medium">
                            {exp.item_name}
                            {exp.note && <div className="text-xs text-gray-400 font-normal">{exp.note}</div>}
                          </td>
                          <td className="py-2.5 px-3 border-b border-gray-100 text-gray-600 text-xs">
                            {exp.expense_date || (exp.created_at ? new Date(exp.created_at).toLocaleDateString() : "N/A")}
                          </td>
                          <td className="py-2.5 px-3 border-b border-gray-100 text-red-600 font-bold">
                            ₱{Number(exp.amount || 0).toFixed(2)}
                          </td>
                          <td className="py-2.5 px-3 border-b border-gray-100 text-center">
                            <button
                              type="button"
                              onClick={() => handleDeleteExpense(exp.id)}
                              className="p-1.5 text-red-500 hover:text-red-700 bg-transparent border-none cursor-pointer"
                              title="Delete expense"
                            >
                              <FiTrash2 size={15} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="py-8 text-center text-gray-400 text-sm border border-dashed border-gray-200 rounded-xl">
                  No expenses recorded for this employee in this payroll period.
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end pt-3 border-t border-gray-100">
              <button
                type="button"
                onClick={handleCloseExpensesModal}
                className="py-2 px-5 rounded-lg text-sm font-semibold bg-gray-100 text-gray-700 border border-gray-300 cursor-pointer hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payslip Modal */}
      {showPayslip && selected && (
        <PayslipModal
          payroll={selected.payslip}
          person={selected.person}
          daysWorked={selected.daysWorked}
          detailedAttendance={selected.detailedAttendance}
          onClose={handleClosePayslip}
          onPrint={handlePrintPayslip}
          showPrintButton={true}
          period={selected.period}
          released={(() => {
            const match = payrollPeriods.find(
              (p) =>
                p.person.id === selected.person.id &&
                p.period === selected.period,
            );
            return match ? match.released : false;
          })()}
          onRelease={() => {
            const match = payrollPeriods.find(
              (p) =>
                p.person.id === selected.person.id &&
                p.period === selected.period,
            );
            if (match) handleReleasePayroll(match);
          }}
        />
      )}
    </div>
  );
}