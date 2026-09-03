import React, { useState, useEffect } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../mysqlClient";
import { FiSearch, FiDownload } from "react-icons/fi";

export default function ReleasedPayrollLogs() {
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState(0);
  const [pageSize] = useState(100);
  const [loadingPage, setLoadingPage] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("timestamp");
  const [sortOrder, setSortOrder] = useState("desc");

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
  const currentRecords = activeRecords.slice(
    startIndex,
    startIndex + itemsPerPage,
  );

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
    <div className="released-payroll-logs mx-auto p-7 md:p-9 max-w-full bg-white min-h-screen text-gray-800 font-sans">
      <style>{`
        .released-payroll-logs input:focus {
          border-color: #dce3dd !important;
          outline: none !important;
          box-shadow: none !important;
        }
        .released-payroll-logs button:focus,
        .released-payroll-logs button:focus-visible,
        .released-payroll-logs *:focus {
          outline: none !important;
          box-shadow: none !important;
        }
      `}</style>
      {/* Header */}
      <div className="mb-6 flex flex-col items-start gap-1.5">
        <h1 className="text-[2rem] md:text-4xl font-extrabold m-0 tracking-tight inline-block">
          <span className="text-[#2c382d]">Payroll Activity </span>
          <span className="text-[#237227]">Logs</span>
        </h1>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap justify-between items-center gap-3.5 mb-5 p-3 px-4 bg-white rounded-xl border border-[#edf2ee] shadow-sm">
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none" />
            <input
              type="text"
              placeholder="Search name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-3.5 py-2 text-sm rounded-md border border-[#dce3dd] bg-white text-[#2c382d] outline-none focus:outline-none focus:border-[#dce3dd] focus:ring-0 min-w-[200px]"
            />
          </div>
        </div>
        <button
          onClick={handleExportExcel}
          className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-sm font-semibold border-none cursor-pointer transition-colors bg-[#237227] text-white shadow-sm whitespace-nowrap focus:outline-none"
        >
          <FiDownload className="mr-1 text-white text-base" /> Export Excel
        </button>
      </div>

      {/* Table Container */}
      <div className="rounded-2xl overflow-hidden bg-white shadow-[0_2px_14px_rgba(44,56,45,0.06)] border border-gray-100">
        <div className="overflow-x-auto max-h-[600px] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-track]:bg-slate-100 [&::-webkit-scrollbar-thumb]:bg-slate-300 [&::-webkit-scrollbar-thumb]:rounded">
          <table className="w-full border-collapse text-[0.95rem] min-w-[800px]">
            <thead>
              <tr className="border-b-2 border-gray-200 bg-white">
                <th
                  className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap cursor-pointer hover:text-[#237227] transition-colors select-none"
                  onClick={() => handleSort("timestamp")}
                >
                  Timestamp{" "}
                  {sortKey === "timestamp" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th
                  className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap cursor-pointer hover:text-[#237227] transition-colors select-none"
                  onClick={() => handleSort("person_name")}
                >
                  Person Name{" "}
                  {sortKey === "person_name" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th
                  className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap cursor-pointer hover:text-[#237227] transition-colors select-none"
                  onClick={() => handleSort("released_by")}
                >
                  Released By{" "}
                  {sortKey === "released_by" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
                <th
                  className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left uppercase text-xs tracking-wider whitespace-nowrap cursor-pointer hover:text-[#237227] transition-colors select-none"
                  onClick={() => handleSort("action")}
                >
                  Action{" "}
                  {sortKey === "action" && (sortOrder === "asc" ? "▲" : "▼")}
                </th>
              </tr>
            </thead>
            <tbody>
              {currentRecords.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="text-center py-16 px-5 text-gray-500 text-base"
                  >
                    No activity logs found.
                  </td>
                </tr>
              ) : (
                currentRecords.map((log, idx) => (
                  <tr
                    key={log.id}
                    className={`border-b border-gray-100 ${
                      idx % 2 === 0 ? "bg-gray-50/70" : "bg-white"
                    }`}
                  >
                    <td className="py-3.5 px-3.5 text-gray-800 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="py-3.5 px-3.5 text-gray-800 font-medium whitespace-nowrap">
                      {log.person_name}
                    </td>
                    <td className="py-3.5 px-3.5 text-gray-700 whitespace-nowrap">
                      {log.released_by}
                    </td>
                    <td className="py-3.5 px-3.5 whitespace-nowrap">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-semibold bg-[#237227]/10 text-[#237227] border border-[#237227]/20">
                        {log.action}
                      </span>
                    </td>
                  </tr>
                ))
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
                      .select(
                        "id, payroll_period_id, person_id, person_name, released_by, action, timestamp",
                      )
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
                className="ml-2 text-blue-600 cursor-pointer underline hover:text-blue-800 text-xs"
              >
                {loadingPage ? "Loading..." : "(Load more from database)"}
              </span>
            )}
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
    </div>
  );
}
