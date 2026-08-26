import { useEffect, useState, useCallback, useRef } from "react";
import { useLoading } from "../LoadingContext";
import { supabase } from "../supabaseClient";
import { getAttendanceStatus } from "./attendanceUtils";
import * as XLSX from "xlsx";
import Swal from "sweetalert2";
import { syncDahuaAttendance, deleteDahuaAttendance } from "../utils/dahuaApi";
import {
  FiSearch,
  FiDownload,
  FiArchive,
  FiRotateCcw,
  FiX,
  FiRefreshCw,
} from "react-icons/fi";

export default function AttendanceTable() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const sortKey = "device_time";
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
    return `${datePart} - ${timePart}`;
  };

  const showToast = (title, icon = "success") => {
    Swal.fire({
      toast: true,
      position: "top-end",
      icon,
      title,
      showConfirmButton: false,
      timer: 2500,
      timerProgressBar: true,
      iconColor: icon === "success" ? "#237227" : undefined,
      customClass: {
        popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
        title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
        timerProgressBar: "!bg-[#237227]",
      },
    });
  };

  const Icons = {
    download: <FiDownload />,
    archive: <FiArchive />,
    restore: <FiRotateCcw />,
    close: <FiX />,
  };

  const [syncingDahua, setSyncingDahua] = useState(false);
  const dahuaAttendanceSyncInFlightRef = useRef(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
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
      
      const { data: personsData, error: personsErr } = await supabase
        .from("persons")
        .select("id, name, department, registration_photo");
      if (personsErr) throw personsErr;
      setPersons(personsData || []);
      
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
      customClass: {
        popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[400px]",
        title: "!text-gray-800 !text-[1.35rem] !font-bold",
      },
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
        confirmButtonText: "OK",
        confirmButtonColor: "#237227",
        customClass: {
          popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[400px]",
          title: "!text-gray-800 !text-[1.35rem] !font-bold",
          confirmButton: "!bg-[#237227] hover:!bg-[#1a5a1d] !text-white !font-semibold !rounded-lg !px-6 !py-2.5 !text-sm cursor-pointer !m-0 !min-w-[100px]",
        },
        buttonsStyling: false,
      });

      await fetchData();
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Sync Failed",
        text: err.message || "Could not reach Dahua device.",
        confirmButtonText: "OK",
        customClass: {
          popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[400px]",
          title: "!text-gray-800 !text-[1.35rem] !font-bold",
          confirmButton: "!bg-red-500 hover:!bg-red-600 !text-white !font-semibold !rounded-lg !px-6 !py-2.5 !text-sm cursor-pointer !m-0 !min-w-[100px]",
        },
        buttonsStyling: false,
      });
    } finally {
      dahuaAttendanceSyncInFlightRef.current = false;
      setSyncingDahua(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) fetchData(); }, 60_000); 
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

  if (error) {
    return <p className="text-red-500">{error}</p>;
  }



  const handleEdit = async (rec) => {
    try {
      const d = rec.device_time ? new Date(rec.device_time) : new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const defaultTime = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

      const { value: formValues } = await Swal.fire({
        title: 'Edit Attendance',
        html: `
          <div style="text-align: left; margin-top: 1.25rem;">
            <!-- Time Field (Full Width) -->
            <div style="margin-bottom: 1rem;">
              <label style="display: block; font-size: 0.85rem; font-weight: 600; color: #374151; margin-bottom: 0.35rem;">
                Time
              </label>
              <input 
                id="swal-time" 
                type="time"
                step="1"
                value="${defaultTime}" 
                style="display: block; width: 100%; padding: 0.65rem 0.85rem; font-size: 0.95rem; border: 1.5px solid #d1d5db; border-radius: 0.75rem; outline: none; box-sizing: border-box; background: #ffffff; color: #1f2937; cursor: pointer; transition: all 0.15s ease;"
                onfocus="this.style.borderColor='#237227'; this.style.outline='none'; this.style.boxShadow='0 0 0 1px #237227';"
                onblur="this.style.borderColor='#d1d5db'; this.style.outline='none'; this.style.boxShadow='none';"
              />
            </div>

            <!-- 2-Column Grid for Event and Status -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem; margin-bottom: 0.5rem;">
              <!-- Column 1: Event Field -->
              <div>
                <label style="display: block; font-size: 0.85rem; font-weight: 600; color: #374151; margin-bottom: 0.35rem;">
                  Attendance Event
                </label>
                <select 
                  id="swal-event" 
                  style="display: block; width: 100%; padding: 0.65rem 0.85rem; font-size: 0.95rem; border: 1.5px solid #d1d5db; border-radius: 0.75rem; outline: none; box-sizing: border-box; background: #ffffff; color: #1f2937; cursor: pointer; transition: all 0.15s ease;"
                  onfocus="this.style.borderColor='#237227'; this.style.outline='none'; this.style.boxShadow='0 0 0 1px #237227';"
                  onblur="this.style.borderColor='#d1d5db'; this.style.outline='none'; this.style.boxShadow='none';"
                >
                  <option value="time-in" ${rec.event === 'time-in' ? 'selected' : ''}>Time In</option>
                  <option value="time-out" ${rec.event === 'time-out' ? 'selected' : ''}>Time Out</option>
                </select>
              </div>

              <!-- Column 2: Status Field -->
              <div>
                <label style="display: block; font-size: 0.85rem; font-weight: 600; color: #374151; margin-bottom: 0.35rem;">
                  Attendance Status
                </label>
                <select 
                  id="swal-status" 
                  style="display: block; width: 100%; padding: 0.65rem 0.85rem; font-size: 0.95rem; border: 1.5px solid #d1d5db; border-radius: 0.75rem; outline: none; box-sizing: border-box; background: #ffffff; color: #1f2937; cursor: pointer; transition: all 0.15s ease;"
                  onfocus="this.style.borderColor='#237227'; this.style.outline='none'; this.style.boxShadow='0 0 0 1px #237227';"
                  onblur="this.style.borderColor='#d1d5db'; this.style.outline='none'; this.style.boxShadow='none';"
                >
                  <option value="on-time" ${rec.status === 'on-time' ? 'selected' : ''}>on-time</option>
                  <option value="late" ${rec.status === 'late' ? 'selected' : ''}>late</option>
                  <option value="overtime" ${rec.status === 'overtime' ? 'selected' : ''}>overtime</option>
                </select>
              </div>
            </div>
          </div>
        `,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Save',
        confirmButtonColor: '#237227',
        cancelButtonColor: '#E5E7EB',
        customClass: {
          popup: '!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[460px]',
          title: '!text-gray-800 !text-[1.4rem] !font-bold !mt-1 !mb-0',
          actions: '!flex !items-center !justify-center !gap-4 !mt-6 !w-full',
          confirmButton: '!bg-[#237227] hover:!bg-[#1a5a1d] !text-white !font-semibold !rounded-lg !px-7 !py-2.5 !text-sm cursor-pointer !m-0 !min-w-[100px] !transform-none hover:!transform-none focus:!outline-none focus:!ring-0 focus:!shadow-none',
          cancelButton: '!bg-white !border !border-gray-300 !text-gray-700 !font-semibold !rounded-lg !px-7 !py-2.5 !text-sm cursor-pointer !m-0 !min-w-[100px] !transform-none hover:!transform-none focus:!outline-none focus:!ring-0 focus:!border-gray-300 focus:!shadow-none active:!outline-none active:!shadow-none !outline-none !shadow-none',
        },
        buttonsStyling: false,
        didOpen: () => {
          const timeInput = document.getElementById('swal-time');
          if (timeInput) {
            timeInput.addEventListener('click', () => {
              try {
                if (typeof timeInput.showPicker === 'function') {
                  timeInput.showPicker();
                }
              } catch (err) {}
            });
          }
        },
        preConfirm: () => {
          const timeVal = document.getElementById('swal-time').value.trim();
          const eventVal = document.getElementById('swal-event').value;
          const statusVal = document.getElementById('swal-status').value;
          if (!timeVal) { Swal.showValidationMessage('Time is required'); return false; }
          const fullTime = timeVal.length === 5 ? `${timeVal}:00` : timeVal;
          return { time: fullTime, event: eventVal, status: statusVal };
        }
      });
      if (!formValues) return;
      const { time, event, status } = formValues;
      const targetDate = rec.device_time ? new Date(rec.device_time) : new Date();
      const [h, m, s] = time.split(':').map(Number);
      targetDate.setHours(h || 0, m || 0, s || 0, 0);
      const iso = targetDate.toISOString();
      const { error } = await supabase.from('attendance').update({ device_time: iso, event, status }).eq('id', rec.id);
      if (error) {
        Swal.fire({
          title: 'Error',
          text: error.message,
          icon: 'error',
          confirmButtonText: 'OK',
          customClass: {
            popup: '!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[380px]',
            confirmButton: '!bg-red-500 hover:!bg-red-600 !text-white !font-semibold !rounded-lg !px-8 !py-2.5 !text-sm',
          },
          buttonsStyling: false,
        });
        return;
      }
      setRecords((prev) => prev.map((r) => (r.id === rec.id ? { ...r, device_time: iso, event, status } : r)));
      showToast('Attendance updated successfully!');
    } catch (e) {
      console.error('handleEdit failed', e);
      Swal.fire({
        title: 'Error',
        text: e.message || String(e),
        icon: 'error',
        confirmButtonText: 'OK',
        customClass: {
          popup: '!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[380px]',
          confirmButton: '!bg-red-500 hover:!bg-red-600 !text-white !font-semibold !rounded-lg !px-8 !py-2.5 !text-sm',
        },
        buttonsStyling: false,
      });
    }
  };

  const handleArchive = async (rec) => {
    const confirm = await Swal.fire({
      title: "Archive Attendance",
      text: "Are you sure you want to archive this record?",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Archive",
      confirmButtonColor: "#237227",
      cancelButtonColor: "#ffffff",
      customClass: {
        popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[380px]",
        title: "!text-gray-800 !text-[1.35rem] !font-bold !mt-2",
        actions: "!flex !items-center !justify-center !gap-4 !mt-6 !w-full",
        confirmButton: "!bg-[#237227] hover:!bg-[#1a5a1d] !text-white !font-semibold !rounded-lg !px-6 !py-2.5 !text-sm cursor-pointer !m-0 !min-w-[100px]",
        cancelButton: "!bg-white !border !border-gray-300 !text-gray-700 !font-semibold !rounded-lg !px-6 !py-2.5 !text-sm cursor-pointer !m-0 !min-w-[100px]",
      },
      buttonsStyling: false,
    });
    if (confirm.isConfirmed) {
      const { error: archErr } = await supabase
        .from("attendance")
        .update({ archived: true })
        .eq("id", rec.id);
      if (archErr) {
        Swal.fire({
          title: "Error",
          text: archErr.message,
          icon: "error",
          confirmButtonText: "OK",
          customClass: {
            popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[380px]",
            confirmButton: "!bg-red-500 hover:!bg-red-600 !text-white !font-semibold !rounded-lg !px-8 !py-2.5 !text-sm",
          },
          buttonsStyling: false,
        });
      } else {
        setRecords((prev) =>
          prev.map((r) => (r.id === rec.id ? { ...r, archived: true } : r))
        );
        showToast("Attendance archived successfully!");
      }
    }
  };

  const handleRestore = async (rec) => {
    const { error: resErr } = await supabase
      .from("attendance")
      .update({ archived: false })
      .eq("id", rec.id);
    if (resErr) {
      Swal.fire({
        title: "Error",
        text: resErr.message,
        icon: "error",
        confirmButtonText: "OK",
        customClass: {
          popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[380px]",
          confirmButton: "!bg-red-500 hover:!bg-red-600 !text-white !font-semibold !rounded-lg !px-8 !py-2.5 !text-sm",
        },
        buttonsStyling: false,
      });
    } else {
      setRecords((prev) =>
        prev.map((r) => (r.id === rec.id ? { ...r, archived: false } : r))
      );
      showToast("Attendance restored successfully!");
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
      cancelButtonColor: "#ffffff",
      customClass: {
        popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[380px]",
        title: "!text-gray-800 !text-[1.35rem] !font-bold !mt-2",
        actions: "!flex !items-center !justify-center !gap-4 !mt-6 !w-full",
        confirmButton: "!bg-[#dc2626] hover:!bg-red-700 !text-white !font-semibold !rounded-lg !px-6 !py-2.5 !text-sm cursor-pointer !m-0 !min-w-[100px]",
        cancelButton: "!bg-white !border !border-gray-300 !text-gray-700 !font-semibold !rounded-lg !px-6 !py-2.5 !text-sm cursor-pointer !m-0 !min-w-[100px]",
      },
      buttonsStyling: false,
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
      showToast("Attendance deleted from Dahua successfully!");
    } catch (err) {
      Swal.fire({
        title: "Delete failed",
        text: err.message || "Could not delete the Dahua record.",
        icon: "error",
        confirmButtonText: "OK",
        customClass: {
          popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[380px]",
          confirmButton: "!bg-red-500 hover:!bg-red-600 !text-white !font-semibold !rounded-lg !px-8 !py-2.5 !text-sm",
        },
        buttonsStyling: false,
      });
    }
  };

  const filteredRecords = records.filter((r) => {
    if (r.archived) return false;
    const person = persons.find((p) => p.id === r.person_id) || {};
    const matchesSearch =
      !search ||
      (person.name &&
        person.name.toLowerCase().includes(search.toLowerCase())) ||
      (r.person_id && r.person_id.toLowerCase().includes(search.toLowerCase()));
    const matchesStatus = !statusFilter || getAttendanceStatus(r, settings) === statusFilter;
    const matchesDept =
      !departmentFilter || (person.department || "") === departmentFilter;
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

  const archivedRecords = [...records]
    .filter((r) => r.archived)
    .filter((r) => {
      if (!selectedDate) return true;
      const rd = r.device_time ? new Date(r.device_time).toISOString().slice(0, 10) : null;
      return rd === selectedDate;
    })
    .sort((a, b) => new Date(b.device_time) - new Date(a.device_time));

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
    <div className="attendance-table-root mx-auto py-9 px-7 max-w-full font-sans bg-white min-h-screen text-[#2c382d]">
      <style>{`
        .attendance-table-root button,
        .attendance-table-root button:hover,
        .attendance-table-root button:hover:not(:disabled),
        .attendance-table-root button:focus,
        .attendance-table-root button:active,
        .attendance-table-root input,
        .attendance-table-root input:focus,
        .attendance-table-root select,
        .attendance-table-root select:focus,
        .attendance-table-root *:focus,
        .attendance-table-root div,
        .attendance-table-root img,
        .attendance-table-root a {
          transform: none !important;
          outline: none !important;
          box-shadow: none !important;
        }
        .attendance-table-root input:focus,
        .attendance-table-root select:focus {
          border-color: #dce3dd !important;
          outline: none !important;
          box-shadow: none !important;
        }
        .attendance-table-root button:focus,
        .attendance-table-root button:focus-visible {
          outline: none !important;
          box-shadow: none !important;
        }
        .attendance-table-root table tbody tr,
        .attendance-table-root table tbody tr td {
          transition: none !important;
        }
        .attendance-table-root table tbody tr:nth-child(odd),
        .attendance-table-root table tbody tr:nth-child(odd):hover,
        .attendance-table-root table tbody tr:nth-child(odd):hover td {
          background-color: #ffffff !important;
        }
        .attendance-table-root table tbody tr:nth-child(even),
        .attendance-table-root table tbody tr:nth-child(even):hover,
        .attendance-table-root table tbody tr:nth-child(even):hover td {
          background-color: #f9fafb !important;
        }
        .attendance-table-root table th,
        .attendance-table-root table th:hover {
          background-color: #ffffff !important;
        }

        /* SweetAlert2 Dialog Overrides */
        .swal2-container .swal2-popup button,
        .swal2-container .swal2-popup button:hover,
        .swal2-container .swal2-popup button:hover:not(:disabled),
        .swal2-container .swal2-popup button:focus,
        .swal2-container .swal2-popup button:active,
        .swal2-container .swal2-actions button,
        .swal2-container .swal2-actions button:hover,
        .swal2-container .swal2-actions button:focus {
          transform: none !important;
          outline: none !important;
          box-shadow: none !important;
        }
        .swal2-container .swal2-popup input,
        .swal2-container .swal2-popup select,
        .swal2-container #swal-time,
        .swal2-container #swal-event,
        .swal2-container #swal-status {
          outline: none !important;
          box-shadow: none !important;
        }
        .swal2-container .swal2-popup input:focus,
        .swal2-container .swal2-popup select:focus,
        .swal2-container #swal-time:focus,
        .swal2-container #swal-event:focus,
        .swal2-container #swal-status:focus {
          border-color: #237227 !important;
          outline: none !important;
          box-shadow: 0 0 0 1px #237227 !important;
        }
      `}</style>
      <div className="mb-6 flex flex-col items-start gap-1.5">
        <h1 className="text-[2.5rem] font-extrabold m-0 tracking-[-0.02em]">
          <span className="text-[#2c382d]">Attendance </span>
          <span className="text-[#237227]">Records</span>
        </h1>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-nowrap justify-between items-center gap-3.5 mb-5 py-3 px-4 bg-white rounded-xl shadow-[0_1px_4px_rgba(0,0,0,0.04)] border border-[#edf2ee] overflow-x-auto">
        <div className="flex flex-nowrap gap-2.5 items-center">
          <div className="relative">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm" />
            <input
              type="text"
              placeholder="Search name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="py-2 pr-3.5 pl-9 text-[0.85rem] rounded-md border border-[#dce3dd] bg-white text-[#2c382d] min-w-[180px] outline-none focus:border-[#237227] focus:ring-0 transition-colors"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="py-2 px-3 text-[0.85rem] rounded-md border border-[#dce3dd] bg-white text-[#2c382d] cursor-pointer min-w-[130px] outline-none focus:border-[#237227] focus:ring-0 transition-colors"
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
            className="py-2 px-3 text-[0.85rem] rounded-md border border-[#dce3dd] bg-white text-[#2c382d] cursor-pointer min-w-[130px] outline-none focus:border-[#237227] focus:ring-0 transition-colors"
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
            className="py-2 px-3 text-[0.85rem] rounded-md border border-[#dce3dd] bg-white text-[#2c382d] cursor-pointer min-w-[130px] outline-none focus:border-[#237227] focus:ring-0 transition-colors"
          />
          {selectedDate && (
            <button
              onClick={() => setSelectedDate("")}
              className="py-1.5 px-2.5 rounded-md border-none text-xs font-semibold cursor-pointer inline-flex items-center gap-1 bg-[#f6f8f6] text-[#2c382d] whitespace-nowrap ml-1 outline-none focus:outline-none"
            >
              {Icons.close} Clear
            </button>
          )}
          <button
            aria-label="Toggle sort order"
            onClick={() => setSortOrder((s) => (s === "asc" ? "desc" : "asc"))}
            className="py-2 px-4 rounded-md bg-[#237227] text-white text-[0.85rem] cursor-pointer font-semibold min-w-[60px] text-center outline-none focus:outline-none"
          >
            {sortOrder === "asc" ? "Asc" : "Desc"}
          </button>
        </div>

        <div className="flex gap-2.5 flex-nowrap items-center">
          <div className="inline-flex items-center justify-center py-[7px] px-3.5 rounded-md bg-white border border-[#237227] text-[#237227] text-[0.85rem] font-semibold whitespace-nowrap">
            {(showArchived ? archivedRecords.length : sortedRecords.length) + " records"}
          </div>
          <button
            onClick={() => setShowArchived((a) => !a)}
            className="inline-flex items-center gap-1.5 py-2 px-4 rounded-md text-[0.85rem] font-semibold cursor-pointer whitespace-nowrap bg-white text-[#237227] border border-[#237227] shadow-[0_1px_2px_rgba(0,0,0,0.03)] outline-none focus:outline-none"
          >
            {Icons.archive} {showArchived ? "Show Active" : "Show Archived"}
          </button>
          <button
            onClick={handleExportExcel}
            className="inline-flex items-center gap-1.5 py-2 px-4 rounded-md text-[0.85rem] font-semibold cursor-pointer whitespace-nowrap bg-[#237227] text-white shadow-[0_1px_4px_rgba(35,114,39,0.2)] border-none outline-none focus:outline-none"
          >
            {Icons.download} Export Excel
          </button>
          <button
            onClick={handleSyncDahuaAttendance}
            disabled={syncingDahua}
            className="inline-flex items-center gap-1.5 py-2 px-4 rounded-md text-[0.85rem] font-semibold cursor-pointer whitespace-nowrap bg-gradient-to-br from-[#059669] to-[#1d5e20] text-white shadow-[0_1px_4px_rgba(5,150,105,0.2)] border-none disabled:opacity-70 disabled:cursor-not-allowed outline-none focus:outline-none"
          >
            <FiRefreshCw className="mr-1.5" /> Sync Dahua
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-2xl overflow-hidden shadow-[0_2px_14px_rgba(44,56,45,0.06)] bg-white border-none min-h-[540px] flex flex-col justify-between">
        <div className="overflow-x-auto flex-1">
          <table className="w-full border-collapse text-[0.875rem] min-w-[1200px]">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.key} className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">
                    {col.label}
                  </th>
                ))}
                <th className="sticky top-0 z-10 bg-white text-black font-bold py-3.5 px-3.5 text-left border-b-2 border-gray-200 tracking-wide uppercase text-xs whitespace-nowrap">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {currentRecords.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} className="text-center py-[72px] px-5 text-[#677368] text-base">
                    {showArchived
                      ? "No archived attendance records found."
                      : "No attendance records found."}
                  </td>
                </tr>
              ) : (
                currentRecords.map((row, idx) => {
                  const person = persons.find((p) => p.id === row.person_id) || {};
                  
                  return (
                    <tr key={row.id} className="odd:bg-white even:bg-[#f9fafb]">
                      {columns.map((col) => {
                        if (col.key === "photo") {
                          return (
                            <td key="photo" className="py-[13px] px-3.5 border-b border-[#edf2ee] align-middle">
                              {person.registration_photo ? (
                                <div className="flex flex-col items-center gap-1">
                                  <img
                                    src={person.registration_photo}
                                    alt="registration"
                                    className="w-[52px] h-[52px] object-cover rounded-[10px] border-2 border-[#edf2ee] shadow-[0_2px_6px_rgba(0,0,0,0.06)] cursor-pointer"
                                    onClick={() => openPhotoModal(person.registration_photo, person.name || row.person_id)}
                                  />
                                  <span className="text-[0.68rem] text-[#677368] font-medium">
                                    {row.device_time
                                      ? new Date(row.device_time).toLocaleString(undefined, {
                                          hour: "2-digit",
                                          minute: "2-digit",
                                          second: "2-digit",
                                        })
                                      : ""}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-gray-400">No photo</span>
                              )}
                            </td>
                          );
                        }
                        
                        let value = row[col.key];
                        if (col.key === "name") value = person.name || "";
                        if (col.key === "department") value = person.department || "";
                        if (col.key === "status") value = getAttendanceStatus(row, settings);
                        if (col.key === "device_time" && row[col.key]) value = formatDateTime(row[col.key]);
                        if (col.key === "shift") {
                          if (!settings) value = "-";
                          else {
                            const time = new Date(row.device_time);
                            const hour = time.getHours();
                            const minute = time.getMinutes();
                            const totalMinutes = hour * 60 + minute;
                            const morningStart = settings.morning_start ? settings.morning_start.split(":").map(Number) : [0, 0];
                            const morningEnd = settings.morning_end ? settings.morning_end.split(":").map(Number) : [0, 0];
                            const afternoonStart = settings.afternoon_start ? settings.afternoon_start.split(":").map(Number) : [0, 0];
                            const afternoonEnd = settings.afternoon_end ? settings.afternoon_end.split(":").map(Number) : [0, 0];
                            const morningStartMin = morningStart[0] * 60 + morningStart[1];
                            const morningEndMin = morningEnd[0] * 60 + morningEnd[1];
                            const afternoonStartMin = afternoonStart[0] * 60 + afternoonStart[1];
                            const afternoonEndMin = afternoonEnd[0] * 60 + afternoonEnd[1];
                            
                            if (totalMinutes >= morningStartMin && totalMinutes <= morningEndMin) value = "Morning Shift";
                            else if (totalMinutes >= afternoonStartMin && totalMinutes <= afternoonEndMin) value = "Afternoon Shift";
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
                                if (minutes > morningEndMin + morningGrace) {
                                  label = "Afternoon Out";
                                  configTime = settings.afternoon_end;
                                }
                              }
                            } else {
                              value = "-";
                            }
                            value = label && configTime ? `${label}: ${configTime}` : "-";
                          }
                        }

                        if (col.key === "status") {
                          let badgeClass = "bg-gray-100 text-gray-700 border border-gray-200";
                          const lowerVal = String(value || "").toLowerCase().trim();

                          if (lowerVal === "on-time" || lowerVal === "on time") {
                            badgeClass = "bg-[#237227]/10 text-[#237227] border border-[#237227]/30";
                          } else if (lowerVal === "late") {
                            badgeClass = "bg-red-50 text-red-600 border border-red-200";
                          } else if (lowerVal === "early-out" || lowerVal === "early out") {
                            badgeClass = "bg-orange-50 text-orange-600 border border-orange-200";
                          } else if (lowerVal === "overtime") {
                            badgeClass = "bg-blue-50 text-blue-600 border border-blue-200";
                          }

                          return (
                            <td 
                              key={col.key} 
                              className="py-[13px] px-3.5 border-b border-[#edf2ee] align-middle"
                            >
                              {value && value !== "-" ? (
                                <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${badgeClass}`}>
                                  {value}
                                </span>
                              ) : (
                                "-"
                              )}
                            </td>
                          );
                        }

                        return (
                          <td 
                            key={col.key} 
                            className={`py-[13px] px-3.5 border-b border-[#edf2ee] align-middle text-[#2c382d] font-normal ${col.key === 'person_id' ? 'font-mono' : ''} ${col.key === 'point' ? 'max-w-[220px] break-words' : 'whitespace-normal'}`}
                          >
                            {value || "-"}
                          </td>
                        );
                      })}
                      
                      <td className="py-[13px] px-3.5 border-b border-[#edf2ee] align-middle text-[#2c382d]">
                        <div className="flex flex-row gap-2 flex-nowrap items-center justify-start">
                          {!row.archived ? (
                            <>
                              <button
                                onClick={() => handleEdit(row)}
                                className="py-1.5 px-2.5 rounded-md border-none text-xs font-semibold cursor-pointer inline-flex items-center gap-1 bg-[#237227] text-[#ffffff] tracking-[0.01em] whitespace-nowrap outline-none focus:outline-none"
                              >
                                Edit Time
                              </button>
                              <button
                                onClick={() => handleArchive(row)}
                                className="py-1.5 px-2.5 rounded-md border border-gray-300 text-xs font-semibold cursor-pointer inline-flex items-center gap-1 bg-white text-[#2c382d] tracking-[0.01em] whitespace-nowrap outline-none focus:outline-none"
                              >
                                {Icons.archive} Archive
                              </button>
                              <button
                                onClick={() => handleDeleteFromDahua(row)}
                                className="py-1.5 px-2.5 rounded-md border-none text-xs font-semibold cursor-pointer inline-flex items-center gap-1 bg-[#dc2626] text-white tracking-[0.01em] whitespace-nowrap outline-none focus:outline-none"
                              >
                                Delete from Dahua
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => handleRestore(row)}
                              className="py-1.5 px-2.5 rounded-md border-none text-xs font-semibold cursor-pointer inline-flex items-center gap-1 bg-[#237227] hover:bg-[#1a5a1d] text-white tracking-[0.01em] whitespace-nowrap outline-none focus:outline-none"
                            >
                              {Icons.restore} Restore
                            </button>
                          )}
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
          <div className="text-[#677368] text-[0.875rem]">
            Showing <strong>{totalRecords === 0 ? 0 : startIndex + 1}</strong> to <strong>{Math.min(startIndex + itemsPerPage, totalRecords)}</strong> of <strong>{totalRecords}</strong> records
          </div>
          <div className="flex gap-1.5 items-center">
            <button 
              className="flex items-center justify-center min-w-[32px] h-8 px-1.5 rounded-lg border border-[#dce3dd] bg-white text-[#677368] text-[0.85rem] font-semibold cursor-pointer outline-none focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              &lt;
            </button>
            
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(currentPage - p) <= 1)
              .map((p, idx, arr) => {
                const isActive = p === currentPage;
                const renderButton = (
                  <button
                    key={p}
                    className={`flex items-center justify-center min-w-[32px] h-8 px-1.5 rounded-lg border text-[0.85rem] font-semibold cursor-pointer outline-none focus:outline-none ${
                      isActive 
                        ? "!bg-[#237227] !text-white !border-[#237227]" 
                        : "border-[#dce3dd] bg-white text-[#677368]"
                    }`}
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
              className="flex items-center justify-center min-w-[32px] h-8 px-1.5 rounded-lg border border-[#dce3dd] bg-white text-[#677368] text-[0.85rem] font-semibold cursor-pointer outline-none focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              &gt;
            </button>
          </div>
        </div>
      </div>
      
      {/* Photo modal */}
      {photoModal.visible && (
        <div
          onClick={() => closePhotoModal()}
          className="fixed inset-0 bg-black/60 z-[10000] flex items-center justify-center p-5"
        >
          <div 
            onClick={(e) => e.stopPropagation()} 
            className="max-w-[90%] max-h-[90%] rounded-lg overflow-hidden bg-white p-3 shadow-[0_12px_40px_rgba(2,6,23,0.4)]"
          >
            <div className="flex justify-end">
              <button 
                onClick={() => closePhotoModal()} 
                aria-label="Close photo" 
                className="bg-transparent border-none text-slate-900 text-[22px] cursor-pointer"
              >
                ×
              </button>
            </div>
            <div className="text-center">
              <img 
                src={photoModal.src} 
                alt={photoModal.title} 
                className="max-w-full max-h-[80vh] block mx-auto" 
              />
              {photoModal.title && <div className="mt-2 text-slate-900">{photoModal.title}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}