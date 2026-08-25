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
      html: "Contacting <b>DHI-ASA3213GL-MW</b> to sync registered employees to Supabase...",
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });

    try {
      const data = await fetchDahuaApi("/api/dahua/sync-users", {
        method: "POST",
      });

      Swal.fire({
        icon: "success",
        title: "Users Synced!",
        html: `Synced <b>${data.count || 0}</b> user(s) into Supabase database.`,
        timer: 3000,
      });
      fetchStatus(false);
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Sync Error",
        text: err.message,
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncAttendance = async () => {
    setSyncing(true);
    Swal.fire({
      title: "Syncing Attendance Logs...",
      html: "Pulling face recognition and card logs from Dahua device...",
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });

    try {
      const data = await fetchDahuaApi("/api/dahua/sync-attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 100 }),
      });

      Swal.fire({
        icon: "success",
        title: "Attendance Logs Synced!",
        html: `Inserted <b>${data.count || 0}</b> new attendance scan(s) into Supabase.`,
        timer: 3000,
      });
      fetchStatus(false);
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Sync Error",
        text: err.message,
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
          <FiUsers /> Sync Dahua Users to Supabase
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
