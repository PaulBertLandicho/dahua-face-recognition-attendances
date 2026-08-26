import React, { useState, useEffect } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../supabaseClient";
import { FiSearch, FiEye, FiDownload } from "react-icons/fi";
export default function ReleasedPayrollLogs() {
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState(0);
  const [pageSize] = useState(100);
  const [loadingPage, setLoadingPage] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("timestamp");
  const [sortOrder, setSortOrder] = useState("desc");
  const Icons = {
    search: <FiSearch />,
    download: <FiDownload color="#ffffff" style={{ marginRight: 8 }} />,
    eye: <FiEye />,
  };
  useEffect(() => {
    let mounted = true;
    async function fetchLogsPage(p = 0) {
      setLoadingPage(true);
      try {
        const start = p * pageSize;
        const end = start + pageSize - 1;
        const { data, error } = await supabase
          .from("payroll_activity_logs")
          .select(
            "id, payroll_period_id, person_id, person_name, released_by, action, timestamp",
          )
          .order("timestamp", { ascending: false })
          .range(start, end);
        if (error) throw error;
        if (!mounted) return;
        if (Array.isArray(data)) {
          if (p === 0) setLogs(data || []);
          else setLogs((prev) => [...(prev || []), ...(data || [])]);
          setHasMore((data || []).length === pageSize);
          setPage(p);
        }
      } catch (err) {
        console.error("Failed to load payroll activity logs page", err);
      } finally {
        if (mounted) setLoadingPage(false);
      }
    }
    fetchLogsPage(0);

    // realtime subscription to new logs — prepend to current list
    const sub = supabase
      .channel("public:payroll_activity_logs")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "payroll_activity_logs" },
        (payload) => {
          try {
            const newRow = payload.new;
            setLogs((prev) => {
              // avoid duplicate if already loaded
              if (!prev || !prev.length) return [newRow];
              if (prev.some((r) => r.id === newRow.id)) return prev;
              return [newRow, ...prev];
            });
          } catch (e) {
            console.error("realtime payload error", e);
          }
        },
      )
      .subscribe();
    return () => {
      mounted = false;
      try {
        supabase.removeChannel(sub);
      } catch (e) {
        /* older clients */
      }
    };
  }, [pageSize]);

  // Filter and sorting
  const filteredLogs = logs.filter((log) => {
    const searchLower = search.toLowerCase();
    return (
      !search ||
      (log.person_id && log.person_id.toLowerCase().includes(searchLower)) ||
      (log.payroll_period_id &&
        String(log.payroll_period_id).toLowerCase().includes(searchLower)) ||
      (log.person_name &&
        log.person_name.toLowerCase().includes(searchLower)) ||
      (log.released_by &&
        log.released_by.toLowerCase().includes(searchLower)) ||
      (log.action && log.action.toLowerCase().includes(searchLower))
    );
  });

  const sortedLogs = [...filteredLogs].sort((a, b) => {
    let aVal = a[sortKey];
    let bVal = b[sortKey];
    if (sortKey === "timestamp") {
      aVal = new Date(a.timestamp);
      bVal = new Date(b.timestamp);
    } else {
      aVal = (aVal || "").toString().toLowerCase();
      bVal = (bVal || "").toString().toLowerCase();
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
  }, [search]);

  const activeRecords = sortedLogs;
  const totalRecords = activeRecords.length;
  const totalPages = Math.ceil(totalRecords / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentRecords = activeRecords.slice(startIndex, startIndex + itemsPerPage);

  // Sorting handler
  const handleSort = (key) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortOrder("asc");
    }
  };

  // Export to Excel
  const handleExportExcel = () => {
    if (!Array.isArray(sortedLogs)) return;
    const exportData = sortedLogs.map((row) => ({
      Timestamp: row.timestamp ? new Date(row.timestamp).toLocaleString() : "",
      "Payroll Period ID": row.payroll_period_id,
      "Person Name": row.person_name,
      "Released By": row.released_by,
      Action: row.action,
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Released Payroll Logs");
    XLSX.writeFile(wb, "released_payroll_logs.xlsx");
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>
          <span style={styles.titleBlack}>Payroll Activity </span>
          <span style={styles.titlePrimary}>Logs</span>
        </h1>
      </div>
      {/* Filter Bar - match PersonsTable */}
      <div style={styles.filterBar}>
        <div
          style={{
            display: "flex",
            gap: "12px",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div style={styles.searchWrapper}>
            <input
              type="text"
              placeholder="Search name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={styles.searchInput}
            />
          </div>
        </div>
        <button
          onClick={handleExportExcel}
          style={{ ...styles.button, ...styles.buttonPrimary }}
        >
          {Icons.download} Export Excel
        </button>
      </div>
      <div style={styles.tableContainer}>
        <div style={styles.tableWrapper}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th} onClick={() => handleSort("timestamp")}>
                  Timestamp{" "}
                  {sortKey === "timestamp" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                {/* <th
                  style={styles.th}
                  onClick={() => handleSort("payroll_period_id")}
                >
                  Payroll Period ID{" "}
                  {sortKey === "payroll_period_id" &&
                    (sortOrder === "asc" ? "▲" : "▼")}
                </th> */}
                <th style={styles.th} onClick={() => handleSort("person_name")}>
                  Person Name{" "}
                  {sortKey === "person_name" &&
                    (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th style={styles.th} onClick={() => handleSort("released_by")}>
                  Released By{" "}
                  {sortKey === "released_by" &&
                    (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th style={styles.th} onClick={() => handleSort("action")}>
                  Action{" "}
                  {sortKey === "action" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
              </tr>
            </thead>
            <tbody>
              {currentRecords.length === 0 ? (
                <tr>
                  <td colSpan={5} style={styles.emptyState}>
                    No activity logs found.
                  </td>
                </tr>
              ) : (
                currentRecords.map((log, idx) => (
                  <tr
                    key={log.id}
                    style={{
                      ...styles.tr,
                      backgroundColor: idx % 2 === 0 ? "#f9fafb" : "#fff",
                    }}
                  >
                    <td style={styles.td}>
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td style={styles.td}>{log.person_name}</td>
                    <td style={styles.td}>{log.released_by}</td>
                    <td style={styles.td}>{log.action}</td>
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
            {hasMore && (
               <span 
                 onClick={async () => {
                   if (loadingPage) return;
                   const next = page + 1;
                   setLoadingPage(true);
                   try {
                     const start = next * pageSize;
                     const end = start + pageSize - 1;
                     const { data, error } = await supabase
                       .from("payroll_activity_logs")
                       .select("id, payroll_period_id, person_id, person_name, released_by, action, timestamp")
                       .order("timestamp", { ascending: false })
                       .range(start, end);
                     if (error) throw error;
                     setLogs((prev) => [...(prev || []), ...(data || [])]);
                     setPage(next);
                     setHasMore((data || []).length === pageSize);
                   } catch (err) {
                     console.error("Failed to load more logs", err);
                   } finally {
                     setLoadingPage(false);
                   }
                 }}
                 style={{ marginLeft: 8, color: "#3b82f6", cursor: "pointer", textDecoration: "underline" }}
               >
                 (Load more from database)
               </span>
            )}
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
