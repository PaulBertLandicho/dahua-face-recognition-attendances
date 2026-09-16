import React, { useEffect, useState, useCallback } from "react";
import Swal from "sweetalert2";
import {
  FiCpu,
  FiRefreshCw,
  FiUsers,
  FiClock,
  FiCheckCircle,
  FiXCircle,
  FiAlertTriangle,
  FiHelpCircle,
  FiActivity,
  FiServer,
  FiWifi,
  FiShield,
  FiDatabase,
  FiZap,
} from "react-icons/fi";
import {
  getDeviceMonitoring,
  testDeviceConnection,
} from "../utils/dahuaApi";
import { useLoading } from "../LoadingContext";

export default function DeviceMonitoring() {
  const [monitoringData, setMonitoringData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const { setLoading } = useLoading();

  const fetchMonitoringData = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const data = await getDeviceMonitoring();
      if (data && data.devices) {
        setMonitoringData(data);
      }
    } catch (err) {
      console.error("Failed to load device monitoring data:", err);
    } finally {
      if (isInitial) setLoading(false);
      setRefreshing(false);
    }
  }, [setLoading]);

  useEffect(() => {
    fetchMonitoringData(true);
    const interval = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) {
        fetchMonitoringData(false);
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [fetchMonitoringData]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchMonitoringData(false);
  };

  // Test Connection Action
  const handleTestConnection = async () => {
    setTestingConnection(true);
    Swal.fire({
      title: "Testing Connection...",
      html: `
        <div class="flex flex-col items-center justify-center py-2 text-center font-sans">
          <p class="text-sm text-gray-600 mb-1">
            Pinging Dahua biometric terminal...
          </p>
          <p class="text-xs text-gray-400">Verifying network handshake & digest authentication</p>
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
      const res = await testDeviceConnection();

      if (res && res.success) {
        Swal.fire({
          icon: "success",
          iconColor: "#237227",
          title: "Connection Online!",
          html: `
            <div class="flex flex-col items-center justify-center text-center mt-2 font-sans">
              <div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-emerald-50 text-[#237227] text-sm font-semibold mb-2.5 border border-emerald-100 shadow-xs">
                <span class="inline-block w-2 h-2 rounded-full bg-[#237227] animate-pulse"></span>
                <span>Latency: ${res.latencyMs || 0} ms</span>
              </div>
              <p class="text-sm text-gray-700 font-medium">Model: <span class="font-bold text-gray-900">${res.model || "DHI-ASA3213GL-MW"}</span></p>
              ${res.firmware ? `<p class="text-xs text-gray-500 mt-0.5">Firmware: ${res.firmware}</p>` : ""}
              <p class="text-xs text-gray-500 mt-2 leading-relaxed">
                Biometric terminal is reachable and authenticated successfully.
              </p>
            </div>
          `,
          width: "420px",
          padding: "2rem 1.5rem",
          showConfirmButton: true,
          confirmButtonText: "Great",
          buttonsStyling: false,
          timer: 3500,
          customClass: {
            popup: "!rounded-[28px] !shadow-[0_20px_50px_rgba(0,0,0,0.14)] !border !border-gray-100 !bg-white font-sans text-center",
            title: "!text-2xl !font-bold !text-gray-800 !mt-2 !mb-0 !text-center tracking-tight",
            icon: "!scale-95 !mx-auto !my-2",
            actions: "!flex !items-center !justify-center !mt-5 !w-full",
            confirmButton: "!bg-[#237227] hover:!bg-[#1c5c20] !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !shadow-md hover:!shadow-lg !transition-all !duration-200 !min-w-[120px]",
          },
        });
      } else {
        Swal.fire({
          icon: "warning",
          iconColor: "#d97706",
          title: "Terminal Offline / Unreachable",
          html: `
            <div class="flex flex-col items-center justify-center text-center mt-2 font-sans">
              <div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-amber-50 text-amber-700 text-xs font-semibold mb-2.5 border border-amber-200">
                <span>Status: ${res?.status || "Offline"}</span>
              </div>
              <p class="text-sm text-gray-600 max-w-xs leading-relaxed">
                ${res?.message || "Could not establish direct connection to the terminal. Please check network IP, port, and gateway cable."}
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
            confirmButton: "!bg-amber-600 hover:!bg-amber-700 !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !shadow-md hover:!shadow-lg !transition-all !duration-200 !min-w-[120px]",
          },
        });
      }
      fetchMonitoringData(false);
    } catch (err) {
      Swal.fire({
        icon: "error",
        iconColor: "#dc2626",
        title: "Test Connection Error",
        text: err.message || "Failed to test connection to the Dahua biometric terminal.",
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
          confirmButton: "!bg-red-600 hover:!bg-red-700 !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !shadow-md hover:!shadow-lg !transition-all !duration-200 !min-w-[120px]",
        },
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const formatDateTime = (dateStr) => {
    if (!dateStr) return <span className="text-gray-400 italic">Never</span>;
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return String(dateStr);
      return (
        <span className="text-gray-700 font-medium">
          {d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}{" "}
          <span className="text-gray-500 font-normal">
            {d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </span>
      );
    } catch (e) {
      return String(dateStr);
    }
  };

  const getStatusBadge = (status) => {
    const s = String(status || "Unknown").toLowerCase();
    if (s === "online") {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-2xs">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          Online
        </span>
      );
    }
    if (s === "connecting") {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
          <FiRefreshCw className="w-3 h-3 animate-spin text-blue-600" />
          Connecting
        </span>
      );
    }
    if (s === "error") {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-red-50 text-red-700 border border-red-200">
          <FiXCircle className="w-3 h-3 text-red-600" />
          Error
        </span>
      );
    }
    if (s === "offline") {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-gray-100 text-gray-700 border border-gray-300">
          <span className="w-2 h-2 rounded-full bg-gray-400"></span>
          Offline
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-300">
        <FiHelpCircle className="w-3 h-3 text-slate-500" />
        Unknown
      </span>
    );
  };

  const devices = monitoringData?.devices || [
    {
      id: "dahua-primary",
      name: "Multifactors Biometric Station",
      model: "DHI-ASA3213GL-MW",
      ipAddress: "192.168.111.222",
      port: 80,
      connectionStatus: "Unknown",
      lastSuccessfulSync: null,
      lastFailedSync: null,
      lastFailedReason: null,
      lastAttendanceSync: null,
      lastPersonSync: null,
      numberOfPersons: 0,
      numberOfAttendanceRecords: 0,
      streamOnline: false,
    },
  ];

  const summary = monitoringData?.summary || {
    totalDevices: devices.length,
    onlineDevices: devices.filter((d) => String(d.connectionStatus).toLowerCase() === "online").length,
    totalPersons: devices[0]?.numberOfPersons || 0,
    totalAttendance: devices[0]?.numberOfAttendanceRecords || 0,
  };

  return (
    <div className="max-w-[1240px] mx-auto py-2 px-1 sm:px-4 font-sans text-gray-800">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 mb-6 border-b border-gray-200">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[rgba(35,114,39,0.1)] text-[#237227] text-xs font-bold uppercase tracking-wider mb-2">
            <FiShield className="text-sm" /> Biometric Hardware & Sync Telemetry
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 m-0">
            Dahua Device & Sync Monitoring
          </h1>
          <p className="text-sm text-gray-500 mt-1 mb-0">
            Monitor biometric terminals, sync registered personnel, time logs, and test network connectivity.
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 text-sm font-semibold cursor-pointer transition-colors shadow-2xs disabled:opacity-50"
          >
            <FiRefreshCw className={`text-base ${refreshing ? "animate-spin text-[#237227]" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-2xl p-5 border border-gray-200 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 text-[#237227] flex items-center justify-center text-2xl flex-shrink-0">
            <FiServer />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Total Terminals</div>
            <div className="text-2xl font-bold text-gray-900 mt-0.5">{summary.totalDevices} Station{summary.totalDevices === 1 ? "" : "s"}</div>
            <div className="text-xs text-emerald-600 font-medium mt-0.5">{summary.onlineDevices} Online</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-gray-200 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-2xl flex-shrink-0">
            <FiUsers />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Registered Persons</div>
            <div className="text-2xl font-bold text-gray-900 mt-0.5">{summary.totalPersons}</div>
            <div className="text-xs text-gray-500 font-medium mt-0.5">Biometric enrolled</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-gray-200 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-2xl flex-shrink-0">
            <FiClock />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Attendance Logs</div>
            <div className="text-2xl font-bold text-gray-900 mt-0.5">{summary.totalAttendance}</div>
            <div className="text-xs text-gray-500 font-medium mt-0.5">Total punch scans</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-gray-200 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center text-2xl flex-shrink-0">
            <FiActivity />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Security State</div>
            <div className="text-base font-bold text-gray-900 mt-1">Credentials Shielded</div>
            <div className="text-xs text-emerald-600 font-medium mt-0.5">Backend encrypted</div>
          </div>
        </div>
      </div>

      {/* Biometric Device Cards */}
      <div className="space-y-6">
        {devices.map((device) => (
          <div
            key={device.id}
            className="bg-white rounded-3xl border border-gray-200 shadow-sm overflow-hidden transition-all"
          >
            {/* Device Header Bar */}
            <div className="p-6 sm:p-7 border-b border-gray-100 bg-gradient-to-r from-gray-50/70 to-white flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex items-start sm:items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#237227] to-[#1a541c] text-white flex items-center justify-center text-2xl shadow-md flex-shrink-0">
                  <FiCpu />
                </div>
                <div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <h2 className="text-xl sm:text-2xl font-bold text-gray-900 m-0">
                      {device.name}
                    </h2>
                    {getStatusBadge(device.connectionStatus)}
                  </div>
                  <div className="flex items-center gap-4 mt-1.5 text-xs text-gray-500 font-medium flex-wrap">
                    <span className="flex items-center gap-1.5 text-gray-600">
                      <FiServer className="text-gray-400" /> Model: <strong className="text-gray-800">{device.model}</strong>
                    </span>
                    <span className="flex items-center gap-1.5 text-gray-600">
                      <FiWifi className="text-gray-400" /> IP: <strong className="text-gray-800">{device.ipAddress}:{device.port}</strong>
                    </span>
                    {device.streamOnline && (
                      <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold bg-emerald-50 px-2 py-0.5 rounded">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> RTSP Active
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2.5 flex-wrap pt-2 md:pt-0">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={testingConnection}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#237227] hover:bg-[#1a541c] text-white text-xs sm:text-sm font-semibold cursor-pointer transition-all shadow-sm hover:shadow-md disabled:opacity-50 border-none"
                >
                  <FiZap className={`text-base ${testingConnection ? "animate-bounce text-amber-300" : "text-amber-300"}`} />
                  {testingConnection ? "Testing..." : "Test Connection"}
                </button>
              </div>
            </div>

            {/* Error Banner if any */}
            {device.lastFailedReason && (
              <div className="px-6 py-3 bg-red-50/80 border-b border-red-100 flex items-center gap-3 text-xs sm:text-sm text-red-700">
                <FiAlertTriangle className="text-red-500 text-base flex-shrink-0" />
                <span>
                  <strong>Last Sync Warning:</strong> {device.lastFailedReason}
                </span>
              </div>
            )}

            {/* Telemetry & Details Grid */}
            <div className="p-6 sm:p-7 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 bg-white">
              {/* Box 1: Sync Timestamps */}
              <div className="bg-gray-50/70 rounded-2xl p-5 border border-gray-200/80 flex flex-col justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">
                  <FiRefreshCw className="text-emerald-600" /> Synchronization Telemetry
                </div>

                <div className="space-y-3 text-xs sm:text-sm">
                  <div className="flex items-center justify-between pb-2 border-b border-gray-200/60">
                    <span className="text-gray-500">Last Successful Sync:</span>
                    <span className="font-semibold text-right">
                      {formatDateTime(device.lastSuccessfulSync)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between pb-2 border-b border-gray-200/60">
                    <span className="text-gray-500">Last Attendance Sync:</span>
                    <span className="font-semibold text-right">
                      {formatDateTime(device.lastAttendanceSync)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between pb-2 border-b border-gray-200/60">
                    <span className="text-gray-500">Last Person Sync:</span>
                    <span className="font-semibold text-right">
                      {formatDateTime(device.lastPersonSync)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Last Failed Sync:</span>
                    <span className="font-semibold text-right text-red-600">
                      {formatDateTime(device.lastFailedSync)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Box 2: Device Counts */}
              <div className="bg-gray-50/70 rounded-2xl p-5 border border-gray-200/80 flex flex-col justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">
                  <FiDatabase className="text-blue-600" /> Database Capacity & Records
                </div>

                <div className="space-y-4">
                  <div className="bg-white p-3.5 rounded-xl border border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center text-lg">
                        <FiUsers />
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 font-medium">Number of Persons</div>
                        <div className="text-base font-bold text-gray-900">{device.numberOfPersons} users</div>
                      </div>
                    </div>
                    <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-50 text-blue-700">Enrolled</span>
                  </div>

                  <div className="bg-white p-3.5 rounded-xl border border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center text-lg">
                        <FiClock />
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 font-medium">Attendance Records</div>
                        <div className="text-base font-bold text-gray-900">{device.numberOfAttendanceRecords} logs</div>
                      </div>
                    </div>
                    <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-50 text-emerald-700">Stored</span>
                  </div>
                </div>
              </div>

              {/* Box 3: Network & Security Info */}
              <div className="bg-gray-50/70 rounded-2xl p-5 border border-gray-200/80 flex flex-col justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">
                  <FiShield className="text-indigo-600" /> Security & Connection Mode
                </div>

                <div className="space-y-3 text-xs sm:text-sm">
                  <div className="flex items-center justify-between pb-2 border-b border-gray-200/60">
                    <span className="text-gray-500">Connection Mode:</span>
                    <span className="font-semibold text-gray-800">
                      {device.useLocalConnector ? "Local Connector Agent" : "Direct LAN Digest"}
                    </span>
                  </div>

                  <div className="flex items-center justify-between pb-2 border-b border-gray-200/60">
                    <span className="text-gray-500">Authentication:</span>
                    <span className="font-semibold text-emerald-700 inline-flex items-center gap-1">
                      <FiCheckCircle className="text-xs" /> MD5 Digest (Hidden)
                    </span>
                  </div>

                  <div className="flex items-center justify-between pb-2 border-b border-gray-200/60">
                    <span className="text-gray-500">RTSP Stream Port:</span>
                    <span className="font-semibold text-gray-800">554 (H.264)</span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Auto Sync Frequency:</span>
                    <span className="font-semibold text-gray-800">Every 1 min</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
