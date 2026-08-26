import React, { useEffect, useState } from "react";
// import { supabase } from './supabaseClient';
import Swal from "sweetalert2";
import { calculatePayroll } from "./Payroll";
import PayslipModal from "../AdminPage/PayslipModals/PayslipModal";
import { getDetailedAttendance } from "./attendanceDetails";
import { generateAllPayslipsPdf } from "./PayslipModals/generatePayslipPdf";
import { hasHolidayPayEligibility } from "../utils/holidayPayEligibility";
import * as XLSX from "xlsx";
import { FiSearch, FiEye, FiDownload, FiPrinter } from "react-icons/fi";

import { supabase } from "../supabaseClient";

export default function PayrollPage() {
  const [persons, setPersons] = useState([]);
  const [deptRates, setDeptRates] = useState([]);
  const [payrollPeriods, setPayrollPeriods] = useState([]); // [{personId, period, payroll, released}]
  const [, setHolidays] = useState([]);
  const [settings, setSettings] = useState({});
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [showPayslip, setShowPayslip] = useState(false);

  // Add filter, sort, export, and pagination state
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [sortOrder, setSortOrder] = useState("asc");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  useEffect(() => {
    setCurrentPage(1);
  }, [search, departmentFilter, sortOrder]);

  const Icons = {
    search: <FiSearch />,
    download: <FiDownload />,
    eye: <FiEye />,
  };

  useEffect(() => {
    async function fetchData() {
      const [
        attRes,
        personsRes,
        deptRes,
        settingsRes,
        payrollRes,
        holidaysRes,
      ] = await Promise.all([
        // Limit attendance to recent records (last 6 months) to reduce egress
        (function() {
          const cutoff = new Date();
          cutoff.setMonth(cutoff.getMonth() - 6);
          return supabase.from("attendance").select("*").gte('device_time', cutoff.toISOString());
        })(),
        supabase
          .from("persons")
          .select(
            "id, name, department, daily_rate, late_penalty, sss, pag_ibig, philhealth, cash_advance, registration_photo",
          ),
        supabase.from("department_rates").select("*"),
        supabase.from("settings").select("*").eq("id", 1).maybeSingle(),
        supabase.from("payroll_periods").select("*"),
        supabase.from("holidays").select("*"),
      ]);

      const attData = attRes.data || [];
      const personsData = personsRes.data || [];
      const deptData = deptRes.data || [];
      const settingsData = settingsRes.data || {};
      const holidaysData = holidaysRes.data || [];
      // Ensure payrollDb is always a clean array with no null/undefined entries
      const payrollDb = Array.isArray(payrollRes.data)
        ? payrollRes.data.filter(Boolean)
        : [];

      setPersons(personsData);
      setDeptRates(deptData);
      setSettings(settingsData);
      setHolidays(holidaysData);

      // Group attendance by person and by dynamic payroll period length
      let periods = [];
      const periodDays = Number(settingsData.payroll_period_days) || 15;
      personsData.forEach((person) => {
        // Get all attendance for this person (include both time-in and time-out)
        const personAttendance = attData.filter(
          (a) => a.person_id === person.id,
        );
        // Sort attendance by date
        const sortedAttendance = [...personAttendance].sort(
          (a, b) => new Date(a.device_time) - new Date(b.device_time),
        );
        if (!sortedAttendance.length) return;
        // Find the range of dates
        const firstDate = new Date(sortedAttendance[0].device_time);
        const lastDate = new Date(
          sortedAttendance[sortedAttendance.length - 1].device_time,
        );
        // Start from the firstDate, create periods of periodDays
        let periodStart = new Date(firstDate);
        while (periodStart <= lastDate) {
          let periodEnd = new Date(periodStart);
          periodEnd.setDate(periodEnd.getDate() + periodDays - 1);
          // Get all attendance in this period
          const periodAttendance = sortedAttendance.filter((a) => {
            const dt = new Date(a.device_time);
            return dt >= periodStart && dt <= periodEnd;
          });
          // Format period string: yyyy-mm-dd_to_yyyy-mm-dd
          const periodStr = `${periodStart
            .toISOString()
            .slice(0, 10)}_to_${periodEnd.toISOString().slice(0, 10)}`;
          // Check if this period is already released in payrollDb (defensive against unexpected null rows)
          const alreadyReleased = payrollDb.some(
            (row) =>
              row &&
              row.person_id === person.id &&
              row.period === periodStr &&
              row.released,
          );
          if (periodAttendance.length > 0 && !alreadyReleased) {
            periods.push({
              person,
              period: periodStr,
              attendance: periodAttendance,
            });
          }
          // Move to next period
          periodStart.setDate(periodStart.getDate() + periodDays);
        }
      });

      // Calculate payroll for each period and sync with DB
      const payrollPeriods = (
        await Promise.all(
          periods.map(async ({ person, period, attendance }) => {
            // Calculate payroll for this period only
            const basePayroll = calculatePayroll(
              attendance,
              [person],
              deptData,
              settingsData,
            )[0];
            const detailed = getDetailedAttendance(
              attendance,
              person.id,
              settingsData
            );

            // Re-calculate daysPresent to enforce exact hours worked
            let totalHoursWorked = 0;
            let totalOtHours = 0;
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

            const lunchStart = parseTime(settingsData.morning_end || "12:00") || 720;
            const lunchEnd = parseTime(settingsData.afternoon_start || "13:00") || 780;
            const lunchDuration = Math.max(0, lunchEnd - lunchStart);
            const schedAfternoonEnd = parseTime(settingsData.afternoon_end || "17:00") || 1020;
            const schedMorningEnd = lunchStart;

            detailed.forEach((rec) => {
              if (!rec.morningIn || !rec.afternoonOut) return;
              const scheduledStart = parseTime(settingsData.morning_start || "08:00") || 480;
              const aOut = parseTime(rec.afternoonOut);
              const mOut = parseTime(rec.morningOut);
              
              // Calculate OT (must be at least 1 hour to trigger)
              if (aOut !== null && aOut > schedAfternoonEnd) {
                const otMins = aOut - schedAfternoonEnd;
                if (otMins >= 60) {
                  totalOtHours += otMins / 60;
                }
              }
              if (mOut !== null && mOut > schedMorningEnd) {
                const otMins = mOut - schedMorningEnd;
                if (otMins >= 60) {
                  totalOtHours += otMins / 60;
                }
              }

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
            basePayroll.daysPresent = Number(Math.round((totalHoursWorked / 8) * 1000) / 1000) || 0;
            basePayroll.otHours = Number(Math.round(totalOtHours * 100) / 100) || 0;
            
            // Recalculate otPay based on correct exact hours
            const otHourlyRate = Number(basePayroll.otHourlyRate || (Number(basePayroll.dailyRate || 0) / 8));
            basePayroll.otPay = Number(Math.round(otHourlyRate * basePayroll.otHours * 100) / 100) || 0;
            
            basePayroll.gross = Number((Number(basePayroll.dailyRate || 0) * basePayroll.daysPresent) + basePayroll.otPay) || 0;

            const lateCount = detailed
              .map((rec) => rec.lateDetails || [])
              .flat().length;
            const latePenalty = Number(person.late_penalty || 0);
            const lateCountLimit = Number(settingsData.late_count_limit || 5);
            const totalLateDeduction =
              lateCount >= lateCountLimit ? lateCount * latePenalty : 0;
            const totalDeductions =
              Number(basePayroll.sss || 0) +
              Number(basePayroll.pag_ibig || 0) +
              Number(basePayroll.philhealth || 0) +
              Number(basePayroll.cashAdvance || 0) +
              totalLateDeduction;
            const net = basePayroll.gross - totalDeductions;
            // Find if this period exists in DB (defensive & avoid duplicates)
            let dbRow = null;
            try {
              const { data: existing, error: selErr } = await supabase
                .from("payroll_periods")
                .select("*")
                .eq("person_id", person.id)
                .eq("period", period)
                .limit(1)
                .maybeSingle();
              if (selErr)
                console.error("Error checking payroll_periods", selErr);
              if (existing) dbRow = existing;
            } catch (e) {
              console.error("Error querying payroll_periods", e);
            }

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
                if (!updErr && updated) {
                  dbRow = updated;
                }
              } catch (e) {
                console.error("Error updating payroll_periods", e);
              }
            } else if (!dbRow) {
              const payload = {
                person_id: person.id,
                period,
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
                // Try upsert using person_id+period as conflict target (safer against races)
                const { data: upserted, error: upsertErr } = await supabase
                  .from("payroll_periods")
                  .upsert([payload], { onConflict: ["person_id", "period"] })
                  .select()
                  .single();

                if (upsertErr) {
                  // Fallback to insert if upsert isn't supported or fails
                  const { data: inserted, error: insertError } = await supabase
                    .from("payroll_periods")
                    .insert([payload])
                    .select()
                    .single();
                  if (insertError || !inserted) {
                    console.error(
                      "Failed to insert payroll_periods row",
                      insertError || upsertErr,
                    );
                    return null;
                  }
                  dbRow = inserted;
                } else {
                  dbRow = upserted;
                }
              } catch (e) {
                console.error("Error upserting/inserting payroll_periods", e);
                return null;
              }
            }

            // Extra safety: if dbRow is still somehow null, skip this entry
            if (!dbRow) {
              return null;
            }

            return {
              personId: person.id,
              person,
              period,
              payroll: {
                ...basePayroll,
                lateCount,
                lateCountLimit,
                totalLateDeduction,
                totalDeductions,
                net,
              },
              attendance,
              released: !!dbRow.released,
              dbId: dbRow.id,
              // Compute absent count for the period (weekdays only, exclude holidays), up to today
              absentCount: (() => {
                try {
                  if (!period) return 0;
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

                  if (!startDate || !endDate || isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                    return 0;
                  }

                  const allDates = [];
                  for (
                    let d = new Date(startDate);
                    d <= endDate;
                    d.setDate(d.getDate() + 1)
                  ) {
                    // weekday only
                    if (d.getDay() === 0 || d.getDay() === 6) continue;
                    const dateStr = formatYMD(d);
                    if (dateStr) allDates.push(dateStr);
                  }

                  const attendedDatesSet = new Set(
                    (detailed || []).map((a) => formatYMD(a.date || a.device_time)).filter(Boolean),
                  );

                  // holidaysData is available in outer scope; filter to person's department
                  const holidaysForDept = (holidaysData || []).filter(
                    (h) =>
                      (h.department || "").toLowerCase().trim() ===
                      (person.department || "").toLowerCase().trim(),
                  );
                  const holidaySet = new Set(
                    (holidaysForDept || []).map((h) => formatYMD(h.date || h.holiday_date)).filter(Boolean),
                  );

                  const absentDates = allDates.filter(
                    (dateStr) =>
                      dateStr < todayStr &&
                      !attendedDatesSet.has(dateStr) &&
                      !holidaySet.has(dateStr),
                  );
                  return absentDates.length;
                } catch (e) {
                  return 0;
                }
              })(),
            };
          }),
        )
      ).filter(Boolean);

      setPayrollPeriods(payrollPeriods);
    }
    fetchData();
  }, []);

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

  // Helper: Check if period has ended based on work-hour settings
  function isPeriodEndedNow(period, settings) {
    if (!period) return false;
    const s = String(period).trim();
    const matches = Array.from(s.matchAll(/(\d{4}[-/]\d{2}[-/]\d{2})/g)).map(m => m[1]);
    if (!matches.length) return false;
    const endStr = matches[matches.length - 1].replace(/\//g, '-');
    const end = new Date(endStr);
    if (Number.isNaN(end.getTime())) return false;
    const now = new Date();
    // If the period end is today, compare to afternoon end time if available
    if (end.getFullYear() === now.getFullYear() && end.getMonth() === now.getMonth() && end.getDate() === now.getDate()) {
      try {
        const hhmm = (settings && settings.afternoon_end) || null;
        if (hhmm) {
          const parts = String(hhmm).split(":").map(Number);
          const h = Number.isFinite(parts[0]) ? parts[0] : 17;
          const m = Number.isFinite(parts[1]) ? parts[1] : 0;
          const endOfPeriod = new Date(end.getFullYear(), end.getMonth(), end.getDate(), h, m, 0, 0);
          return now >= endOfPeriod;
        }
      } catch (e) {}
      const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
      return now >= endOfDay;
    }
    // For non-today end dates, use end-of-day comparison
    const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
    return endOfDay <= now;
  }

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

  // RELEASE PAYROLL (by DB id) — works with filtered/sorted lists
  const handleReleasePayroll = async (dbId) => {
    const idx = payrollPeriods.findIndex((p) => p.dbId === dbId);
    if (idx === -1) return;
    const period = payrollPeriods[idx];
    if (!period || !period.dbId) return;
    
    // Determine if this is an advance release (period hasn't ended yet)
    const periodHasEnded = isPeriodEndedNow(period.period, settings);
    const isAdvanceRelease = !periodHasEnded;
    
    try {
      // Update released flag in Supabase
      const { error: updateErr } = await supabase
        .from("payroll_periods")
        .update({ released: true })
        .eq("id", period.dbId);
      if (updateErr) throw updateErr;

      setPayrollPeriods((prev) =>
        prev.map((p) => (p.dbId === dbId ? { ...p, released: true } : p)),
      );

      // Determine who released this payroll
      let releasedBy = "admin";
      try {
        const sessionStr = localStorage.getItem("sb-session");
        if (sessionStr) {
          const session = JSON.parse(sessionStr);
          if (session && session.user && session.user.email) {
            releasedBy = session.user.email;
          }
        }
      } catch (e) {}

      // Log activity with accurate action type
      try {
        await supabase.from("payroll_activity_logs").insert([
          {
            payroll_period_id: period.dbId,
            person_id: period.person?.id || null,
            person_name: period.person?.name || null,
            released_by: releasedBy,
            action: isAdvanceRelease ? "Advance Release" : "Period Released",
            timestamp: new Date().toISOString(),
          },
        ]);
      } catch (err) {
        Swal.fire("Failed to log payroll release", err.message || err, "error");
      }

      // Optionally auto-create the next payroll period
      try {
        if (settings && settings.auto_create_next_period) {
          const periodDays = Number(settings.payroll_period_days) || 15;
          const [, endStr] = (period.period || "").split("_to_");
          if (endStr) {
            const endDate = new Date(endStr);
            const nextStart = new Date(endDate);
            nextStart.setDate(nextStart.getDate() + 1);
            const nextEnd = new Date(nextStart);
            nextEnd.setDate(nextEnd.getDate() + periodDays - 1);
            const nextPeriodStr = `${nextStart.toISOString().slice(0, 10)}_to_${nextEnd
              .toISOString()
              .slice(0, 10)}`;

            const payload = {
              person_id: period.person.id,
              period: nextPeriodStr,
              days_present: 0,
              daily_rate: Number(period.person.daily_rate || 0),
              late_penalty: Number(period.person.late_penalty || 0),
              late_count: 0,
              gross: 0,
              total_late_deduction: 0,
              total_deductions: 0,
              net: 0,
              released: false,
            };

            // Upsert to avoid duplicates (onConflict person_id+period)
            let created = null;
            try {
              const { data: upserted, error: upsertErr } = await supabase
                .from("payroll_periods")
                .upsert([payload], { onConflict: ["person_id", "period"] })
                .select()
                .single();
              if (upsertErr) {
                const { data: inserted, error: insertErr } = await supabase
                  .from("payroll_periods")
                  .insert([payload])
                  .select()
                  .single();
                if (insertErr) throw insertErr;
                created = inserted;
              } else {
                created = upserted;
              }
            } catch (e) {
              console.error("Failed to create next payroll_periods row", e);
            }

            if (created && created.id) {
              setPayrollPeriods((prev) => [
                ...prev,
                {
                  personId: period.person.id,
                  person: period.person,
                  period: nextPeriodStr,
                  payroll: {
                    daysPresent: 0,
                    dailyRate: Number(payload.daily_rate || 0),
                    lateCount: 0,
                    lateCountLimit: Number(settings.late_count_limit || 5),
                    totalLateDeduction: 0,
                    totalDeductions: 0,
                    net: 0,
                  },
                  attendance: [],
                  released: false,
                  dbId: created.id,
                },
              ]);
            }
          }
        }
      } catch (e) {
        console.error("Error during auto-create next payroll period", e);
      }
    } catch (e) {
      console.error("Error releasing payroll", e);
      Swal.fire("Failed to release payroll", e.message || e, "error");
    }
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
              .eq("department", person.department)
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
            deptRate.regular_holiday_rate ?? deptRate.holiday_rate ?? 0,
          ),
          special: Number(deptRate.special_holiday_rate ?? 0),
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

    await generateAllPayslipsPdf(pdfParamsList);
    Swal.fire(
      "PDF generated",
      "A combined PDF with all payslips has been downloaded.",
      "success",
    );
  };

  // Export to Excel
  const handleExportPayslipExcel = () => {
    if (!payrollPeriods.length) return;
    // Export each payroll period as a row
    const exportData = payrollPeriods.map((p) => {
      const { person, period, payroll } = p;
      return {
        ID: person.id,
        Name: person.name,
        Department: person.department,
        Period: period,
        "Daily Rate": person.daily_rate,
        "Late Penalty": person.late_penalty,
        "Days Present": payroll.daysPresent,
        "Late Count": payroll.lateCount,
        Gross: payroll.gross,
        "Late Deduction": payroll.totalLateDeduction,
        "Net Pay": payroll.net,
        "Absent Count": p.absentCount ?? 0,
      };
    });
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Payroll");
    XLSX.writeFile(wb, "payroll_summary.xlsx");
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

  // Pagination logic
  const activeRecords = filteredPayrollPeriods;
  const totalRecords = activeRecords.length;
  const totalPages = Math.ceil(totalRecords / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentRecords = activeRecords.slice(startIndex, startIndex + itemsPerPage);

  return (
    <div className="payroll-page-container mx-auto py-9 px-7 max-w-full bg-white min-h-screen text-gray-800 font-sans">
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
        <div className="flex gap-2.5 flex-nowrap items-center">
          <button
            onClick={handleExportPayslipExcel}
            className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-[0.85rem] font-semibold border-none cursor-pointer tracking-[0.01em] whitespace-nowrap bg-[#237227] text-white shadow-[0_1px_4px_rgba(35,114,39,0.2)] transition-all duration-200"
          >
            {Icons.download} Export Excel
          </button>
          <button
            onClick={handleGenerateAllPayslipPdf}
            className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-[0.85rem] font-semibold border-none cursor-pointer tracking-[0.01em] whitespace-nowrap bg-[#237227] text-white shadow-[0_1px_4px_rgba(35,114,39,0.2)] transition-all duration-200"
          >
            <FiPrinter className="mr-1" />
            Generate All Payslips PDF
          </button>
        </div>
      </div>

      {/* Table: Payroll by 15-day period */}
      <div className="rounded-2xl overflow-hidden bg-white shadow-[0_2px_14px_rgba(44,56,45,0.06)] border-none">
        <div className="overflow-x-auto max-h-[600px]">
          <table className="w-full border-collapse text-[0.95rem] min-w-[1200px]">
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
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Payslip</th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold p-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">Advance Release</th>
              </tr>
            </thead>
            <tbody>
              {currentRecords.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-16 px-5 text-gray-500 text-base">
                    No payroll records found.
                  </td>
                </tr>
              ) : (
                currentRecords.map((p, idx) => {
                  const { person, period, payroll, released } = p;
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
                          : "-"}
                      </td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">
                        {person.late_penalty != null
                          ? `₱${Number(person.late_penalty).toFixed(2)}`
                          : "-"}
                      </td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">{payroll.daysPresent}</td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">{payroll.lateCount}</td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">{p.absentCount ?? 0}</td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">
                        <button
                          onClick={() => handleShowPayslip(p)}
                          className="py-1.5 px-3.5 rounded-md border-none text-[0.85rem] font-semibold cursor-pointer transition-all duration-200 inline-flex items-center gap-1.5 bg-[#237227] text-white"
                        >
                          {Icons.eye} View
                        </button>
                      </td>
                      <td className="py-3.5 px-3 border-b border-gray-200 text-gray-800">
                        {released ? (
                          <span className="text-[#556156] font-semibold">
                            ✔ Released
                          </span>
                        ) : (
                          <button
                            onClick={() => handleReleasePayroll(p.dbId)}
                            className="inline-flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-[0.85rem] font-semibold cursor-pointer tracking-[0.01em] whitespace-nowrap bg-white text-[#237227] border border-[#237227] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all duration-200"
                          >
                            Advance Release Payroll
                          </button>
                        )}
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
        />
      )}
    </div>
  );
}