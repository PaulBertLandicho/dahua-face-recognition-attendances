import React, { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../supabaseClient";
import PayslipModal from "./PayslipModals/PayslipModal";
import { getDetailedAttendance } from "./attendanceDetails";
import { calculatePayroll } from "./Payroll";
import { FiDownload, FiEye } from "react-icons/fi";

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
  const [sortKey, setSortKey] = useState("period");
  const [sortOrder, setSortOrder] = useState("desc");
  // Removed unused Icons variable
  useEffect(() => {
    async function fetchReleased() {
      // Select only necessary payroll fields and join limited person info to reduce data transfer
      const { data } = await supabase
        .from("payroll_periods")
        .select(
          "id, person_id, period, released, daily_rate, late_penalty, gross, net, days_present, person:persons(id,name,department)",
        )
        .eq("released", true)
        .order("period", { ascending: false })
        .limit(2000);
      setReleasedPayrolls(data || []);

      // Fetch activity logs to get action type (Released or Advance Release)
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

  // Filter and sort
  const filteredPayrolls = releasedPayrolls.filter((p) => {
    const searchLower = search.toLowerCase();
    return (
      !search ||
      (p.person_id && p.person_id.toLowerCase().includes(searchLower)) ||
      (p.person &&
        p.person.name &&
        p.person.name.toLowerCase().includes(searchLower)) ||
      (p.person &&
        p.person.department &&
        p.person.department.toLowerCase().includes(searchLower)) ||
      (p.period && p.period.toLowerCase().includes(searchLower))
    );
  });

  const sortedPayrolls = [...filteredPayrolls].sort((a, b) => {
    let aVal = a[sortKey];
    let bVal = b[sortKey];
    if (sortKey === "period") {
      aVal = (aVal || "").toLowerCase();
      bVal = (bVal || "").toLowerCase();
    } else if (sortKey === "person_id") {
      aVal = (a.person_id || "").toLowerCase();
      bVal = (b.person_id || "").toLowerCase();
    } else if (sortKey === "name") {
      aVal = (a.person?.name || "").toLowerCase();
      bVal = (b.person?.name || "").toLowerCase();
    } else if (sortKey === "department") {
      aVal = (a.person?.department || "").toLowerCase();
      bVal = (b.person?.department || "").toLowerCase();
    } else {
      aVal = (a[sortKey] || "").toString().toLowerCase();
      bVal = (b[sortKey] || "").toString().toLowerCase();
    }
    if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
    if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
    return 0;
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
      const [start, end] = payroll.period.split("_to_");
      const { data: attendance } = await supabase
        .from("attendance")
        .select("id, event, device_time, photo, status, method")
        .eq("person_id", payroll.person_id)
        .gte("device_time", start)
        .lte("device_time", end)
        .order("device_time", { ascending: true });
      detailedAttendance = getDetailedAttendance(
        attendance || [],
        payroll.person_id,
        settings || {},
      );
      // Recalculate payroll using the same logic as PayrollPage
      const basePayroll = calculatePayroll(
        attendance || [],
        [person],
        deptRates || [],
        settings || {},
      )[0];
      const lateCount = detailedAttendance
        .map((rec) => rec.lateDetails || [])
        .flat().length;
      const latePenalty = Number(person.late_penalty || 0);
      const lateCountLimit = Number(settings.late_count_limit || 5);
      const totalLateDeduction =
        lateCount >= lateCountLimit ? lateCount * latePenalty : 0;
      const totalDeductions =
        basePayroll.sss +
        basePayroll.pag_ibig +
        basePayroll.philhealth +
        basePayroll.cashAdvance +
        totalLateDeduction;
      const net = basePayroll.gross - totalDeductions;
      fullPayroll = {
        ...basePayroll,
        lateCount,
        lateCountLimit,
        totalLateDeduction,
        totalDeductions,
        net,
      };
    }
    setModalData({
      loading: false,
      person,
      detailedAttendance,
      settings,
      payroll: fullPayroll,
    });
    setSelected(payroll);
  };

  // Export to Excel
  const handleExportExcel = () => {
    if (!Array.isArray(sortedPayrolls)) return;
    const exportData = sortedPayrolls.map((row) => ({
      ID: row.person_id,
      Name: row.person?.name || "",
      Department: row.person?.department || "",
      Period: row.period || "",
      "Daily Rate": row.daily_rate ?? "",
      "Late Penalty": row.late_penalty ?? "",
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Released Payrolls");
    XLSX.writeFile(wb, "released_payrolls.xlsx");
  };

  // Get unique departments for filter dropdown
  const departmentOptions = [
    ...new Set(
      releasedPayrolls.map((p) => p.person?.department).filter(Boolean),
    ),
  ];

  const [departmentFilter, setDepartmentFilter] = useState("");

  // Filter by department
  const filteredAndDeptPayrolls = filteredPayrolls.filter((p) => {
    if (!departmentFilter) return true;
    return (p.person?.department || "") === departmentFilter;
  });
  const sortedPayrollsFinal = [...filteredAndDeptPayrolls].sort((a, b) => {
    let aVal = a[sortKey];
    let bVal = b[sortKey];
    if (sortKey === "period") {
      aVal = (aVal || "").toLowerCase();
      bVal = (bVal || "").toLowerCase();
    } else if (sortKey === "person_id") {
      aVal = (a.person_id || "").toLowerCase();
      bVal = (b.person_id || "").toLowerCase();
    } else if (sortKey === "name") {
      aVal = (a.person?.name || "").toLowerCase();
      bVal = (b.person?.name || "").toLowerCase();
    } else if (sortKey === "department") {
      aVal = (a.person?.department || "").toLowerCase();
      bVal = (b.person?.department || "").toLowerCase();
    } else {
      aVal = (a[sortKey] || "").toString().toLowerCase();
      bVal = (b[sortKey] || "").toString().toLowerCase();
    }
    if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
    if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
    return 0;
  });

  // Pagination logic
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  useEffect(() => {
    setCurrentPage(1);
  }, [search, departmentFilter]);

  const activeRecords = sortedPayrollsFinal;
  const totalRecords = activeRecords.length;
  const totalPages = Math.ceil(totalRecords / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentRecords = activeRecords.slice(startIndex, startIndex + itemsPerPage);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>
          <span style={styles.titleBlack}>Released Payroll </span>
          <span style={styles.titlePrimary}>History</span>
        </h1>
      </div>
      {/* Filter Bar - match PersonsTable */}
      <div style={styles.filterBar}>
        <div style={styles.filterGroup}>
          <div style={styles.searchWrapper}>
            <label style={{ display: "block", marginBottom: 4, fontSize: 12, color: "#4b5563", fontWeight: 600 }}>Search</label>
            <input
              type="text"
              placeholder="Search name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={styles.searchInput}
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: 4, fontSize: 12, color: "#4b5563", fontWeight: 600 }}>Department</label>
            <select
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              style={styles.select}
            >
              <option value="">All Departments</option>
              {departmentOptions.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={styles.actionButtons}>
          <button
            onClick={handleExportExcel}
            style={{ ...styles.button, ...styles.buttonPrimary }}
          >
            <FiDownload color="#ffffff" style={{ marginRight: 8 }} /> Export Excel
          </button>
        </div>
      </div>
      <div style={styles.tableContainer}>
        <div style={styles.tableWrapper}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th} onClick={() => handleSort("person_id")}>
                  ID{" "}
                  {sortKey === "person_id" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th style={styles.th} onClick={() => handleSort("name")}>
                  NAME {sortKey === "name" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th style={styles.th} onClick={() => handleSort("department")}>
                  DEPARTMENT{" "}
                  {sortKey === "department" &&
                    (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th style={styles.th} onClick={() => handleSort("period")}>
                  PERIOD{" "}
                  {sortKey === "period" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th style={styles.th}>DAILY RATE (₱)</th>
                <th style={styles.th}>LATE PENALTY (₱)</th>
                <th style={styles.th}>PAYSLIP</th>
                <th style={styles.th}>ACTION</th>
              </tr>
            </thead>
            <tbody>
              {currentRecords.length === 0 ? (
                <tr>
                  <td colSpan={8} style={styles.emptyState}>
                    No released payrolls found.
                  </td>
                </tr>
              ) : (
                currentRecords.map((p, idx) => (
                  <tr
                    key={p.id}
                    style={{
                      ...styles.tr,
                      backgroundColor: idx % 2 === 0 ? "#f9fafb" : "#fff",
                    }}
                  >
                    <td style={styles.td}>{p.person_id}</td>
                    <td style={styles.td}>{p.person?.name || "-"}</td>
                    <td style={styles.td}>{p.person?.department || "-"}</td>
                    <td style={styles.td}>{p.period}</td>
                    {(() => {
                      const isSelected =
                        modalData.payroll && selected && selected.id === p.id;
                      const fromModal = modalData.payroll || {};

                      const dailyRate = isSelected
                        ? (fromModal.dailyRate ??
                          fromModal.daily_rate ??
                          p.daily_rate)
                        : p.daily_rate;
                      const latePenalty = isSelected
                        ? (fromModal.latePenalty ??
                          fromModal.late_penalty ??
                          p.late_penalty)
                        : p.late_penalty;
                      return (
                        <>
                          <td style={styles.td}>
                            ₱
                            {dailyRate != null
                              ? Number(dailyRate).toFixed(2)
                              : "-"}
                          </td>
                          <td style={styles.td}>
                            ₱
                            {latePenalty != null
                              ? Number(latePenalty).toFixed(2)
                              : "-"}
                          </td>
                        </>
                      );
                    })()}
                    <td style={styles.td}>
                      <button
                        onClick={() => handleViewPayslip(p)}
                        style={{
                          ...styles.button,
                          ...styles.buttonPrimary,
                          padding: "6px 18px",
                          fontSize: "0.95rem",
                          borderRadius: "30px",
                        }}
                      >
                        <FiEye color="#ffffff" />
                        View
                      </button>
                    </td>
                    <td style={styles.td}>
                      <span style={{ color: "#237227", fontWeight: 600 }}>
                        {activityLogsMap[p.id] || "Released"}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        
        {/* Pagination Footer */}
        <div style={styles.paginationContainer}>
          <div style={styles.paginationText}>
            Showing <strong>{totalRecords === 0 ? 0 : startIndex + 1}</strong> to <strong>{Math.min(startIndex + itemsPerPage, totalRecords)}</strong> of <strong>{totalRecords}</strong> records
          </div>
          <div style={styles.paginationControls}>
            <button 
              style={{ ...styles.pageButton, ...(currentPage === 1 ? styles.pageButtonDisabled : {}) }}
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
                    style={p === currentPage ? { ...styles.pageButton, ...styles.pageButtonActive } : styles.pageButton}
                    onClick={() => setCurrentPage(p)}
                  >
                    {p}
                  </button>
                );

                if (idx > 0 && arr[idx] - arr[idx - 1] > 1) {
                  return (
                    <div key={`group-${p}`} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <span style={{ color: "#677368", padding: "0 2px" }}>...</span>
                      {renderButton}
                    </div>
                  );
                }
                return renderButton;
              })}
            
            <button 
              style={{ ...styles.pageButton, ...(currentPage === totalPages ? styles.pageButtonDisabled : {}) }}
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
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
          <div style={{ textAlign: "center", padding: 40 }}>
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

// Light theme styles with green accent
const styles = {
  container: {
    margin: "0 auto",
    padding: "36px 28px",
    maxWidth: "100%",
    background: "#ffffff",
    minHeight: "100vh",
    color: "#1f2937",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  header: {
    marginBottom: "24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "6px",
  },
  title: {
    fontSize: "2.5rem",
    fontWeight: 800,
    margin: 0,
    letterSpacing: "-0.02em",
    display: "inline-block",
  },
  titleBlack: {
    color: "#2c382d",
  },
  titlePrimary: {
    color: "#237227",
  },
  filterBar: {
    display: "flex",
    flexWrap: "nowrap",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: "14px",
    marginBottom: "20px",
    padding: "12px 16px",
    backgroundColor: "#ffffff",
    borderRadius: "12px",
    border: "1px solid #edf2ee",
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.04)",
    overflowX: "auto",
  },
  filterGroup: {
    display: "flex",
    flexWrap: "nowrap",
    gap: "10px",
    alignItems: "flex-end",
  },
  searchWrapper: {
    position: "relative",
  },
  searchInput: {
    padding: "8px 14px 8px 34px",
    fontSize: "0.85rem",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    backgroundColor: "#ffffff",
    color: "#1f2937",
    outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
    backgroundImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="%236b7280" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>')`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "10px center",
    backgroundSize: "14px",
    minWidth: "180px",
  },
  select: {
    padding: "8px 12px",
    fontSize: "0.85rem",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    backgroundColor: "#ffffff",
    color: "#1f2937",
    outline: "none",
    cursor: "pointer",
    minWidth: "130px",
  },
  button: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    padding: "8px 16px",
    borderRadius: "6px",
    fontSize: "0.85rem",
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
    transition: "opacity 0.18s, transform 0.12s",
    letterSpacing: "0.01em",
    whiteSpace: "nowrap",
  },
  buttonPrimary: {
    background: "#237227",
    color: "#ffffff",
    boxShadow: "0 1px 4px rgba(35, 114, 39, 0.2)",
  },
  buttonSecondary: {
    background: "#ffffff",
    color: "#237227",
    border: "1px solid #237227",
    boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  },
  searchIcon: {
    position: "absolute",
    left: "12px",
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: "1rem",
    color: "#6b7280",
  },
  viewButton: {
    padding: "6px 14px",
    borderRadius: "6px",
    border: "none",
    fontSize: "0.85rem",
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.2s",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    backgroundColor: "#e5e7eb",
    color: "#1f2937",
  },
  tableContainer: {
    borderRadius: "16px",
    overflow: "hidden",
    backgroundColor: "#ffffff",
    boxShadow: "0 2px 14px rgba(44, 56, 45, 0.06)",
    border: "none",
  },
  tableWrapper: {
    overflowX: "auto",
    maxHeight: "600px",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.95rem",
    minWidth: "1200px",
  },
  th: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    backgroundColor: "#ffffff",
    color: "#000000",
    fontWeight: 700,
    padding: "14px 14px",
    textAlign: "left",
    borderBottom: "2px solid #e5e7eb",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    fontSize: "0.75rem",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  td: {
    padding: "14px 12px",
    borderBottom: "1px solid #e5e7eb",
    color: "#1f2937",
  },
  tr: {
    transition: "background 0.2s",
  },
  paginationContainer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 20px",
    backgroundColor: "#ffffff",
    borderTop: "1px solid #edf2ee",
    borderBottomLeftRadius: "12px",
    borderBottomRightRadius: "12px",
  },
  paginationText: {
    color: "#6b7280",
    fontSize: "0.875rem",
  },
  paginationControls: {
    display: "flex",
    gap: "6px",
    alignItems: "center",
  },
  pageButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "32px",
    height: "32px",
    padding: "0 6px",
    borderRadius: "8px",
    border: "1px solid #d1d5db",
    backgroundColor: "#ffffff",
    color: "#6b7280",
    fontSize: "0.85rem",
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.2s",
  },
  pageButtonActive: {
    backgroundColor: "#237227",
    color: "#ffffff",
    border: "1px solid #237227",
  },
  pageButtonDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  emptyState: {
    textAlign: "center",
    padding: "60px 20px",
    color: "#6b7280",
    fontSize: "1.1rem",
  },
  spinnerContainer: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "300px",
    background: "#ffffff",
  },
  spinner: {
    width: "50px",
    height: "50px",
    border: "4px solid #e5e7eb",
    borderTop: "4px solid #237227",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
};

// Add global keyframes and focus styles
const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  input:focus, select:focus {
    border-color: #237227 !important;
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2) !important;
  }
  button:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
  }
`;
document.head.appendChild(styleSheet);
