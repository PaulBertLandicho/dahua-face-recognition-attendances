import { useEffect, useState, useCallback } from "react";
import { useLoading } from "../LoadingContext";
import Swal from "sweetalert2";
import { FiRefreshCw, FiUsers, FiClock, FiCheckCircle, FiXCircle, FiCpu } from "react-icons/fi";
import { fetchDahuaApi } from "../utils/dahuaApi";

export default function DeviceStatus() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const { setLoading } = useLoading();

  const fetchStatus = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      setError(null);
      const data = await fetchDahuaApi("/api/device/status");
      setStatus(data);
    } catch (err) {
      setError(err.message);
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [setLoading]);

  useEffect(() => {
    fetchStatus(true);
    const interval = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) fetchStatus(false);
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleSyncUsers = async () => {
    setSyncing(true);
    Swal.fire({
      title: "Syncing Users from Dahua...",
      html: `
        <div class="flex flex-col items-center justify-center py-2 text-center">
          <p class="text-sm text-gray-600 mb-1">
            Contacting <span class="font-semibold text-gray-800">DHI-ASA3213GL-MW</span>
          </p>
            <p class="text-xs text-gray-400">Syncing registered employees to MySQL database...</p>
        </div>
      `,
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      width: "420px",
      padding: "2rem 1.5rem",
      customClass: {
        popup: "!rounded-[28px] !shadow-[0_20px_50px_rgba(0,0,0,0.14)] !border !border-gray-100 !bg-white font-sans text-center",
        title: "!text-xl !font-bold !text-gray-800 !m-0 !text-center",
        loader: "!border-[#237227] !border-t-transparent",
      },
      didOpen: () => Swal.showLoading(),
    });

    try {
      const data = await fetchDahuaApi("/api/dahua/sync-users", {
        method: "POST",
      });

      const count = data?.count || 0;
      Swal.fire({
        icon: "success",
        iconColor: "#237227",
        title: "Users Synced!",
        html: `
          <div class="flex flex-col items-center justify-center text-center mt-2 font-sans">
            <div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-emerald-50 text-[#237227] text-sm font-semibold mb-2.5 border border-emerald-100 shadow-xs">
              <span class="inline-block w-2 h-2 rounded-full bg-[#237227]"></span>
              <span>${count} user${count === 1 ? "" : "s"} synced</span>
            </div>
            <p class="text-sm text-gray-600 leading-relaxed max-w-xs">
              Synced from Dahua terminal to MySQL database successfully.
            </p>
          </div>
        `,
        width: "420px",
        padding: "2rem 1.5rem",
        showConfirmButton: true,
        confirmButtonText: "OK",
        buttonsStyling: false,
        timer: 3500,
        customClass: {
          popup: "!rounded-[28px] !shadow-[0_20px_50px_rgba(0,0,0,0.14)] !border !border-gray-100 !bg-white font-sans text-center",
          title: "!text-2xl !font-bold !text-gray-800 !mt-2 !mb-0 !text-center tracking-tight",
          icon: "!scale-95 !mx-auto !my-2",
          actions: "!flex !items-center !justify-center !mt-5 !w-full",
          confirmButton: "!bg-[#237227] hover:!bg-[#1c5c20] !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !shadow-md hover:!shadow-lg !transition-all !duration-200 !min-w-[120px] active:!scale-95",
        },
      });
      fetchStatus(false);
    } catch (err) {
      Swal.fire({
        icon: "error",
        iconColor: "#dc2626",
        title: "Sync Error",
        html: `
          <div class="flex flex-col items-center justify-center text-center mt-2 font-sans">
            <p class="text-sm text-gray-600 max-w-xs">
              ${err?.message || "Failed to sync users from Dahua device."}
            </p>
          </div>
        `,
        width: "420px",
        padding: "2rem 1.5rem",
        showConfirmButton: true,
        confirmButtonText: "OK",
        buttonsStyling: false,
        customClass: {
          popup: "!rounded-[28px] !shadow-[0_20px_50px_rgba(0,0,0,0.14)] !border !border-gray-100 !bg-white font-sans text-center",
          title: "!text-2xl !font-bold !text-gray-800 !mt-2 !mb-0 !text-center tracking-tight",
          icon: "!scale-95 !mx-auto !my-2",
          actions: "!flex !items-center !justify-center !mt-5 !w-full",
          confirmButton: "!bg-red-600 hover:!bg-red-700 !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !shadow-md hover:!shadow-lg !transition-all !duration-200 !min-w-[120px] active:!scale-95",
        },
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncAttendance = async () => {
    setSyncing(true);
    Swal.fire({
      title: "Syncing Attendance Logs...",
      html: `
        <div class="flex flex-col items-center justify-center py-2 text-center">
          <p class="text-sm text-gray-600 mb-1">
            Pulling face recognition and card logs from Dahua device...
          </p>
          <p class="text-xs text-gray-400">Saving new scans to MySQL...</p>
        </div>
      `,
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      width: "420px",
      padding: "2rem 1.5rem",
      customClass: {
        popup: "!rounded-[28px] !shadow-[0_20px_50px_rgba(0,0,0,0.14)] !border !border-gray-100 !bg-white font-sans text-center",
        title: "!text-xl !font-bold !text-gray-800 !m-0 !text-center",
        loader: "!border-[#237227] !border-t-transparent",
      },
      didOpen: () => Swal.showLoading(),
    });

    try {
      const data = await fetchDahuaApi("/api/dahua/sync-attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 100 }),
      });

      const count = data?.count || 0;
      Swal.fire({
        icon: "success",
        iconColor: "#237227",
        title: "Attendance Logs Synced!",
        html: `
          <div class="flex flex-col items-center justify-center text-center mt-2 font-sans">
            <div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-emerald-50 text-[#237227] text-sm font-semibold mb-2.5 border border-emerald-100 shadow-xs">
              <span class="inline-block w-2 h-2 rounded-full bg-[#237227]"></span>
              <span>${count} scan${count === 1 ? "" : "s"} inserted</span>
            </div>
            <p class="text-sm text-gray-600 leading-relaxed max-w-xs">
              Inserted new attendance scan(s) into MySQL successfully.
            </p>
          </div>
        `,
        width: "420px",
        padding: "2rem 1.5rem",
        showConfirmButton: true,
        confirmButtonText: "OK",
        buttonsStyling: false,
        timer: 3500,
        customClass: {
          popup: "!rounded-[28px] !shadow-[0_20px_50px_rgba(0,0,0,0.14)] !border !border-gray-100 !bg-white font-sans text-center",
          title: "!text-2xl !font-bold !text-gray-800 !mt-2 !mb-0 !text-center tracking-tight",
          icon: "!scale-95 !mx-auto !my-2",
          actions: "!flex !items-center !justify-center !mt-5 !w-full",
          confirmButton: "!bg-[#237227] hover:!bg-[#1c5c20] !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !shadow-md hover:!shadow-lg !transition-all !duration-200 !min-w-[120px] active:!scale-95",
        },
      });
      fetchStatus(false);
    } catch (err) {
      Swal.fire({
        icon: "error",
        iconColor: "#dc2626",
        title: "Sync Error",
        html: `
          <div class="flex flex-col items-center justify-center text-center mt-2 font-sans">
            <p class="text-sm text-gray-600 max-w-xs">
              ${err?.message || "Failed to sync attendance logs from Dahua device."}
            </p>
          </div>
        `,
        width: "420px",
        padding: "2rem 1.5rem",
        showConfirmButton: true,
        confirmButtonText: "OK",
        buttonsStyling: false,
        customClass: {
          popup: "!rounded-[28px] !shadow-[0_20px_50px_rgba(0,0,0,0.14)] !border !border-gray-100 !bg-white font-sans text-center",
          title: "!text-2xl !font-bold !text-gray-800 !mt-2 !mb-0 !text-center tracking-tight",
          icon: "!scale-95 !mx-auto !my-2",
          actions: "!flex !items-center !justify-center !mt-5 !w-full",
          confirmButton: "!bg-red-600 hover:!bg-red-700 !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !shadow-md hover:!shadow-lg !transition-all !duration-200 !min-w-[120px] active:!scale-95",
        },
      });
    } finally {
      setSyncing(false);
    }
  };

  const cardStyle = {
    background: "#ffffff",
    borderRadius: "12px",
    padding: "20px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
    border: "1px solid #e2e8f0",
    marginTop: "16px",
    marginBottom: "20px",
  };

  const badgeStyle = (isOnline) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 12px",
    borderRadius: "20px",
    fontSize: "13px",
    fontWeight: "600",
    backgroundColor: isOnline ? "#e6f9ed" : "#fef2f2",
    color: isOnline ? "#16a34a" : "#dc2626",
    border: `1px solid ${isOnline ? "#86efac" : "#fca5a5"}`,
  });

  const buttonStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    backgroundColor: "#2563eb",
    color: "#ffffff",
    border: "none",
    padding: "8px 16px",
    borderRadius: "8px",
    fontWeight: "500",
    cursor: "pointer",
    fontSize: "13px",
    transition: "all 0.2s ease",
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <FiCpu size={22} color="#2563eb" />
          <h3 style={{ margin: 0, fontSize: "17px", color: "#1e293b", fontWeight: "600" }}>
            Biometric Device: Dahua DHI-ASA3213GL-MW
          </h3>
        </div>

        {status && (
          <span style={badgeStyle(status.online)}>
            {status.online ? <FiCheckCircle /> : <FiXCircle />}
            {status.online ? "Online & Ready" : "Offline / Unreachable"}
          </span>
        )}
      </div>

      {error && (
        <div style={{ padding: "10px 14px", backgroundColor: "#fef2f2", color: "#dc2626", borderRadius: "8px", marginBottom: "16px", fontSize: "13px" }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {status && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "14px", marginBottom: "18px", fontSize: "13px" }}>
          <div style={{ background: "#f8fafc", padding: "10px 14px", borderRadius: "8px" }}>
            <span style={{ color: "#64748b", display: "block", fontSize: "11px", textTransform: "uppercase" }}>Terminal IP</span>
            <strong style={{ color: "#1e293b" }}>{status.deviceIp}:{status.devicePort || 80}</strong>
          </div>
          <div style={{ background: "#f8fafc", padding: "10px 14px", borderRadius: "8px" }}>
            <span style={{ color: "#64748b", display: "block", fontSize: "11px", textTransform: "uppercase" }}>Device Model</span>
            <strong style={{ color: "#1e293b" }}>{status.model || "DHI-ASA3213GL-MW"}</strong>
          </div>
          <div style={{ background: "#f8fafc", padding: "10px 14px", borderRadius: "8px" }}>
            <span style={{ color: "#64748b", display: "block", fontSize: "11px", textTransform: "uppercase" }}>RTSP Stream</span>
            <strong style={{ color: status.streamOnline ? "#16a34a" : "#64748b" }}>
              {status.streamOnline ? "Live Streaming" : "Inactive"}
            </strong>
          </div>
          {status.softwareVersion && (
            <div style={{ background: "#f8fafc", padding: "10px 14px", borderRadius: "8px" }}>
              <span style={{ color: "#64748b", display: "block", fontSize: "11px", textTransform: "uppercase" }}>Firmware</span>
              <strong style={{ color: "#1e293b" }}>{status.softwareVersion}</strong>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", paddingTop: "8px", borderTop: "1px solid #f1f5f9" }}>
        <button
          onClick={handleSyncUsers}
          disabled={syncing}
          style={{ ...buttonStyle, backgroundColor: "#0284c7" }}
        >
          <FiUsers /> Sync Dahua Users to MySQL
        </button>

        <button
          onClick={handleSyncAttendance}
          disabled={syncing}
          style={{ ...buttonStyle, backgroundColor: "#059669" }}
        >
          <FiClock /> Sync Attendance Logs
        </button>

        <button
          onClick={() => fetchStatus(true)}
          style={{ ...buttonStyle, backgroundColor: "#475569" }}
        >
          <FiRefreshCw /> Refresh Status
        </button>
      </div>
    </div>
  );
}
