import { useEffect, useState, useCallback, useRef } from "react";
// import { supabase } from '../supabaseClient';
import { useLoading } from "../LoadingContext";
import { supabase } from "../supabaseClient";
import { determineExpectedEvent, determineAttendanceStatus, getAttendanceStatus, toMinutes } from "./attendanceUtils";
import * as XLSX from "xlsx";
import Swal from "sweetalert2";
import { syncDahuaAttendance, deleteDahuaAttendance } from "../utils/dahuaApi";
import { MdFilterList } from "react-icons/md";
import {
  FiDownload,
  FiArchive,
  FiRotateCcw,
  FiPlus,
  FiX,
  FiRefreshCw,
} from "react-icons/fi";

export default function AttendanceTable() {
  // Search, filter, and sort state
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [sortKey] = useState("device_time");
  const [sortOrder, setSortOrder] = useState("desc");
  const [selectedDate, setSelectedDate] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [records, setRecords] = useState([]);
  const [persons, setPersons] = useState([]);
  const [photoModal, setPhotoModal] = useState({ visible: false, src: "", title: "" });
  const { setLoading } = useLoading();
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  useEffect(() => {
    setCurrentPage(1);
  }, [search, statusFilter, departmentFilter, selectedDate, showArchived, sortOrder]);

  // Removed unused form and setForm state
  // const [showForm, setShowForm] = useState(false); // Removed as unused

  // Helper to format ISO date/time as "April 07, 2026 10:15:30"
  const formatDateTime = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const datePart = date.toLocaleDateString("en-US", {
      month: "long",
      day: "2-digit",
      year: "numeric",
    });
    const timePart = date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    // Insert a dash between date and time for clearer separation
    return `${datePart} - ${timePart}`;
  };

  const Icons = {
    filter: <MdFilterList />,
    download: <FiDownload />,
    archive: <FiArchive />,
    restore: <FiRotateCcw />,
    add: <FiPlus />,
    close: <FiX />,
  };

  // ─── Design System ────────────────────────────────────────────────────────
  // Primary palette: Natural theme centered around Multifactors green (#237227)
  const C = {
    primary:      "#237227",  // The requested primary color
    primaryHover: "#1d5e20",  // Slightly darker for hover states
    primaryLight: "#e9f2ea",  // Very light natural green for backgrounds/badges
    
    background:   "#f6f8f6",  // Soft, natural off-white with a hint of earthy green
    surface:      "#ffffff",  // Pure white for cards/tables
    
    textMain:     "#2c382d",  // Deep slate-green instead of harsh black
    textMuted:    "#677368",  // Muted natural grayish-green
    
    border:       "#dce3dd",  // Soft natural border color
    borderLight:  "#edf2ee",
    
    danger:       "#d9534f",
    warning:      "#f59e0b",
    success:      "#059669",
    info:         "#2563eb",
  };

  const styles = {
    // ── Page wrapper
    container: {
      margin: "0 auto",
      padding: "36px 28px",
      maxWidth: "100%",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      backgroundColor: "#ffffff",
      minHeight: "100vh",
      color: C.textMain,
    },

    // ── Page header
    header: {
      marginBottom: "24px",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: "6px",
    },
    headerBadge: {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      padding: "4px 12px",
      borderRadius: "999px",
      background: C.primaryLight,
      color: C.primaryHover,
      fontSize: "0.78rem",
      fontWeight: 600,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      marginBottom: "4px",
    },
    title: {
      fontSize: "2.5rem",
      fontWeight: 800,
      margin: 0,
      letterSpacing: "-0.02em",
    },
    titleBlack: {
      color: "#2c382d",
    },
    titlePrimary: {
      color: C.primary,
    },
    titleSub: {
      fontSize: "0.95rem",
      color: C.textMuted,
      margin: 0,
    },

    // ── Filter / toolbar card
    filterBar: {
      display: "flex",
      flexWrap: "nowrap",
      justifyContent: "space-between",
      alignItems: "center",
      gap: "14px",
      marginBottom: "20px",
      padding: "12px 16px",
      backgroundColor: C.surface,
      borderRadius: "12px",
      boxShadow: "0 1px 4px rgba(0, 0, 0, 0.04)",
      border: `1px solid ${C.borderLight}`,
      overflowX: "auto",
    },
    filterGroup: {
      display: "flex",
      flexWrap: "nowrap",
      gap: "10px",
      alignItems: "center",
    },
    filterInput: {
      padding: "8px 14px 8px 34px",
      fontSize: "0.85rem",
      borderRadius: "6px",
      border: `1px solid ${C.border}`,
      backgroundColor: C.surface,
      color: C.textMain,
      outline: "none",
      transition: "border-color 0.2s, box-shadow 0.2s",
      backgroundImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="%23677368" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>')`,
      backgroundRepeat: "no-repeat",
      backgroundPosition: "10px center",
      backgroundSize: "14px",
      minWidth: "180px",
    },
    filterSelect: {
      padding: "8px 12px",
      fontSize: "0.85rem",
      borderRadius: "6px",
      border: `1px solid ${C.border}`,
      backgroundColor: C.surface,
      color: C.textMain,
      outline: "none",
      cursor: "pointer",
      minWidth: "130px",
      transition: "border-color 0.2s",
    },
    sortToggle: {
      padding: "8px 16px",
      borderRadius: "6px",
      background: C.primary,
      border: "none",
      color: C.surface,
      fontSize: "0.85rem",
      cursor: "pointer",
      fontWeight: 600,
      minWidth: "60px",
      textAlign: "center",
      transition: "all 0.2s",
    },
    actionButtons: {
      display: "flex",
      gap: "10px",
      flexWrap: "nowrap",
      alignItems: "center",
    },

    // ── Buttons
    button: {
      display: "inline-flex",
      alignItems: "center",
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
      background: C.primary,
      color: C.surface,
      boxShadow: `0 1px 4px rgba(35, 114, 39, 0.2)`,
    },
    buttonSecondary: {
      background: C.surface,
      color: C.primary,
      border: `1px solid ${C.primary}`,
      boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
    },
    buttonWarning: {
      background: C.warning,
      color: C.surface,
      boxShadow: `0 1px 4px rgba(245,158,11,0.2)`,
    },
    buttonDanger: {
      background: C.danger,
      color: C.surface,
      boxShadow: `0 1px 4px rgba(217,83,79,0.2)`,
    },
    buttonSync: {
      background: `linear-gradient(135deg, ${C.success} 0%, ${C.primaryHover} 100%)`,
      color: C.surface,
      boxShadow: `0 1px 4px rgba(5,150,105,0.2)`,
    },

    // ── Count badge
    countBadge: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "7px 14px",
      borderRadius: "6px",
      background: C.surface,
      border: `1px solid ${C.primary}`,
      color: C.primary,
      fontSize: "0.85rem",
      fontWeight: 600,
      whiteSpace: "nowrap",
    },

    // ── Table card wrapper
    tableContainer: {
      borderRadius: "16px",
      overflow: "hidden",
      boxShadow: "0 2px 14px rgba(44, 56, 45, 0.06)",
      backgroundColor: C.surface,
      border: "none",
    },
    table: {
      width: "100%",
      borderCollapse: "collapse",
      fontSize: "0.875rem",
      minWidth: "1200px",
    },

    // ── Table header
    th: {
      position: "sticky",
      top: 0,
      zIndex: 10,
      background: "#ffffff",
      color: "#000000",
      fontWeight: 700,
      padding: "14px 14px",
      textAlign: "left",
      borderBottom: "2px solid #e5e7eb",
      letterSpacing: "0.05em",
      textTransform: "uppercase",
      fontSize: "0.75rem",
      whiteSpace: "nowrap",
    },

    // ── Table cells
    td: {
      padding: "13px 14px",
      borderBottom: `1px solid ${C.borderLight}`,
      color: C.textMain,
      verticalAlign: "middle",
    },
    trHover: {
      transition: "background 0.15s",
    },

    // ── Photo cell
    photoCell: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "5px",
    },
    photo: {
      width: "52px",
      height: "52px",
      objectFit: "cover",
      borderRadius: "10px",
      border: `2px solid ${C.borderLight}`,
      boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
      transition: "transform 0.18s, box-shadow 0.18s",
    },
    photoTime: {
      fontSize: "0.68rem",
      color: C.textMuted,
      fontWeight: 500,
    },

    // ── Status badge colours (used inline)
    lateText:     { color: C.danger,      fontWeight: 700 },
    onTimeText:   { color: C.success,  fontWeight: 700 },
    overtimeText: { color: C.info,     fontWeight: 700 },
    earlyOutText: { color: C.warning,  fontWeight: 700 },

    // ── Row action buttons (small)
    actionCell: {
      display: "flex",
      flexDirection: "row",
      gap: "8px",
      flexWrap: "nowrap",
      alignItems: "center",
      justifyContent: "flex-start",
    },
    smallButton: {
      padding: "6px 10px",
      borderRadius: "6px",
      border: "none",
      fontSize: "0.75rem",
      fontWeight: 600,
      cursor: "pointer",
      transition: "opacity 0.15s, transform 0.1s",
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      backgroundColor: C.background,
      color: C.textMain,
      letterSpacing: "0.01em",
      whiteSpace: "nowrap",
    },

    // ── Empty state
    emptyState: {
      textAlign: "center",
      padding: "72px 20px",
      color: C.textMuted,
      fontSize: "1rem",
    },

    // ── Pagination
    paginationContainer: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "16px 20px",
      backgroundColor: C.surface,
      borderTop: `1px solid ${C.borderLight}`,
      borderBottomLeftRadius: "12px",
      borderBottomRightRadius: "12px",
    },
    paginationText: {
      color: C.textMuted,
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
      border: `1px solid ${C.border}`,
      backgroundColor: C.surface,
      color: C.textMuted,
      fontSize: "0.85rem",
      fontWeight: 600,
      cursor: "pointer",
      transition: "all 0.2s",
    },
    pageButtonActive: {
      backgroundColor: C.primary,
      color: C.surface,
      border: `1px solid ${C.primary}`,
    },
    pageButtonDisabled: {
      opacity: 0.4,
      cursor: "not-allowed",
    },
  };

  const [syncingDahua, setSyncingDahua] = useState(false);
  const dahuaAttendanceSyncInFlightRef = useRef(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      // Fetch attendance from supabase
      const { data: attData, error: attErr } = await supabase
        .from("attendance")
        .select("*");
      if (attErr) throw attErr;
      const uniqueAttendance = Array.from(
        new Map(
          (attData || [])
            .filter((record) => record.person_id)
            .map((record) => {
            const normalizedTime = record.device_time
              ? (() => {
                  const date = new Date(record.device_time);
                  date.setMilliseconds(0);
                  return date.toISOString();
                })()
              : "";
            return [
              `${record.person_id || ""}|${record.event || ""}|${normalizedTime}`,
              record,
            ];
            }),
        ).values(),
      );
      setRecords(uniqueAttendance);
      // Fetch persons from supabase
      const { data: personsData, error: personsErr } = await supabase
        .from("persons")
        .select("id, name, department, registration_photo");
      if (personsErr) throw personsErr;
      setPersons(personsData || []);
      // Fetch work hours settings from supabase
      const { data: settingsData, error: settingsErr } = await supabase
        .from("settings")
        .select("*")
        .eq("id", 1)
        .maybeSingle();
      if (settingsErr) throw settingsErr;
      setSettings(settingsData || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [setLoading]);

  const handleSyncDahuaAttendance = async () => {
    if (dahuaAttendanceSyncInFlightRef.current) return;
    dahuaAttendanceSyncInFlightRef.current = true;
    setSyncingDahua(true);
    Swal.fire({
      title: "Syncing Dahua Logs...",
      html: "Fetching face recognition and card logs from <b>DHI-ASA3213GL-MW</b> to Supabase...",
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      },
    });

    try {
      const data = await syncDahuaAttendance(100);

      Swal.fire({
        icon: "success",
        title: "Attendance Synced!",
        html: `<b>${data.count || 0}</b> new attendance scan(s) synced directly to Supabase.<br/><small style="color:#64748b">${data.message || ""}</small>`,
        timer: 3500,
        showConfirmButton: true,
      });

      await fetchData();
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Sync Failed",
        text: err.message || "Could not reach Dahua device.",
      });
    } finally {
      dahuaAttendanceSyncInFlightRef.current = false;
      setSyncingDahua(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) fetchData(); }, 60_000); // 60s
    return () => clearInterval(interval);
  }, [fetchData]);

  function openPhotoModal(src, title) {
    if (!src) return;
    setPhotoModal({ visible: true, src, title: title || "" });
  }

  function closePhotoModal() {
    setPhotoModal({ visible: false, src: "", title: "" });
  }

  useEffect(() => {
    if (!photoModal.visible) return;
    function onKey(e) {
      if (e.key === "Escape") closePhotoModal();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photoModal.visible]);

  // Loading overlay handled by `LoadingContext` provider

  if (error) {
    return <p style={{ color: "red" }}>{error}</p>;
  }

  // Form handlers
  // compute event/status for an edited attendance time
  const computeStatusForEdit = async (rec, isoTime) => {
    if (!settings) return { event: rec.event, status: rec.status };
    try {
      const deviceDate = new Date(isoTime);
      const year = deviceDate.getFullYear();
      const month = String(deviceDate.getMonth() + 1).padStart(2, "0");
      const day = String(deviceDate.getDate()).padStart(2, "0");
      const dayStartIso = `${year}-${month}-${day}T00:00:00.000Z`;
      const dayEndIso = `${year}-${month}-${day}T23:59:59.999Z`;

      const { data: attData, error: attErr } = await supabase
        .from("attendance")
        .select("id,event,device_time")
        .eq("person_id", rec.person_id)
        .gte("device_time", dayStartIso)
        .lte("device_time", dayEndIso)
        .order("device_time", { ascending: true });
      if (attErr) throw attErr;

      // find last event before the edited time (exclude the edited record itself)
      let lastEvent = null;
      let lastEventDeviceTimeIso = null;
      if (Array.isArray(attData)) {
        for (const r of attData) {
          if (!r || !r.device_time) continue;
          if (r.id === rec.id) continue;
          if (new Date(r.device_time).getTime() < deviceDate.getTime()) {
            lastEvent = r.event;
            lastEventDeviceTimeIso = r.device_time;
          }
        }
      }

      const currentTime = deviceDate.toTimeString().slice(0, 5);
      const event = determineExpectedEvent(currentTime, lastEvent, settings, lastEventDeviceTimeIso);

      // detect whether there was a morning time-in (excluding this edited record)
      let hadMorningTimeIn = false;
      if (Array.isArray(attData) && attData.length > 0) {
        const morningStartMinutes = toMinutes(settings.morning_start);
        const morningEndMinutes = toMinutes(settings.morning_end);
        for (const row of attData) {
          if (!row || row.id === rec.id) continue;
          if (row.event !== "time-in" || !row.device_time) continue;
          const dt = new Date(row.device_time);
          const hhmm = dt.toTimeString().slice(0, 5);
          const minutes = toMinutes(hhmm);
          if (minutes >= morningStartMinutes && minutes <= morningEndMinutes) {
            hadMorningTimeIn = true;
            break;
          }
        }
      }

      const status = determineAttendanceStatus(currentTime, event, settings, hadMorningTimeIn);
      return { event, status };
    } catch (e) {
      console.error("computeStatusForEdit failed", e);
      return { event: rec.event, status: rec.status };
    }
  };

  // open an edit modal and persist edited attendance time, event and status
  const handleEdit = async (rec) => {
    try {
      // format a Date as local `datetime-local` value (YYYY-MM-DDTHH:MM)
      const formatForDatetimeLocal = (d) => {
        const dt = d instanceof Date ? d : new Date(d);
        const pad = (n) => String(n).padStart(2, "0");
        const y = dt.getFullYear();
        const m = pad(dt.getMonth() + 1);
        const day = pad(dt.getDate());
        const hh = pad(dt.getHours());
        const mm = pad(dt.getMinutes());
        return `${y}-${m}-${day}T${hh}:${mm}`;
      };

      const currentLocal = rec.device_time ? formatForDatetimeLocal(new Date(rec.device_time)) : formatForDatetimeLocal(new Date());
      const { value } = await Swal.fire({
        title: `Edit Attendance Time for ${rec.name || rec.person_id}`,
        input: 'datetime-local',
        inputValue: currentLocal,
        showCancelButton: true,
        confirmButtonText: 'Save',
      });
      if (!value) return;
      const iso = new Date(value).toISOString();
      const { event, status } = await computeStatusForEdit(rec, iso);
      const { error } = await supabase.from('attendance').update({ device_time: iso, event, status }).eq('id', rec.id);
      if (error) {
        Swal.fire('Error', error.message, 'error');
        return;
      }
      setRecords((prev) => prev.map((r) => (r.id === rec.id ? { ...r, device_time: iso, event, status } : r)));
      Swal.fire('Saved', 'Attendance updated.', 'success');
    } catch (e) {
      console.error('handleEdit failed', e);
      Swal.fire('Error', e.message || String(e), 'error');
    }
  };

  // const handleFormChange = (e) => {
  //   const { name, value } = e.target;
  //   setForm((prev) => ({ ...prev, [name]: value }));
  // };

  // const handleAdd = () => {
  //   setForm({ person_id: '', event: 'time-in', status: '', method: '', device_time: '' });
  //   setEditing(null);
  //   setShowForm(true);
  // };

  // const handleEdit = (rec) => {
  //   setForm({
  //     person_id: rec.person_id,
  //     event: rec.event,
  //     status: rec.status,
  //     method: rec.method,
  //     device_time: rec.device_time ? new Date(rec.device_time).toISOString().slice(0, 16) : '',
  //   });
  //   setEditing(rec);
  //   showEditModal({
  //     ...rec,
  //     device_time: rec.device_time ? new Date(rec.device_time).toISOString().slice(0, 16) : '',
  //   });
  // };

  // Show edit form in SweetAlert2 modal
  // Removed unused showEditModal function

  // Archive (soft delete)
  const handleArchive = async (rec) => {
    const confirm = await Swal.fire({
      title: "Archive Attendance",
      text: "Are you sure you want to archive this record?",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Archive",
    });
    if (confirm.isConfirmed) {
      const { error: archErr } = await supabase
        .from("attendance")
        .update({ archived: true })
        .eq("id", rec.id);
      if (archErr) {
        Swal.fire("Error", archErr.message, "error");
      } else {
        setRecords((prev) =>
          prev.map((r) => (r.id === rec.id ? { ...r, archived: true } : r))
        );
        Swal.fire("Archived!", "", "success");
      }
    }
  };

  // Restore archived record
  const handleRestore = async (rec) => {
    const { error: resErr } = await supabase
      .from("attendance")
      .update({ archived: false })
      .eq("id", rec.id);
    if (resErr) {
      Swal.fire("Error", resErr.message, "error");
    } else {
      setRecords((prev) =>
        prev.map((r) => (r.id === rec.id ? { ...r, archived: false } : r))
      );
      Swal.fire("Restored!", "", "success");
    }
  };

  const handleDeleteFromDahua = async (rec) => {
    const confirm = await Swal.fire({
      title: "Delete from Dahua?",
      text: "This permanently deletes the matching attendance record from the Dahua device and this website.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Delete from Dahua",
      confirmButtonColor: "#dc2626",
    });
    if (!confirm.isConfirmed) return;

    try {
      const data = await deleteDahuaAttendance(rec.person_id, rec.device_time);

      if (data && data.error) {
        throw new Error(data.error);
      }

      const { error: dbError } = await supabase.from("attendance").delete().eq("id", rec.id);
      if (dbError) {
        throw new Error(dbError.message || "Could not delete the website record.");
      }

      setRecords((prev) => prev.filter((record) => record.id !== rec.id));
      Swal.fire("Deleted", "The attendance record was deleted from Dahua and the website.", "success");
    } catch (err) {
      Swal.fire("Delete failed", err.message || "Could not delete the Dahua record.", "error");
    }
  };

  // const handleFormSubmit = async (e) => {
  //   e.preventDefault();
  //   if (!form.person_id || !form.event || !form.device_time) {
  //     Swal.fire('Error', 'Person, event, and time are required.', 'error');
  //     return;
  //   }
  //   const payload = {
  //     person_id: form.person_id,
  //     event: form.event,
  //     status: form.status,
  //     method: form.method,
  //     device_time: new Date(form.device_time).toISOString(),
  //   };
  //   if (editing) {
  //     // Update
  //     const { error: upErr } = await supabase.from('attendance').update(payload).eq('id', editing.id);
  //     if (upErr) {
  //       Swal.fire('Error', upErr.message, 'error');
  //       return;
  //     }
  //   } else {
  //     // Insert
  //     const { error: inErr } = await supabase.from('attendance').insert([payload]);
  //     if (inErr) {
  //       Swal.fire('Error', inErr.message, 'error');
  //       return;
  //     }
  //   }
  //   setShowForm(false);
  //   setEditing(null);
  //   setForm({ person_id: '', event: 'time-in', status: '', method: '', device_time: '' });
  //   // Refresh
  //   setLoading(true);
  //   const { data: attData } = await supabase.from('attendance').select('*');
  //   setRecords(attData || []);
  //   setLoading(false);
  // };

  // Sort by device_time descending (latest first)
  // Filter and sort records
  const filteredRecords = records.filter((r) => {
    if (r.archived) return false;
    const person = persons.find((p) => p.id === r.person_id) || {};
    // Search by name or person_id
    const matchesSearch =
      !search ||
      (person.name &&
        person.name.toLowerCase().includes(search.toLowerCase())) ||
      (r.person_id && r.person_id.toLowerCase().includes(search.toLowerCase()));
    // Status filter
    const matchesStatus = !statusFilter || getAttendanceStatus(r, settings) === statusFilter;
    // Department filter
    const matchesDept =
      !departmentFilter || (person.department || "") === departmentFilter;
    // Date filter (match full yyyy-mm-dd)
    const recordDate = r.device_time
      ? new Date(r.device_time).toISOString().slice(0, 10)
      : null;
    const matchesDate = !selectedDate || recordDate === selectedDate;
    return matchesSearch && matchesStatus && matchesDept && matchesDate;
  });

  const sortedRecords = [...filteredRecords].sort((a, b) => {
    let aVal, bVal;
    if (sortKey === "device_time") {
      aVal = new Date(a.device_time);
      bVal = new Date(b.device_time);
    } else if (sortKey === "name") {
      const aPerson = persons.find((p) => p.id === a.person_id) || {};
      const bPerson = persons.find((p) => p.id === b.person_id) || {};
      aVal = (aPerson.name || "").toLowerCase();
      bVal = (bPerson.name || "").toLowerCase();
    } else if (sortKey === "department") {
      const aPerson = persons.find((p) => p.id === a.person_id) || {};
      const bPerson = persons.find((p) => p.id === b.person_id) || {};
      aVal = (aPerson.department || "").toLowerCase();
      bVal = (bPerson.department || "").toLowerCase();
    } else {
      aVal = (a[sortKey] || "").toLowerCase();
      bVal = (b[sortKey] || "").toLowerCase();
    }
    if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
    if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
    return 0;
  });

  // Archived records (not filtered)
  const archivedRecords = [...records]
    .filter((r) => r.archived)
    .filter((r) => {
      if (!selectedDate) return true;
      const rd = r.device_time ? new Date(r.device_time).toISOString().slice(0, 10) : null;
      return rd === selectedDate;
    })
    .sort((a, b) => new Date(b.device_time) - new Date(a.device_time));

  // Pagination logic
  const activeRecords = showArchived ? archivedRecords : sortedRecords;
  const totalRecords = activeRecords.length;
  const totalPages = Math.ceil(totalRecords / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentRecords = activeRecords.slice(startIndex, startIndex + itemsPerPage);

  const columns = [
    { key: "photo", label: "Photo" },
    { key: "device_time", label: "Attendance Time" },
    { key: "person_id", label: "Person ID" },
    { key: "name", label: "Employee Name" },
    { key: "department", label: "Department" },
    { key: "work_hours", label: "Work Hours" },
    { key: "status", label: "Attendance Status" },
    { key: "method", label: "Attendance Method" },
  ];

  // Export to Excel
  const handleExportExcel = () => {
    if (!Array.isArray(sortedRecords) || !Array.isArray(persons)) return;
    const exportData = sortedRecords.map((row) => {
      const person = persons.find((p) => p.id === row.person_id) || {};
      return {
        Time: row.device_time ? formatDateTime(row.device_time) : "",
        "Person ID": row.person_id,
        Name: person.name || "",
        Department: person.department || "",
        "Attendance Event": row.event,
        Status: row.status,
        "Attendance Method": row.method,
      };
    });
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Attendance");
    XLSX.writeFile(wb, "attendance_records.xlsx");
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>
          <span style={styles.titleBlack}>Attendance </span>
          <span style={styles.titlePrimary}>Records</span>
        </h1>
      </div>

      {/* Filter Bar */}
      <div style={styles.filterBar}>
        <div style={styles.filterGroup}>
          <div style={{ position: "relative" }}>
            <span style={styles.searchIcon}>{Icons.search}</span>
            <input
              type="text"
              placeholder="Search name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={styles.filterInput}
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={styles.filterSelect}
          >
            <option value="">All Status</option>
            <option value="on-time">on-time</option>
            <option value="late">late</option>
            <option value="early-out">early-out</option>
            <option value="overtime">overtime</option>
          </select>
          <select
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            style={styles.filterSelect}
          >
            <option value="">All Departments</option>
            {Array.from(
              new Set(persons.map((p) => p.department).filter(Boolean))
            ).map((dept) => (
              <option key={dept} value={dept}>
                {dept}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            style={styles.filterSelect}
          />
          {selectedDate && (
            <button
              onClick={() => setSelectedDate("")}
              style={{ ...styles.smallButton, marginLeft: 4 }}
            >
              {Icons.close} Clear
            </button>
          )}
          <button
            aria-label="Toggle sort order"
            onClick={() => setSortOrder((s) => (s === "asc" ? "desc" : "asc"))}
            style={styles.sortToggle}
          >
            {sortOrder === "asc" ? "Asc" : "Desc"}
          </button>
        </div>

        <div style={styles.actionButtons}>
          <div style={styles.countBadge}>
            {(showArchived ? archivedRecords.length : sortedRecords.length) + " records"}
          </div>
          <button
            onClick={() => setShowArchived((a) => !a)}
            style={{ ...styles.button, ...styles.buttonSecondary }}
          >
            {Icons.archive} {showArchived ? "Show Active" : "Show Archived"}
          </button>
          <button
            onClick={handleExportExcel}
            style={{ ...styles.button, ...styles.buttonPrimary }}
          >
            {Icons.download} Export Excel
          </button>
          <button
            onClick={handleSyncDahuaAttendance}
            disabled={syncingDahua}
            style={{ ...styles.button, ...styles.buttonSync }}
          >
            <FiRefreshCw style={{ marginRight: 6 }} /> Sync Dahua
          </button>
        </div>
      </div>

      {/* Table */}
      <div style={styles.tableContainer}>
        <div style={{ overflowX: "auto", maxHeight: "600px" }}>
          <table style={styles.table}>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.key} style={styles.th}>
                    {col.label}
                  </th>
                ))}
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {currentRecords.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} style={styles.emptyState}>
                    {showArchived
                      ? "No archived attendance records found."
                      : "No attendance records found."}
                  </td>
                </tr>
              ) : (
                currentRecords.map(
                  (row, idx) => {
                    const person =
                      persons.find((p) => p.id === row.person_id) || {};
                    const rowStyle = {
                      ...styles.trHover,
                      backgroundColor: idx % 2 === 0 ? "#f9fafb" : "#ffffff",
                    };
                    return (
                      <tr key={row.id} style={rowStyle}>
                        {columns.map((col) => {
                          if (col.key === "photo") {
                            return (
                              <td key="photo" style={styles.td}>
                                {person.registration_photo ? (
                                  <div style={styles.photoCell}>
                                    <img
                                      src={person.registration_photo}
                                      alt="registration"
                                          style={{ ...styles.photo, cursor: 'pointer' }}
                                          onClick={() => openPhotoModal(person.registration_photo, person.name || row.person_id)}
                                    />
                                    <span style={styles.photoTime}>
                                      {row.device_time
                                        ? new Date(
                                            row.device_time
                                          ).toLocaleString(undefined, {
                                            hour: "2-digit",
                                            minute: "2-digit",
                                            second: "2-digit",
                                          })
                                        : ""}
                                    </span>
                                  </div>
                                ) : (
                                  <span style={{ color: "#9ca3af" }}>
                                    No photo
                                  </span>
                                )}
                              </td>
                            );
                          }
                          let value = row[col.key];
                          if (col.key === "name") value = person.name || "";
                          if (col.key === "department")
                            value = person.department || "";
                          if (col.key === "status") value = getAttendanceStatus(row, settings);
                          if (col.key === "device_time" && row[col.key])
                            value = formatDateTime(row[col.key]);
                          if (col.key === "shift") {
                            if (!settings) value = "-";
                            else {
                              const time = new Date(row.device_time);
                              const hour = time.getHours();
                              const minute = time.getMinutes();
                              const totalMinutes = hour * 60 + minute;
                              const morningStart = settings.morning_start
                                ? settings.morning_start.split(":").map(Number)
                                : [0, 0];
                              const morningEnd = settings.morning_end
                                ? settings.morning_end.split(":").map(Number)
                                : [0, 0];
                              const afternoonStart = settings.afternoon_start
                                ? settings.afternoon_start
                                    .split(":")
                                    .map(Number)
                                : [0, 0];
                              const afternoonEnd = settings.afternoon_end
                                ? settings.afternoon_end.split(":").map(Number)
                                : [0, 0];
                              const morningStartMin =
                                morningStart[0] * 60 + morningStart[1];
                              const morningEndMin =
                                morningEnd[0] * 60 + morningEnd[1];
                              const afternoonStartMin =
                                afternoonStart[0] * 60 + afternoonStart[1];
                              const afternoonEndMin =
                                afternoonEnd[0] * 60 + afternoonEnd[1];
                              if (
                                totalMinutes >= morningStartMin &&
                                totalMinutes <= morningEndMin
                              )
                                value = "Morning Shift";
                              else if (
                                totalMinutes >= afternoonStartMin &&
                                totalMinutes <= afternoonEndMin
                              )
                                value = "Afternoon Shift";
                              else value = "-";
                            }
                          }
                          if (col.key === "work_hours") {
                            if (!settings) {
                              value = "-";
                            } else {
                              let label = "";
                              let configTime = "";
                              if (row.event === "time-in" || row.event === "time-out") {
                                label = "Morning In";
                                configTime = settings.morning_start;
                                if (settings.morning_end && settings.afternoon_end) {
                                  const d = new Date(row.device_time);
                                  const minutes = d.getHours() * 60 + d.getMinutes();
                                  const morningEnd = settings.morning_end.split(":").map(Number);
                                  const morningEndMin = morningEnd[0] * 60 + morningEnd[1];
                                  const morningGrace = Number(settings.morning_grace_minutes) || 0;
                                  // If the time is past the morning shift, treat it as Afternoon Out
                                  if (minutes > morningEndMin + morningGrace) {
                                    label = "Afternoon Out";
                                    configTime = settings.afternoon_end;
                                  }
                                }
                              } else {
                                value = "-";
                              }
                              value =
                                label && configTime
                                  ? `${label}: ${configTime}`
                                  : "-";
                            }
                          }
                          const isLate = col.key === "status" && value === "late";
                          const isOnTime = col.key === "status" && value === "on-time";
                          const isOvertime = col.key === "status" && value === "overtime";
                          const isEarlyOut = col.key === "status" && value === "early-out";
                          const cellStyle = {
                            ...styles.td,
                            fontFamily:
                              col.key === "person_id" ? "monospace" : "inherit",
                            wordBreak: col.key === "point" ? "break-word" : "normal",
                            maxWidth: col.key === "point" ? "220px" : "none",
                            color: isLate
                              ? styles.lateText.color
                              : isOnTime
                              ? styles.onTimeText.color
                              : isOvertime
                              ? styles.overtimeText.color
                              : isEarlyOut
                              ? styles.earlyOutText.color
                              : styles.td.color,
                            fontWeight: isLate || isOnTime || isOvertime || isEarlyOut ? 600 : 400,
                          };
                          return (
                            <td key={col.key} style={cellStyle}>
                              {value || "-"}
                            </td>
                          );
                        })}
                        <td style={styles.td}>
                          <div style={styles.actionCell}>
                            {!row.archived ? (
                              <>
                                <button
                                  onClick={() => handleEdit(row)}
                                  style={styles.smallButton}
                                >
                                  Edit Time
                                </button>
                                <button
                                  onClick={() => handleArchive(row)}
                                  style={styles.smallButton}
                                >
                                  {Icons.archive} Archive
                                </button>
                                <button
                                  onClick={() => handleDeleteFromDahua(row)}
                                  style={{ ...styles.smallButton, background: "#dc2626", color: "#fff" }}
                                >
                                  Delete from Dahua
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => handleRestore(row)}
                                style={styles.smallButton}
                              >
                                {Icons.restore} Restore
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  }
                )
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
      {/* Photo modal for AttendanceTable */}
      {photoModal.visible && (
        <div
          onClick={() => closePhotoModal()}
          style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: '90%', maxHeight: '90%', borderRadius: 8, overflow: 'hidden', background: '#fff', padding: 12, boxShadow: '0 12px 40px rgba(2,6,23,0.4)' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => closePhotoModal()} aria-label="Close photo" style={{ background: 'transparent', border: 'none', color: '#0f172a', fontSize: 22, cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ textAlign: 'center' }}>
              <img src={photoModal.src} alt={photoModal.title} style={{ maxWidth: '100%', maxHeight: '80vh', display: 'block', margin: '0 auto' }} />
              {photoModal.title && <div style={{ marginTop: 8, color: '#0f172a' }}>{photoModal.title}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
