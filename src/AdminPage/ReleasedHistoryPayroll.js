import React, { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import Swal from "sweetalert2";
import { supabase } from "../mysqlClient";
import PayslipModal from "./PayslipModals/PayslipModal";
import { getDetailedAttendance } from "./attendanceDetails";

import {
  FiDownload,
  FiSearch,
  FiCalendar,
  FiCheckCircle,
  FiDollarSign,
} from "react-icons/fi";

function formatPeriod(period) {
  if (!period) return "";
  try {
    const s = String(period).replace(/_/g, " ");
    const matches = Array.from(s.matchAll(/(\d{4}[-/]\d{2}[-/]\d{2})/g)).map(
      (m) => m[1]
    );
    if (matches.length >= 2) {
      const d1 = new Date(matches[0].replace(/\//g, "-"));
      const d2 = new Date(matches[1].replace(/\//g, "-"));
      if (!Number.isNaN(d1.getTime()) && !Number.isNaN(d2.getTime())) {
        const f1 = d1.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const f2 = d2.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return `${f1} - ${f2}`;
      }
    }
    return period;
  } catch (e) {
    return period;
  }
}

function getPeriodDateVal(periodStr) {
  if (!periodStr) return 0;
  const match = String(periodStr).match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
  if (match) {
    const t = new Date(match[1].replace(/\//g, "-")).getTime();
    if (!isNaN(t)) return t;
  }
  return 0;
}

export default function ReleasedHistoryPayroll() {
  const [releasedPayrolls, setReleasedPayrolls] = useState([]);
  const [activityLogsMap, setActivityLogsMap] = useState({});
  const [selected, setSelected] = useState(null);
  const [showPayslip, setShowPayslip] = useState(false);
  const [modalData, setModalData] = useState({
    loading: false,
    person: null,
    detailedAttendance: [],
    settings: {},
    payroll: null,
  });
  const [search, setSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [periodFilter, setPeriodFilter] = useState("");
  const [sortKey, setSortKey] = useState("period");
  const [sortOrder, setSortOrder] = useState("desc");

  useEffect(() => {
    async function fetchReleased() {
      // Fetch from payroll_released_history instead of payroll_periods
      const { data, error } = await supabase
        .from("payroll_released_history")
        .select("*")
        .order("released_at", { ascending: false })
        .limit(2000);
        
      if (error) {
        console.error("Error fetching released payrolls:", error);
      }

      const mappedData = (data || []).map((row) => ({
        ...row,
        person: {
          id: row.person_id,
          name: row.person_name,
          department: row.department,
        },
      }));
      setReleasedPayrolls(mappedData);

      // Fetch activity logs to get action type if needed, though released_action is also available
      try {
        const { data: logs } = await supabase
          .from("payroll_activity_logs")
          .select("payroll_period_id, action")
          .order("timestamp", { ascending: false });

        // Create a map of payroll_period_id -> action (most recent action)
        const logsMap = {};
        (logs || []).forEach((log) => {
          if (log.payroll_period_id && !logsMap[log.payroll_period_id]) {
            logsMap[log.payroll_period_id] = log.action;
          }
        });
        setActivityLogsMap(logsMap);
      } catch (err) {
        console.error("Error fetching activity logs:", err);
      }
    }
    fetchReleased();
  }, []);

  // Unique departments for filter dropdown
  const departmentOptions = [
    ...new Set(
      releasedPayrolls.map((p) => p.person?.department).filter(Boolean),
    ),
  ];

  // Unique cutoff periods for filter dropdown (sorted newest first)
  const periodOptions = Array.from(
    new Set(releasedPayrolls.map((p) => p.period).filter(Boolean))
  ).sort((a, b) => getPeriodDateVal(b) - getPeriodDateVal(a));

  // Filter pipeline: Search + Department + Payroll Cutoff Period
  const filteredPayrolls = releasedPayrolls.filter((p) => {
    const searchLower = search.toLowerCase();
    const matchesSearch =
      !search ||
      (p.person_id && p.person_id.toLowerCase().includes(searchLower)) ||
      (p.person?.name && p.person.name.toLowerCase().includes(searchLower)) ||
      (p.person?.department && p.person.department.toLowerCase().includes(searchLower)) ||
      (p.period && p.period.toLowerCase().includes(searchLower));

    const matchesDept = !departmentFilter || (p.person?.department || "") === departmentFilter;
    const matchesPeriod = !periodFilter || p.period === periodFilter;

    return matchesSearch && matchesDept && matchesPeriod;
  });

  // Sorting
  const sortedPayrollsFinal = [...filteredPayrolls].sort((a, b) => {
    if (sortKey === "period") {
      const aTime = getPeriodDateVal(a.period);
      const bTime = getPeriodDateVal(b.period);
      if (aTime !== bTime) {
        return sortOrder === "asc" ? aTime - bTime : bTime - aTime;
      }
      return sortOrder === "asc"
        ? (a.period || "").localeCompare(b.period || "")
        : (b.period || "").localeCompare(a.period || "");
    }
    if (sortKey === "released_at") {
      const aTime = a.released_at ? new Date(a.released_at).getTime() : 0;
      const bTime = b.released_at ? new Date(b.released_at).getTime() : 0;
      return sortOrder === "asc" ? aTime - bTime : bTime - aTime;
    }
    if (sortKey === "person_id") {
      const aVal = (a.person_id || "").toLowerCase();
      const bVal = (b.person_id || "").toLowerCase();
      return sortOrder === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    if (sortKey === "name") {
      const aVal = (a.person?.name || "").toLowerCase();
      const bVal = (b.person?.name || "").toLowerCase();
      return sortOrder === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    if (sortKey === "department") {
      const aVal = (a.person?.department || "").toLowerCase();
      const bVal = (b.person?.department || "").toLowerCase();
      return sortOrder === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    if (sortKey === "net") {
      const aVal = Number(a.net || 0);
      const bVal = Number(b.net || 0);
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
    }
    const aVal = (a[sortKey] || "").toString().toLowerCase();
    const bVal = (b[sortKey] || "").toString().toLowerCase();
    return sortOrder === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
  });

  // Sorting handler
  const handleSort = (key) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortOrder("asc");
    }
  };

  // Helper to open payslip modal with full data
  const handleViewPayslip = async (payroll) => {
    setModalData({
      loading: true,
      person: null,
      detailedAttendance: [],
      settings: {},
      payroll: null,
    });
    setShowPayslip(true);
    // Fetch person details
    const { data: person } = await supabase
      .from("persons")
      .select(
        "id, name, department, daily_rate, late_penalty, sss, pag_ibig, philhealth, cash_advance, registration_photo",
      )
      .eq("id", payroll.person_id)
      .single();
    // Fetch settings
    const { data: settings } = await supabase
      .from("settings")
      .select("*")
      .eq("id", 1)
      .single();
    // Fetch department rates
    const { data: deptRates } = await supabase
      .from("department_rates")
      .select(
        "department, daily_rate, late_penalty, sss, pag_ibig, philhealth, ot_rate, regular_holiday_rate, special_holiday_rate",
      );
    // Fetch attendance for this period
    let detailedAttendance = [];
    let fullPayroll = null;
    if (payroll.period && person) {
      // Parse period string: yyyy-mm-dd_to_yyyy-mm-dd

      const { data: attendance } = await supabase
        .from("attendance")
        .select("id, person_id, event, device_time, photo, status, method, archived")
        .eq("person_id", payroll.person_id)
        .eq("archived", 0)
        .order("device_time", { ascending: true });
      
      detailedAttendance = getDetailedAttendance(
        attendance || [],
        payroll.person_id,
        settings || {},
      );

      const deptRate = (deptRates || []).find((d) => (d.department || "").toLowerCase() === (person.department || "").toLowerCase()) || {};

      // Map the saved snake_case DB row to camelCase for the PayslipModal
      fullPayroll = {
        ...payroll,
        dailyRate: Number(payroll.daily_rate || 0),
        daysPresent: Number(payroll.days_present || 0),
        gross: Number(payroll.gross || 0),
        net: Number(payroll.net || 0),
        lateCount: Number(payroll.late_count || 0),
        lateCountLimit: Number(settings?.late_count_limit || 5),
        totalLateDeduction: Number(payroll.total_late_deduction || 0),
        totalDeductions: Number(payroll.total_deductions || 0),
        sss: person.sss ? Number(deptRate.sss || 0) : 0,
        pag_ibig: person.pag_ibig ? Number(deptRate.pag_ibig || 0) : 0,
        philhealth: person.philhealth ? Number(deptRate.philhealth || 0) : 0,
        sss_employer: person.sss ? Number(deptRate.sss_employer || 0) : 0,
        pag_ibig_employer: person.pag_ibig ? Number(deptRate.pag_ibig_employer || 0) : 0,
        philhealth_employer: person.philhealth ? Number(deptRate.philhealth_employer || 0) : 0,
        totalEmployerShare:
          (person.sss ? Number(deptRate.sss_employer || 0) : 0) +
          (person.pag_ibig ? Number(deptRate.pag_ibig_employer || 0) : 0) +
          (person.philhealth ? Number(deptRate.philhealth_employer || 0) : 0),
        cashAdvance: Number(person.cash_advance || 0),
        otHours: 0, // You can extend this if OT is saved in history later
        settings: settings || {}
      };
    }
    
    setModalData({
      loading: false,
      person,
      detailedAttendance,
      settings,
      payroll: fullPayroll,
    });
    setSelected(fullPayroll);
  };

  // Export to Excel
  const handleExportExcel = () => {
    if (!Array.isArray(sortedPayrollsFinal) || sortedPayrollsFinal.length === 0) return;
    const exportData = sortedPayrollsFinal.map((row) => ({
      "Person ID": row.person_id,
      "Employee Name": row.person?.name || "",
      Department: row.person?.department || "",
      "Cutoff Period": formatPeriod(row.period),
      "Period Code": row.period || "",
      "Days Present": row.days_present ?? "",
      "Daily Rate (₱)": row.daily_rate ?? "",
      "Late Penalty (₱)": row.late_penalty ?? "",
      "Gross (₱)": row.gross ?? "",
      "Net Payout (₱)": row.net ?? "",
      "Released Date": row.released_at ? new Date(row.released_at).toLocaleString() : "",
      "Status / Action": row.released_action || activityLogsMap[row.payroll_period_id || row.id] || "Released",
    }));
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
    const sheetName = periodFilter ? "Cutoff Payroll" : "Released Payrolls";
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const filename = periodFilter
      ? `released_payrolls_${String(periodFilter).replace(/[^\w-]/g, "_")}.xlsx`
      : "released_payrolls_all_periods.xlsx";
    XLSX.writeFile(wb, filename);

    Swal.fire({
      toast: true,
      position: "top-end",
      icon: "success",
      title: `Exported Excel for ${periodFilter ? formatPeriod(periodFilter) : "All Cutoff Periods"}`,
      showConfirmButton: false,
      timer: 2500,
      timerProgressBar: true,
    });
  };

  // Pagination logic
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  useEffect(() => {
    setCurrentPage(1);
  }, [search, departmentFilter, periodFilter]);

  const activeRecords = sortedPayrollsFinal;
  const totalRecords = activeRecords.length;
  const totalPages = Math.ceil(totalRecords / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentRecords = activeRecords.slice(
    startIndex,
    startIndex + itemsPerPage,
  );

  return (
    <div className="released-payroll-history mx-auto pt-0 pb-6 px-0 max-w-full bg-white min-h-screen text-gray-800 font-sans">
      <style>{`
        .released-payroll-history input:focus,
        .released-payroll-history select:focus {
          border-color: #dce3dd !important;
          outline: none !important;
          box-shadow: none !important;
        }
        .released-payroll-history button:focus,
        .released-payroll-history button:focus-visible,
        .released-payroll-history *:focus {
          outline: none !important;
          box-shadow: none !important;
        }
      `}</style>
      {/* Header */}
      <div className="mb-6 flex flex-col items-start gap-1.5">
        <h1 className="text-[2rem] md:text-4xl font-extrabold m-0 tracking-tight inline-block">
          <span className="text-[#2c382d]">Released Payroll </span>
          <span className="text-[#237227]">History</span>
        </h1>
        <p className="text-gray-500 text-sm m-0">
          View, sort, and search finalized payslips and release history by Payroll Cutoff Period.
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <div className="bg-white p-4 rounded-xl border border-[#edf2ee] shadow-sm flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-xl bg-green-50 flex items-center justify-center text-[#237227] shrink-0">
            <FiCheckCircle className="text-2xl" />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Released Payslips
            </div>
            <div className="text-xl font-bold text-gray-800">
              {filteredPayrolls.length} record(s)
            </div>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-[#edf2ee] shadow-sm flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 shrink-0">
            <FiDollarSign className="text-2xl" />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Total Net Amount Released
            </div>
            <div className="text-xl font-bold text-blue-700">
              ₱{filteredPayrolls.reduce((sum, p) => sum + Number(p.net || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-[#edf2ee] shadow-sm flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-xl bg-purple-50 flex items-center justify-center text-purple-600 shrink-0">
            <FiCalendar className="text-2xl" />
          </div>
          <div className="overflow-hidden">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Selected Cutoff Period
            </div>
            <div className="text-sm font-bold text-purple-800 truncate" title={periodFilter ? `${formatPeriod(periodFilter)} (${periodFilter})` : "All Periods"}>
              {periodFilter ? formatPeriod(periodFilter) : `All Periods (${periodOptions.length})`}
            </div>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap justify-between items-end gap-3.5 mb-5 p-3.5 px-4 bg-white rounded-xl border border-[#edf2ee] shadow-sm">
        <div className="flex flex-wrap gap-3.5 items-end">
          <div>
            <label className="block mb-1 text-xs text-gray-600 font-semibold">
              Search
            </label>
            <div className="relative">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none" />
              <input
                type="text"
                placeholder="Search name, ID, or period"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-3.5 py-2 text-sm rounded-md border border-[#dce3dd] bg-white text-[#2c382d] outline-none focus:outline-none focus:border-[#dce3dd] focus:ring-0 min-w-[200px]"
              />
            </div>
          </div>

          <div>
            <label className="block mb-1 text-xs text-gray-600 font-semibold">
              Payroll Cutoff Period
            </label>
            <div className="flex items-center gap-1.5">
              <select
                value={periodFilter}
                onChange={(e) => setPeriodFilter(e.target.value)}
                className="py-2 px-3 text-sm rounded-md border border-[#dce3dd] bg-white text-[#2c382d] outline-none cursor-pointer focus:outline-none focus:border-[#dce3dd] focus:ring-0 min-w-[230px]"
              >
                <option value="">All Cutoff Periods ({periodOptions.length})</option>
                {periodOptions.map((period) => (
                  <option key={period} value={period}>
                    {formatPeriod(period)} ({period})
                  </option>
                ))}
              </select>
              {periodFilter && (
                <button
                  type="button"
                  onClick={() => setPeriodFilter("")}
                  className="py-2 px-2.5 rounded-md border border-gray-200 bg-gray-50 text-gray-500 hover:text-red-600 text-xs font-semibold cursor-pointer transition-colors"
                  title="Clear Period Filter"
                >
                  ✕ Clear
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="block mb-1 text-xs text-gray-600 font-semibold">
              Department
            </label>
            <select
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="py-2 px-3 text-sm rounded-md border border-[#dce3dd] bg-white text-[#2c382d] outline-none cursor-pointer focus:outline-none focus:border-[#dce3dd] focus:ring-0 min-w-[140px]"
            >
              <option value="">All Departments</option>
              {departmentOptions.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block mb-1 text-xs text-gray-600 font-semibold">
              Sort By
            </label>
            <div className="flex items-center gap-1.5">
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value)}
                className="py-2 px-3 text-sm rounded-md border border-[#dce3dd] bg-white text-[#2c382d] outline-none cursor-pointer focus:outline-none focus:border-[#dce3dd] focus:ring-0"
              >
                <option value="period">Cutoff Period</option>
                <option value="released_at">Released Date</option>
                <option value="name">Employee Name</option>
                <option value="department">Department</option>
                <option value="net">Net Payout</option>
                <option value="person_id">Employee ID</option>
              </select>
              <button
                type="button"
                onClick={() => setSortOrder((s) => (s === "asc" ? "desc" : "asc"))}
                className="py-2 px-3 text-sm rounded-md bg-[#237227] text-white font-semibold cursor-pointer border-none shadow-sm hover:bg-[#1b5e20] transition-colors"
                title="Toggle Ascending / Descending"
              >
                {sortOrder === "asc" ? "▲ Asc" : "▼ Desc"}
              </button>
            </div>
          </div>
        </div>

        <div>
          <button
            onClick={handleExportExcel}
            className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-sm font-semibold border-none cursor-pointer transition-colors bg-[#237227] text-white shadow-sm whitespace-nowrap focus:outline-none hover:bg-[#1b5e20]"
            title={periodFilter ? `Export Excel for Cutoff Period: ${formatPeriod(periodFilter)}` : "Export Excel for All Cutoff Periods"}
          >
            <FiDownload className="mr-1 text-white text-base" /> Export Excel
          </button>
        </div>
      </div>

      {/* Table Container */}
      <div className="rounded-2xl overflow-hidden bg-white shadow-[0_2px_14px_rgba(44,56,45,0.06)] border border-gray-100">
        <div className="overflow-x-auto max-h-[600px] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-track]:bg-slate-100 [&::-webkit-scrollbar-thumb]:bg-slate-300 [&::-webkit-scrollbar-thumb]:rounded">
          <table className="w-full border-collapse text-[0.95rem] min-w-[1100px]">
            <thead>
              <tr className="border-b-2 border-gray-200 bg-white">
                <th
                  className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap cursor-pointer hover:text-[#237227] transition-colors select-none"
                  onClick={() => handleSort("person_id")}
                >
                  ID{" "}
                  {sortKey === "person_id" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th
                  className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap cursor-pointer hover:text-[#237227] transition-colors select-none"
                  onClick={() => handleSort("name")}
                >
                  NAME{" "}
                  {sortKey === "name" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th
                  className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap cursor-pointer hover:text-[#237227] transition-colors select-none"
                  onClick={() => handleSort("department")}
                >
                  DEPARTMENT{" "}
                  {sortKey === "department" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th
                  className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap cursor-pointer hover:text-[#237227] transition-colors select-none"
                  onClick={() => handleSort("period")}
                  title="Click to sort by Cutoff Period"
                >
                  CUTOFF PERIOD{" "}
                  {sortKey === "period" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap select-none">
                  DAILY RATE (₱)
                </th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap select-none">
                  DAYS
                </th>
                <th
                  className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap cursor-pointer hover:text-[#237227] transition-colors select-none"
                  onClick={() => handleSort("net")}
                >
                  NET PAYOUT (₱){" "}
                  {sortKey === "net" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-center uppercase text-xs tracking-wider whitespace-nowrap select-none">
                  PAYSLIP
                </th>
                <th className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap select-none">
                  STATUS / ACTION
                </th>
                <th
                  className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap cursor-pointer hover:text-[#237227] transition-colors select-none"
                  onClick={() => handleSort("released_at")}
                >
                  RELEASED AT{" "}
                  {sortKey === "released_at" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
              </tr>
            </thead>
            <tbody>
              {currentRecords.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="text-center py-16 px-5 text-gray-500 text-base"
                  >
                    No released payroll records found for the selected criteria.
                  </td>
                </tr>
              ) : (
                currentRecords.map((p, idx) => {
                  const isSelected =
                    modalData.payroll && selected && selected.id === p.id;
                  const fromModal = modalData.payroll || {};

                  const dailyRate = isSelected
                    ? (fromModal.dailyRate ??
                      fromModal.daily_rate ??
                      p.daily_rate)
                    : p.daily_rate;

                  return (
                    <tr
                      key={p.id}
                      className={`border-b border-gray-100 ${
                        idx % 2 === 0 ? "bg-gray-50/70" : "bg-white"
                      }`}
                    >
                      <td className="py-3.5 px-3.5 text-gray-800 whitespace-nowrap">
                        {p.person_id}
                      </td>
                      <td className="py-3.5 px-3.5 text-gray-800 font-medium whitespace-nowrap">
                        {p.person?.name || "N/A"}
                      </td>
                      <td className="py-3.5 px-3.5 text-gray-700 whitespace-nowrap">
                        {p.person?.department || "N/A"}
                      </td>
                      <td className="py-3.5 px-3.5 text-gray-800 whitespace-nowrap">
                        <div className="font-semibold text-gray-800 text-[0.88rem]">
                          {formatPeriod(p.period)}
                        </div>
                        <div className="text-[0.72rem] text-gray-400 font-mono">
                          {p.period}
                        </div>
                      </td>
                      <td className="py-3.5 px-3.5 text-gray-800 font-medium whitespace-nowrap">
                        {dailyRate != null
                          ? `₱${Number(dailyRate).toFixed(2)}`
                          : "N/A"}
                      </td>
                      <td className="py-3.5 px-3.5 text-gray-800 font-medium whitespace-nowrap">
                        {p.days_present != null ? p.days_present : 0}
                      </td>
                      <td className="py-3.5 px-3.5 text-[#237227] font-bold whitespace-nowrap">
                        ₱{Number(p.net || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-3.5 px-3.5 text-center whitespace-nowrap">
                        <button
                          onClick={() => handleViewPayslip(p)}
                          className="inline-flex items-center justify-center py-1.5 px-3.5 rounded-lg text-xs font-semibold bg-[#237227] text-white shadow-sm cursor-pointer border-none hover:bg-[#1b5e20] transition-colors focus:outline-none"
                        >
                          View
                        </button>
                      </td>
                      <td className="py-3.5 px-3.5 whitespace-nowrap">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-semibold bg-[#237227]/10 text-[#237227] border border-[#237227]/20">
                          {p.released_action || activityLogsMap[p.payroll_period_id || p.id] || "Released"}
                        </span>
                      </td>
                      <td className="py-3.5 px-3.5 text-gray-500 text-xs whitespace-nowrap">
                        {p.released_at ? new Date(p.released_at).toLocaleString() : "N/A"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="flex flex-wrap justify-between items-center p-4 px-5 bg-white border-t border-[#edf2ee] rounded-b-xl gap-2">
          <div className="text-gray-500 text-sm">
            Showing{" "}
            <strong className="text-gray-700">
              {totalRecords === 0 ? 0 : startIndex + 1}
            </strong>{" "}
            to{" "}
            <strong className="text-gray-700">
              {Math.min(startIndex + itemsPerPage, totalRecords)}
            </strong>{" "}
            of <strong className="text-gray-700">{totalRecords}</strong> records
          </div>
          <div className="flex gap-1.5 items-center">
            <button
              className={`flex items-center justify-center min-w-[32px] h-8 px-1.5 rounded-lg border border-gray-300 bg-white text-gray-600 text-sm font-semibold transition-colors hover:bg-gray-100 ${
                currentPage === 1
                  ? "opacity-40 cursor-not-allowed hover:bg-white"
                  : "cursor-pointer"
              }`}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              &lt;
            </button>

            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(
                (p) =>
                  p === 1 ||
                  p === totalPages ||
                  Math.abs(currentPage - p) <= 1,
              )
              .map((p, idx, arr) => {
                const renderButton = (
                  <button
                    key={p}
                    className={`flex items-center justify-center min-w-[32px] h-8 px-1.5 rounded-lg border text-sm font-semibold cursor-pointer transition-colors ${
                      p === currentPage
                        ? "bg-[#237227] text-white border-[#237227]"
                        : "bg-white text-gray-600 border-gray-300 hover:bg-gray-100"
                    }`}
                    onClick={() => setCurrentPage(p)}
                  >
                    {p}
                  </button>
                );

                if (idx > 0 && arr[idx] - arr[idx - 1] > 1) {
                  return (
                    <div
                      key={`group-${p}`}
                      className="flex items-center gap-1.5"
                    >
                      <span className="text-gray-400 px-0.5">...</span>
                      {renderButton}
                    </div>
                  );
                }
                return renderButton;
              })}

            <button
              className={`flex items-center justify-center min-w-[32px] h-8 px-1.5 rounded-lg border border-gray-300 bg-white text-gray-600 text-sm font-semibold transition-colors hover:bg-gray-100 ${
                currentPage === totalPages
                  ? "opacity-40 cursor-not-allowed hover:bg-white"
                  : "cursor-pointer"
              }`}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              &gt;
            </button>
          </div>
        </div>
      </div>
      {showPayslip &&
        selected &&
        (modalData.loading ? (
          <div className="text-center py-10 text-gray-600">
            Loading payslip...
          </div>
        ) : (
          <PayslipModal
            payroll={modalData.payroll || selected}
            person={
              modalData.person || {
                id: selected.person_id,
                name: selected.name,
                department: selected.department,
              }
            }
            detailedAttendance={modalData.detailedAttendance}
            onClose={() => {
              setShowPayslip(false);
              setSelected(null);
            }}
            showPrintButton={true}
            period={selected.period}
            released={true}
            settings={modalData.settings}
          />
        ))}
    </div>
  );
}
