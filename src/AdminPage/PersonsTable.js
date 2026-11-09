import { useEffect, useState, useRef } from "react";
import { supabase } from "../mysqlClient";
import Swal from "sweetalert2";
import * as XLSX from "xlsx";
import {
  FiDownload,
  FiArchive,
  FiEdit,
  FiBriefcase,
  FiPhone,
  FiMail,
  FiPlusCircle,
  FiRefreshCw,
  FiSearch,
  FiAlertCircle,
  FiCheckCircle,
  FiCalendar,
  FiClock,
  FiPlus,
  FiMoon,
} from "react-icons/fi";
import { determineAttendanceStatus } from "./attendanceUtils";
import { syncDahuaUsers } from "../utils/dahuaApi";


function DateTimeInput({ value, onChange, className, id, name }) {
  const inputRef = useRef(null);
  const isTypingRef = useRef(false);

  useEffect(() => {
    if (inputRef.current) {
      const currentVal = inputRef.current.value;
      const targetVal = value ? String(value).slice(0, 16) : "";
      if (!isTypingRef.current && currentVal !== targetVal) {
        inputRef.current.value = targetVal;
      }
    }
  }, [value]);

  return (
    <input
      ref={inputRef}
      id={id}
      name={name}
      type="datetime-local"
      defaultValue={value ? String(value).slice(0, 16) : ""}
      onFocus={() => {
        isTypingRef.current = true;
      }}
      onBlur={(e) => {
        isTypingRef.current = false;
        if (e.target.value && onChange) {
          onChange(e.target.value);
        }
      }}
      onKeyDown={() => {
        isTypingRef.current = true;
      }}
      onChange={(e) => {
        if (e.target.value && onChange) {
          onChange(e.target.value);
        }
      }}
      className={className}
    />
  );
}

export default function PersonsTable() {
  const [search, setSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [sortKey] = useState("created_at");
  const [sortOrder] = useState("desc");
  const [showArchived, setShowArchived] = useState(false);

  const [persons, setPersons] = useState([]);
  const [photoModal, setPhotoModal] = useState({ visible: false, src: "", title: "" });
  const [presenceMap, setPresenceMap] = useState({});
  const [departments, setDepartments] = useState([]);
  const [deptRatesList, setDeptRatesList] = useState([]);
  const [syncingDahuaUsers, setSyncingDahuaUsers] = useState(false);
  const [error, setError] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editPerson, setEditPerson] = useState(null);
  const [editCashAdvances, setEditCashAdvances] = useState([]);
  const [loadingCashAdvances, setLoadingCashAdvances] = useState(false);
  const [newCashAmount, setNewCashAmount] = useState("");
  const [newCashNote, setNewCashNote] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [adminModal, setAdminModal] = useState({ visible: false, person: null, event: "time-in", datetime: "", photo: null, note: "" });
  const [missingRecords, setMissingRecords] = useState([]);
  const [loadingMissing, setLoadingMissing] = useState(false);
  const [missingPeriod, setMissingPeriod] = useState("current");
  const [missingFilter, setMissingFilter] = useState("all");
  const [adminSettings, setAdminSettings] = useState(null);
  const [adminHolidays, setAdminHolidays] = useState([]);
  const [nsdModal, setNsdModal] = useState({
    visible: false,
    person: null,
    hours: "0.0",
  });

  useEffect(() => {
    async function fetchPersons() {
      if (!supabase) {
        setError(
          "Supabase client not configured. Check REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY in your environment.",
        );
        return;
      }
      try {
        setError(null);
        const { data, error: err } = await supabase
          .from("persons")
          .select("id, name, department, daily_rate, late_penalty, sss, pag_ibig, philhealth, cash_advance, card_no, created_at, updated_at, night_shift_diff");
        if (err) throw err;
        const list = data || [];
        setPersons(list);

        // Fetch department rates list
        try {
          const { data: deptData, error: deptErr } = await supabase
            .from("department_rates")
            .select("*");
          if (!deptErr && Array.isArray(deptData)) {
            setDeptRatesList(deptData);
            const uniq = Array.from(
              new Set(deptData.map((d) => d.department).filter(Boolean)),
            );
            setDepartments(uniq);
          }
        } catch (e) {
          // ignore department fetch errors
        }

        // Fetch today's attendance for presence
        try {
          const ids = list.map((p) => p.id).filter(Boolean);
          if (ids.length) {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, "0");
            const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            const { data: atts, error: attErr } = await supabase
              .from("attendance")
              .select("person_id, event, device_time")
              .in("person_id", ids)
              .gte("device_time", `${todayStr} 00:00:00`)
              .lte("device_time", `${todayStr} 23:59:59`);
              if (!attErr && Array.isArray(atts)) {
                const pmap = {};
                atts.forEach((r) => {
                  const pid = r.person_id;
                  if (!pmap[pid])
                    pmap[pid] = {
                      morning: false,
                      afternoon: false,
                      firstScan: null,
                    };
                  try {
                    const dt = new Date(r.device_time);
                    const hour = dt.getHours();
                    const evt = (r.event || "").toLowerCase();
                    if (evt === "time-in" || evt === "time-out") {
                      if (hour < 12) pmap[pid].morning = true;
                      else pmap[pid].afternoon = true;
                    }
                    pmap[pid].hasAttendance = true;
                    // track earliest attendance scan for the person today
                    if (!pmap[pid].firstScan)
                      pmap[pid].firstScan = dt.toISOString();
                    else {
                      const existing = new Date(pmap[pid].firstScan);
                      if (dt.getTime() < existing.getTime())
                        pmap[pid].firstScan = dt.toISOString();
                    }
                  } catch (e) {}
                });
                // mark present if any session true or has attendance
                Object.keys(pmap).forEach((k) => {
                  pmap[k].present = !!(pmap[k].morning || pmap[k].afternoon || pmap[k].hasAttendance);
                });
                setPresenceMap(pmap);
              }
            }
          } catch (e) {
            // ignore attendance fetch errors
          }
      } catch (err) {
        setError(err.message || "Failed to load persons.");
      }
    }
    fetchPersons();
    const interval = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) fetchPersons(); }, 60_000); // 60s
    return () => clearInterval(interval);
  }, []);

  const handleEdit = (person) => {
    setEditPerson({ ...person });
    setShowEditModal(true);
  };

  const editPersonId = editPerson && editPerson.id ? editPerson.id : null;

  // Load recent cash advance history for the person when opening the edit modal
  useEffect(() => {
    let mounted = true;
    async function loadCashAdvances() {
      if (!showEditModal || !editPersonId) {
        setEditCashAdvances([]);
        return;
      }
      setLoadingCashAdvances(true);
      try {
        const { data, error } = await supabase
          .from("cash_advances")
          .select("id, amount, note, created_at")
          .eq("person_id", editPersonId)
          .order("created_at", { ascending: false })
          .limit(10);
        if (!mounted) return;
        if (error) {
          console.error("Error fetching cash advances:", error);
          setEditCashAdvances([]);
        } else {
          setEditCashAdvances(data || []);
        }
      } catch (e) {
        console.error(e);
        if (mounted) setEditCashAdvances([]);
      } finally {
        if (mounted) setLoadingCashAdvances(false);
      }
    }
    loadCashAdvances();
    return () => {
      mounted = false;
    };
  }, [showEditModal, editPersonId]);

  const refreshCashAdvances = async () => {
    if (!editPerson || !editPerson.id) return;
    setLoadingCashAdvances(true);
    try {
      const { data, error } = await supabase
        .from("cash_advances")
        .select("id, amount, note, created_at")
        .eq("person_id", editPerson.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      setEditCashAdvances(data || []);
    } catch (e) {
      console.error("refreshCashAdvances error", e);
      setEditCashAdvances([]);
    } finally {
      setLoadingCashAdvances(false);
    }
  };

  const computeAndUpdatePersonCashAdvance = async () => {
    if (!editPerson || !editPerson.id) return;
    try {
      const { data: rows, error } = await supabase
        .from("cash_advances")
        .select("amount")
        .eq("person_id", editPerson.id);
      if (error) throw error;
      const total = (rows || []).reduce((s, r) => s + Number(r.amount || 0), 0);
      // Update local editPerson and main persons list
      setEditPerson((p) => (p ? { ...p, cash_advance: total } : p));
      setPersons((prev) =>
        prev.map((p) =>
          p.id === editPerson.id ? { ...p, cash_advance: total } : p,
        ),
      );
    } catch (e) {
      console.error("computeAndUpdatePersonCashAdvance", e);
    }
  };

  const addCashAdvance = async () => {
    if (!editPerson || !editPerson.id) return;
    const amt = Number(newCashAmount);
    if (Number.isNaN(amt) || amt <= 0) {
      Swal.fire(
        "Invalid amount",
        "Enter a positive cash advance amount.",
        "error",
      );
      return;
    }
    setActionLoading(true);
    try {
      const { error } = await supabase
        .from("cash_advances")
        .insert({
          person_id: editPerson.id,
          amount: amt,
          note: newCashNote || null,
        })
        .select()
        .single();
      if (error) throw error;
      await refreshCashAdvances();
      await computeAndUpdatePersonCashAdvance();
      setNewCashAmount("");
      setNewCashNote("");
      Swal.fire({
        toast: true,
        position: "top-end",
        icon: "success",
        title: "Cash advance recorded successfully!",
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
        iconColor: "#237227",
        customClass: {
          popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
          title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
          timerProgressBar: "!bg-[#237227]",
        },
      });
    } catch (e) {
      console.error(e);
      Swal.fire({
        icon: "error",
        title: "Error",
        text: e.message || String(e),
        width: "380px",
        padding: "1.75rem",
        confirmButtonText: "OK",
        buttonsStyling: false,
        customClass: {
          popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !border !border-gray-100 font-sans",
          title: "!text-xl !font-bold !text-gray-800 !mt-2",
          htmlContainer: "!text-sm !text-gray-600",
          icon: "!scale-90 !my-2",
          actions: "!flex !items-center !justify-center !mt-5 !w-full",
          confirmButton: "!bg-[#237227] hover:!bg-[#1e5f21] !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !m-0 !shadow-none !transform-none",
        },
      });
    } finally {
      setActionLoading(false);
    }
  };

  const deleteCashAdvance = async (id) => {
    if (!id) return;
    const res = await Swal.fire({
      title: "Delete entry?",
      text: "This will remove the cash advance record.",
      icon: "warning",
      width: "380px",
      padding: "1.75rem",
      showCancelButton: true,
      confirmButtonText: "Delete",
      cancelButtonText: "Cancel",
      buttonsStyling: false,
      customClass: {
        popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !border !border-gray-100 font-sans",
        title: "!text-xl !font-bold !text-gray-800 !mt-2",
        htmlContainer: "!text-sm !text-gray-600",
        icon: "!scale-90 !my-2",
        actions: "!flex !items-center !justify-center !gap-3 !mt-5 !w-full",
        confirmButton: "!bg-red-600 hover:!bg-red-700 !text-white !font-semibold !rounded-xl !px-6 !py-2.5 !text-sm !border-none cursor-pointer !m-0 !shadow-none !transform-none",
        cancelButton: "!bg-white !text-gray-700 !font-semibold !rounded-xl !px-6 !py-2.5 !text-sm !border !border-gray-300 cursor-pointer !m-0 !shadow-none !transform-none",
      },
    });
    if (!res.isConfirmed) return;
    setActionLoading(true);
    try {
      const { error } = await supabase
        .from("cash_advances")
        .delete()
        .eq("id", id);
      if (error) throw error;
      await refreshCashAdvances();
      await computeAndUpdatePersonCashAdvance();
      Swal.fire({
        toast: true,
        position: "top-end",
        icon: "success",
        title: "Cash advance removed successfully!",
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
        iconColor: "#237227",
        customClass: {
          popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
          title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
          timerProgressBar: "!bg-[#237227]",
        },
      });
    } catch (e) {
      console.error(e);
      Swal.fire({
        icon: "error",
        title: "Error",
        text: e.message || String(e),
        width: "380px",
        padding: "1.75rem",
        confirmButtonText: "OK",
        buttonsStyling: false,
        customClass: {
          popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !border !border-gray-100 font-sans",
          title: "!text-xl !font-bold !text-gray-800 !mt-2",
          htmlContainer: "!text-sm !text-gray-600",
          icon: "!scale-90 !my-2",
          actions: "!flex !items-center !justify-center !mt-5 !w-full",
          confirmButton: "!bg-[#237227] hover:!bg-[#1e5f21] !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !m-0 !shadow-none !transform-none",
        },
      });
    } finally {
      setActionLoading(false);
    }
  };

  // Note: sorting is controlled by `sortKey`/`sortOrder` state via UI inputs.

  // Archive modal
  const handleArchive = async (person) => {
    Swal.fire({
      title: "Archive Person",
      html: `<div style='margin-bottom:12px;'>Are you sure you want to archive <b>${
        person.name || person.id
      }</b>?</div>`,
      icon: "warning",
      width: "380px",
      padding: "1.75rem",
      showCancelButton: true,
      confirmButtonText: "Archive",
      cancelButtonText: "Cancel",
      buttonsStyling: false,
      customClass: {
        popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !border !border-gray-100 font-sans",
        title: "!text-xl !font-bold !text-gray-800 !mt-2",
        htmlContainer: "!text-sm !text-gray-600",
        icon: "!scale-90 !my-2",
        actions: "!flex !items-center !justify-center !gap-3 !mt-5 !w-full",
        confirmButton: "!bg-[#237227] hover:!bg-[#1e5f21] !text-white !font-semibold !rounded-xl !px-6 !py-2.5 !text-sm !border-none cursor-pointer !m-0 !shadow-none !transform-none",
        cancelButton: "!bg-white !text-gray-700 !font-semibold !rounded-xl !px-6 !py-2.5 !text-sm !border !border-gray-300 cursor-pointer !m-0 !shadow-none !transform-none",
      },
    }).then(async (result) => {
      if (result.isConfirmed) {
        const { error: archErr } = await supabase
          .from("persons")
          .update({ archived: true })
          .eq("id", person.id);
        if (archErr) {
          Swal.fire({
            icon: "error",
            title: "Error",
            text: archErr.message,
            width: "380px",
            padding: "1.75rem",
            confirmButtonText: "OK",
            buttonsStyling: false,
            customClass: {
              popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !border !border-gray-100 font-sans",
              title: "!text-xl !font-bold !text-gray-800 !mt-2",
              htmlContainer: "!text-sm !text-gray-600",
              icon: "!scale-90 !my-2",
              actions: "!flex !items-center !justify-center !mt-5 !w-full",
              confirmButton: "!bg-[#237227] hover:!bg-[#1e5f21] !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !m-0 !shadow-none !transform-none",
            },
          });
        } else {
          setPersons((prev) =>
            prev.map((p) =>
              p.id === person.id ? { ...p, archived: true } : p,
            ),
          );
          Swal.fire({
            toast: true,
            position: "top-end",
            icon: "success",
            title: `${person.name || person.id} archived successfully!`,
            showConfirmButton: false,
            timer: 2500,
            timerProgressBar: true,
            iconColor: "#237227",
            customClass: {
              popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
              title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
              timerProgressBar: "!bg-[#237227]",
            },
          });
        }
      }
    });
  };

  const handleRestore = async (person) => {
    const { error: err } = await supabase
      .from("persons")
      .update({ archived: false })
      .eq("id", person.id);

    if (err) {
      Swal.fire("Error", err.message, "error");
    } else {
      setPersons((prev) =>
        prev.map((p) => (p.id === person.id ? { ...p, archived: false } : p))
      );
      Swal.fire({
        toast: true,
        position: "top-end",
        icon: "success",
        title: `${person.name || person.id} restored to active successfully!`,
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
        iconColor: "#237227",
        customClass: {
          popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
          title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
          timerProgressBar: "!bg-[#237227]",
        },
      });
    }
  };

  const handleDeletePerson = async (person) => {
    const result = await Swal.fire({
      title: "Delete Person?",
      html: `<div style='margin-bottom:12px;'>Are you sure you want to <b>permanently delete</b> <b>${
        person.name || person.id
      }</b> from database?</div>`,
      icon: "warning",
      width: "400px",
      padding: "1.75rem",
      showCancelButton: true,
      confirmButtonText: "Delete",
      cancelButtonText: "Cancel",
      buttonsStyling: false,
      customClass: {
        popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !border !border-gray-100 font-sans",
        title: "!text-xl !font-bold !text-gray-800 !mt-2",
        htmlContainer: "!text-sm !text-gray-600",
        icon: "!scale-90 !my-2",
        actions: "!flex !items-center !justify-center !gap-3 !mt-5 !w-full",
        confirmButton: "!bg-red-600 hover:!bg-red-700 !text-white !font-semibold !rounded-xl !px-6 !py-2.5 !text-sm !border-none cursor-pointer !m-0 !shadow-none !transform-none",
        cancelButton: "!bg-white !text-gray-700 !font-semibold !rounded-xl !px-6 !py-2.5 !text-sm !border !border-gray-300 cursor-pointer !m-0 !shadow-none !transform-none",
      },
    });

    if (!result.isConfirmed) return;

    try {
      const { error: delErr } = await supabase
        .from("persons")
        .delete()
        .eq("id", person.id);
      if (delErr) throw delErr;

      setPersons((prev) => prev.filter((p) => p.id !== person.id));
      Swal.fire({
        toast: true,
        position: "top-end",
        icon: "success",
        title: `${person.name || person.id} deleted permanently!`,
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
        iconColor: "#237227",
        customClass: {
          popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
          title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
          timerProgressBar: "!bg-[#237227]",
        },
      });
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Delete Failed",
        text: err.message || "Could not delete person from database.",
        confirmButtonText: "OK",
      });
    }
  };

  const getPeriodRange = (type, refDate = new Date()) => {
    const pad = (n) => String(n).padStart(2, "0");
    const y = refDate.getFullYear();
    const m = refDate.getMonth();
    const d = refDate.getDate();

    if (type === "previous") {
      if (d <= 15) {
        const prevMonthLastDay = new Date(y, m, 0).getDate();
        const prevDate = new Date(y, m - 1, 1);
        const py = prevDate.getFullYear();
        const pm = pad(prevDate.getMonth() + 1);
        return {
          start: `${py}-${pm}-16`,
          end: `${py}-${pm}-${pad(prevMonthLastDay)}`,
          label: `Previous Cutoff (${py}-${pm}-16 to ${pad(prevMonthLastDay)})`,
        };
      } else {
        return {
          start: `${y}-${pad(m + 1)}-01`,
          end: `${y}-${pad(m + 1)}-15`,
          label: `Previous Cutoff (${y}-${pad(m + 1)}-01 to 15)`,
        };
      }
    }

    if (type === "last30") {
      const past = new Date(refDate);
      past.setDate(past.getDate() - 30);
      const py = past.getFullYear();
      const pm = pad(past.getMonth() + 1);
      const pd = pad(past.getDate());
      const ty = y;
      const tm = pad(m + 1);
      const td = pad(d);
      return {
        start: `${py}-${pm}-${pd}`,
        end: `${ty}-${tm}-${td}`,
        label: `Last 30 Days (${py}-${pm}-${pd} to ${td})`,
      };
    }

    // Default: current cutoff
    if (d <= 15) {
      return {
        start: `${y}-${pad(m + 1)}-01`,
        end: `${y}-${pad(m + 1)}-15`,
        label: `Current Cutoff (${y}-${pad(m + 1)}-01 to 15)`,
      };
    } else {
      const lastDay = new Date(y, m + 1, 0).getDate();
      return {
        start: `${y}-${pad(m + 1)}-16`,
        end: `${y}-${pad(m + 1)}-${pad(lastDay)}`,
        label: `Current Cutoff (${y}-${pad(m + 1)}-16 to ${pad(lastDay)})`,
      };
    }
  };

  const fetchMissingRecordsForPerson = async (person, periodType = "current") => {
    if (!person || !person.id) return;
    setLoadingMissing(true);
    try {
      let settings = adminSettings;
      if (!settings) {
        const { data: sData } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();
        if (sData) {
          settings = sData;
          setAdminSettings(sData);
        }
      }
      let holidays = adminHolidays;
      if (!holidays || !holidays.length) {
        const { data: hData } = await supabase.from("holidays").select("*");
        if (hData) {
          holidays = hData;
          setAdminHolidays(hData);
        }
      }

      const { start, end } = getPeriodRange(periodType);
      const pad = (n) => String(n).padStart(2, "0");

      const morningEnd = settings?.morning_end || "11:59";
      const afternoonEnd = settings?.afternoon_end || "17:00";

      const now = new Date();
      const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

      const [mEndH, mEndM] = morningEnd.split(":").map(Number);
      const morningEndMin = (mEndH || 11) * 60 + (mEndM || 59);

      const [aEndH, aEndM] = afternoonEnd.split(":").map(Number);
      const afternoonEndMin = (aEndH || 17) * 60 + (aEndM || 0);

      const holidaySet = new Set((holidays || []).map((h) => (h.date ? String(h.date).slice(0, 10) : "")));

      const nextDay = new Date(end);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = `${nextDay.getFullYear()}-${pad(nextDay.getMonth() + 1)}-${pad(nextDay.getDate())}`;

      const { data: attData } = await supabase
        .from("attendance")
        .select("id, event, device_time, attendance_work_date, attendance_slot, status, archived")
        .eq("person_id", person.id)
        .gte("device_time", `${start} 00:00:00`)
        .lte("device_time", `${nextDayStr} 04:00:00`);

      const validRecords = (attData || []).filter((r) => !r.archived);

      const byDate = {};
      validRecords.forEach((r) => {
        if (!r.device_time) return;
        let workDate = r.attendance_work_date ? String(r.attendance_work_date).slice(0, 10) : null;
        if (!workDate) {
          const match = String(r.device_time).match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})/);
          if (match) {
            const dStr = match[1];
            const h = Number(match[2]);
            if (h < 3) {
              const [yy, mm, dd] = dStr.split("-").map(Number);
              const prev = new Date(yy, mm - 1, dd - 1);
              workDate = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}-${pad(prev.getDate())}`;
            } else {
              workDate = dStr;
            }
          } else {
            workDate = String(r.device_time).slice(0, 10);
          }
        }
        if (!byDate[workDate]) byDate[workDate] = [];
        byDate[workDate].push(r);
      });

      const missingList = [];
      const sObj = new Date(start);
      const eObj = new Date(end);

      for (let cur = new Date(sObj); cur <= eObj; cur.setDate(cur.getDate() + 1)) {
        const dateStr = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
        if (dateStr > todayStr) continue;

        const isWeekend = cur.getDay() === 0 || cur.getDay() === 6;
        const hasPunches = Array.isArray(byDate[dateStr]) && byDate[dateStr].length > 0;
        const isHoliday = holidaySet.has(dateStr);

        if ((isWeekend || isHoliday) && !hasPunches) continue;

        const dayRecords = byDate[dateStr] || [];
        const inRec = dayRecords.find((r) => r.event === "time-in" || (r.attendance_slot && r.attendance_slot.includes("in")));
        const outRec = dayRecords.find((r) => r.event === "time-out" || (r.attendance_slot && r.attendance_slot.includes("out")));

        const hasIn = Boolean(inRec);
        const hasOut = Boolean(outRec);
        const isToday = dateStr === todayStr;

        const formatPunchTime = (rec) => {
          if (!rec || !rec.device_time) return null;
          const match = String(rec.device_time).match(/(\d{2}):(\d{2})/);
          if (!match) return null;
          let [hh, mm] = [Number(match[1]), Number(match[2])];
          const ampm = hh >= 12 ? "PM" : "AM";
          hh = hh % 12 || 12;
          return `${pad(hh)}:${pad(mm)} ${ampm}`;
        };

        if (isToday) {
          const morningPassed = nowMinutes > morningEndMin;
          const afternoonPassed = nowMinutes > afternoonEndMin;

          if (morningPassed && !hasIn && afternoonPassed && !hasOut) {
            missingList.push({
              date: dateStr,
              type: "missing-both",
              label: "Missing Time In & Out",
              hasIn: false,
              hasOut: false,
              recordedIn: null,
              recordedOut: null,
              isToday: true,
            });
          } else if (morningPassed && !hasIn) {
            missingList.push({
              date: dateStr,
              type: "missing-in",
              label: "Missing Time In",
              hasIn: false,
              hasOut: true,
              recordedIn: null,
              recordedOut: formatPunchTime(outRec),
              isToday: true,
            });
          } else if (afternoonPassed && !hasOut) {
            missingList.push({
              date: dateStr,
              type: "missing-out",
              label: "Missing Time Out",
              hasIn: true,
              hasOut: false,
              recordedIn: formatPunchTime(inRec),
              recordedOut: null,
              isToday: true,
            });
          }
        } else {
          if (!hasIn && !hasOut) {
            missingList.push({
              date: dateStr,
              type: "missing-both",
              label: "No Records (Whole Day)",
              hasIn: false,
              hasOut: false,
              recordedIn: null,
              recordedOut: null,
              isToday: false,
            });
          } else if (!hasIn && hasOut) {
            missingList.push({
              date: dateStr,
              type: "missing-in",
              label: "Missing Time In",
              hasIn: false,
              hasOut: true,
              recordedIn: null,
              recordedOut: formatPunchTime(outRec),
              isToday: false,
            });
          } else if (hasIn && !hasOut) {
            missingList.push({
              date: dateStr,
              type: "missing-out",
              label: "Missing Time Out",
              hasIn: true,
              hasOut: false,
              recordedIn: formatPunchTime(inRec),
              recordedOut: null,
              isToday: false,
            });
          }
        }
      }

      setMissingRecords(missingList.sort((a, b) => b.date.localeCompare(a.date)));
    } catch (err) {
      console.error("Error fetching missing records:", err);
      setMissingRecords([]);
    } finally {
      setLoadingMissing(false);
    }
  };

  const handleFillMissing = (item, eventType) => {
    const morningTime = adminSettings?.morning_start ? adminSettings.morning_start.slice(0, 5) : "08:00";
    const afternoonTime = adminSettings?.afternoon_end ? adminSettings.afternoon_end.slice(0, 5) : "17:00";
    const fillTime = eventType === "time-in" ? morningTime : afternoonTime;
    const newDatetime = `${item.date}T${fillTime}`;

    setAdminModal((prev) => ({
      ...prev,
      event: eventType,
      datetime: newDatetime,
    }));
  };

  // Admin: record attendance on behalf of a person (customize attendance)
  const handleAdminAttendance = (person) => {
    if (!person || !person.id) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const localIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
      now.getDate(),
    )}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    setAdminModal({
      visible: true,
      person,
      event: "time-in",
      datetime: localIso,
      photo: null,
      note: "",
    });
    setMissingPeriod("current");
    setMissingFilter("all");
    fetchMissingRecordsForPerson(person, "current");
  };

  // Open Night Shift Differential Modal
  const handleOpenNsdModal = (person) => {
    if (!person || !person.id) return;
    const currentVal =
      person.night_shift_diff != null
        ? String(Number(person.night_shift_diff))
        : "0.0";
    setNsdModal({
      visible: true,
      person,
      hours: currentVal,
    });
  };

  const handleCloseNsdModal = () => {
    setNsdModal({ visible: false, person: null, hours: "0.0" });
  };

  const handleSaveNsdModal = async () => {
    if (!nsdModal.person || !nsdModal.person.id) return;
    const hoursNum = Math.max(0, parseFloat(nsdModal.hours) || 0);
    setActionLoading(true);
    try {
      const { error } = await supabase
        .from("persons")
        .update({ night_shift_diff: hoursNum })
        .eq("id", nsdModal.person.id);
      if (error) throw error;

      setPersons((prev) =>
        prev.map((p) =>
          p.id === nsdModal.person.id
            ? { ...p, night_shift_diff: hoursNum }
            : p,
        ),
      );

      const personName = nsdModal.person.name;
      handleCloseNsdModal();

      Swal.fire({
        icon: "success",
        title: "NSD Updated",
        text: `Night Shift Differential for ${personName} set to ${hoursNum} hrs.`,
        timer: 1600,
        showConfirmButton: false,
      });
    } catch (err) {
      console.error("Error updating NSD:", err);
      Swal.fire(
        "Error",
        err.message || "Failed to update Night Shift Differential",
        "error",
      );
    } finally {
      setActionLoading(false);
    }
  };


  // Admin attendance modal handlers
  const submitAdminAttendance = async () => {
    if (!adminModal.visible || !adminModal.person) return;
    const person = adminModal.person;
    const dtInput = document.getElementById("admin-attendance-datetime");
    const dtStr = (dtInput && dtInput.value) || adminModal.datetime;
    if (!dtStr) {
      Swal.fire("Validation", "Please provide date & time.", "warning");
      return;
    }
    setActionLoading(true);
    try {
      const { data: settingsData } = await supabase
        .from("settings")
        .select("*")
        .eq("id", 1)
        .maybeSingle();

      const pad = (n) => String(n).padStart(2, "0");
      const selectedDate = new Date(dtStr);
      const formattedTime = `${selectedDate.getFullYear()}-${pad(selectedDate.getMonth() + 1)}-${pad(selectedDate.getDate())} ${pad(selectedDate.getHours())}:${pad(selectedDate.getMinutes())}:${pad(selectedDate.getSeconds() || 0)}`;
      const hhmm = `${pad(selectedDate.getHours())}:${pad(selectedDate.getMinutes())}`;

      let adminEvent = adminModal.event || "time-in";

      let status = "on-time";
      try {
        status = determineAttendanceStatus(hhmm, adminEvent, settingsData || {}, false);
      } catch (e) {}

      const payload = {
        person_id: person.id,
        name: person.name,
        department: person.department,
        event: adminEvent,
        method: "admin-entry",
        device_time: formattedTime,
        status,
        photo: adminModal.photo || null,
      };

      const { error: insertErr } = await supabase.from("attendance").insert([payload]);
      if (insertErr) throw insertErr;

      // refresh presenceMap for the day
      try {
        const ymd = `${selectedDate.getFullYear()}-${pad(selectedDate.getMonth() + 1)}-${pad(selectedDate.getDate())}`;
        const { data: atts, error: attErr } = await supabase
          .from("attendance")
          .select("person_id, event, device_time")
          .eq("person_id", person.id)
          .gte("device_time", `${ymd} 00:00:00`)
          .lte("device_time", `${ymd} 23:59:59`);
        if (!attErr && Array.isArray(atts)) {
          const pmap = {};
          pmap[person.id] = { morning: false, afternoon: false, firstScan: null };
          atts.forEach((r) => {
            try {
              const dt2 = new Date(r.device_time);
              const hour = dt2.getHours();
              const evt = (r.event || "").toLowerCase();
              if (evt === "time-in" || evt === "time-out") {
                if (hour < 12) pmap[person.id].morning = true;
                else pmap[person.id].afternoon = true;
              }
              pmap[person.id].hasAttendance = true;
              if (!pmap[person.id].firstScan) pmap[person.id].firstScan = dt2.toISOString();
              else if (new Date(pmap[person.id].firstScan).getTime() > dt2.getTime())
                pmap[person.id].firstScan = dt2.toISOString();
            } catch (e) {}
          });
          pmap[person.id].present = !!(pmap[person.id].morning || pmap[person.id].afternoon || pmap[person.id].hasAttendance || atts.length > 0);
          setPresenceMap((prev) => ({ ...prev, ...pmap }));
        }
      } catch (e) {}

      Swal.fire({
        toast: true,
        position: "top-end",
        icon: "success",
        title: "Attendance recorded successfully!",
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
        iconColor: "#237227",
        customClass: {
          popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
          title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
          timerProgressBar: "!bg-[#237227]",
        },
      });
      setAdminModal({ visible: false, person: null, event: "time-in", datetime: "", photo: null, note: "" });
      setMissingRecords([]);
    } catch (err) {
      console.error(err);
      Swal.fire({
        icon: "error",
        title: "Error",
        text: err.message || String(err),
        width: "380px",
        padding: "1.75rem",
        confirmButtonText: "OK",
        buttonsStyling: false,
        customClass: {
          popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !border !border-gray-100 font-sans",
          title: "!text-xl !font-bold !text-gray-800 !mt-2",
          htmlContainer: "!text-sm !text-gray-600",
          icon: "!scale-90 !my-2",
          actions: "!flex !items-center !justify-center !mt-5 !w-full",
          confirmButton: "!bg-[#237227] hover:!bg-[#1e5f21] !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !m-0 !shadow-none !transform-none",
        },
      });
    } finally {
      setActionLoading(false);
    }
  };

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

  const getPersonPhoto = (person) => {
    if (person && person.registration_photo) return person.registration_photo;
    return null;
  };

  const handleEditModalClose = () => {
    setShowEditModal(false);
    setEditPerson(null);
  };

  const handleEditModalSave = async (e) => {
    e.preventDefault();
    if (!editPerson || !editPerson.id) return;
    const {
      id,
      name,
      department,
      phone_number,
      address,
      email,
      sex,
      cash_advance,
      registration_photo,
    } = editPerson;
    // Ensure checkboxes are stored as 1/0
    const sssVal = editPerson.sss ? String(editPerson.sss).trim() : null;
    const pagIbigVal = editPerson.pag_ibig ? String(editPerson.pag_ibig).trim() : null;
    const philhealthVal = editPerson.philhealth ? String(editPerson.philhealth).trim() : null;
    // Determine daily_rate and late_penalty based on assigned department
    let newDailyRate = null;
    let newLatePenalty = null;
    const cleanDept = (department || "").trim();
    if (cleanDept) {
      const matchedDept = deptRatesList.find(
        (d) => (d.department || "").trim().toLowerCase() === cleanDept.toLowerCase()
      );
      if (matchedDept) {
        newDailyRate = matchedDept.daily_rate !== undefined && matchedDept.daily_rate !== null ? matchedDept.daily_rate : null;
        newLatePenalty = matchedDept.late_penalty !== undefined && matchedDept.late_penalty !== null ? matchedDept.late_penalty : null;
      }
    }

    const { error } = await supabase
      .from("persons")
      .update({
        name: name || "",
        department: cleanDept || null,
        daily_rate: newDailyRate,
        late_penalty: newLatePenalty,
        phone_number: phone_number || null,
        address: address || null,
        email: email || null,
        sex: sex || null,
        sss: sssVal,
        pag_ibig: pagIbigVal,
        philhealth: philhealthVal,
        cash_advance: cash_advance !== undefined && cash_advance !== null ? cash_advance : 0,
        registration_photo: registration_photo || null,
      })
      .eq("id", id);
    if (error) {
      Swal.fire({
        icon: "error",
        title: "Error",
        text: error.message,
        width: "380px",
        padding: "1.75rem",
        confirmButtonText: "OK",
        buttonsStyling: false,
        customClass: {
          popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !border !border-gray-100 font-sans",
          title: "!text-xl !font-bold !text-gray-800 !mt-2",
          htmlContainer: "!text-sm !text-gray-600",
          icon: "!scale-90 !my-2",
          actions: "!flex !items-center !justify-center !mt-5 !w-full",
          confirmButton: "!bg-[#237227] hover:!bg-[#1e5f21] !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm !border-none cursor-pointer !m-0 !shadow-none !transform-none",
        },
      });
    } else {
      setPersons((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                name,
                department: cleanDept || null,
                daily_rate: newDailyRate,
                late_penalty: newLatePenalty,
                phone_number,
                address,
                email,
                sex,
                sss: sssVal,
                pag_ibig: pagIbigVal,
                philhealth: philhealthVal,
                cash_advance,
                registration_photo: registration_photo || null,
              }
            : p,
        ),
      );
      Swal.fire({
        toast: true,
        position: "top-end",
        icon: "success",
        title: "Person details updated successfully!",
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
        iconColor: "#237227",
        customClass: {
          popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
          title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
          timerProgressBar: "!bg-[#237227]",
        },
      });
      handleEditModalClose();
    }
  };

  // Filter and sort
  const filteredPersons = persons.filter((p) => {
    if (showArchived ? !p.archived : p.archived) return false;
    const matchesSearch =
      !search ||
      (p.name && p.name.toLowerCase().includes(search.toLowerCase())) ||
      (p.id && p.id.toLowerCase().includes(search.toLowerCase()));
    const matchesDept =
      !departmentFilter || (p.department || "") === departmentFilter;
    return matchesSearch && matchesDept;
  });

  const sortedPersons = [...filteredPersons].sort((a, b) => {
    // Always prioritize present persons first
    try {
      const aPresent = !!(
        presenceMap &&
        presenceMap[a.id] &&
        presenceMap[a.id].present
      );
      const bPresent = !!(
        presenceMap &&
        presenceMap[b.id] &&
        presenceMap[b.id].present
      );
      if (aPresent !== bPresent) return aPresent ? -1 : 1;

      // If both present, sort by earliest attendance time (firstScan) ascending
      if (aPresent && bPresent) {
        const aTime =
          presenceMap[a.id] && presenceMap[a.id].firstScan
            ? new Date(presenceMap[a.id].firstScan).getTime()
            : Infinity;
        const bTime =
          presenceMap[b.id] && presenceMap[b.id].firstScan
            ? new Date(presenceMap[b.id].firstScan).getTime()
            : Infinity;
        if (aTime !== bTime) return aTime - bTime; // earlier (smaller) first
      }
    } catch (e) {}

    // Within the same group (both absent or both present with same time), apply sortKey/sortOrder
    try {
      let aVal, bVal;
      if (sortKey === "created_at") {
        aVal = new Date(a.created_at).getTime() || 0;
        bVal = new Date(b.created_at).getTime() || 0;
      } else if (sortKey === "name") {
        aVal = (a.name || "").toLowerCase();
        bVal = (b.name || "").toLowerCase();
      } else if (sortKey === "department") {
        aVal = (a.department || "").toLowerCase();
        bVal = (b.department || "").toLowerCase();
      } else {
        aVal = (a[sortKey] || "").toString().toLowerCase();
        bVal = (b[sortKey] || "").toString().toLowerCase();
      }

      if (typeof aVal === "number" && typeof bVal === "number") {
        return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
      }
      if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
      if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
    } catch (e) {}
    return 0;
  });

  const currentRecords = sortedPersons;

  // Export to Excel
  const handleSyncDahuaPersons = async () => {
    if (syncingDahuaUsers) return;
    setSyncingDahuaUsers(true);

    Swal.fire({
      title: "Syncing Users from Dahua...",
      html: `
        <div class="flex flex-col items-center justify-center py-2 text-center">
          <p class="text-sm text-gray-600 mb-1">
            Fetching enrolled users from <span class="font-semibold text-gray-800">DHI-ASA3213GL-MW</span>
          </p>
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
      const data = await syncDahuaUsers();

      try {
        const { data: refreshedPersons, error: refreshError } = await supabase
          .from("persons")
          .select("*");
        if (!refreshError) setPersons(refreshedPersons || []);
      } catch (refreshErr) {}

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
              Synced from Dahua terminal successfully.
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
      setSyncingDahuaUsers(false);
    }
  };

  const handleExportExcel = () => {
    if (!Array.isArray(sortedPersons) || sortedPersons.length === 0) return;
    const exportData = sortedPersons.map((row) => ({
      "Person ID": row.id,
      "Full Name": row.name || "",
      Department: row.department || "",
      "Phone Number": row.phone_number || "",
      Address: row.address || "",
      Email: row.email || "",
      Gender: row.sex || "",
      "Registered At": row.created_at
        ? new Date(row.created_at).toLocaleString()
        : "",
      "SSS No.": row.sss || "",
      "Pag-IBIG No.": row.pag_ibig || "",
      "PhilHealth No.": row.philhealth || "",
      "Cash Advance (₱)": row.cash_advance || 0,
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
    XLSX.utils.book_append_sheet(wb, ws, "Registered Persons");
    XLSX.writeFile(wb, "persons.xlsx");
  };

  return (
    <div className="max-w-full min-h-screen px-0 pt-0 pb-6 mx-auto font-sans text-gray-800 bg-white">
      {error && (
        <div
          role="alert"
          className="mb-4 p-3 px-3.5 border border-red-200 rounded-lg bg-red-50 text-red-700 text-sm"
        >
          {error}
        </div>
      )}
      {/* Header */}
      <div className="mb-6 flex flex-col items-start gap-1.5">
        <h1 className="text-[2rem] md:text-4xl font-extrabold m-0 tracking-tight inline-block">
          <span className="text-[#2c382d]">Registered </span>
          <span className="text-[#237227]">Persons</span>
        </h1>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap justify-between items-end gap-3.5 mb-5 p-3 px-4 bg-white rounded-xl border border-[#edf2ee] shadow-sm">
        <div className="flex flex-wrap gap-3.5 items-end">
          <div>
            <label
              htmlFor="persons-search"
              className="block mb-1 text-xs font-semibold text-gray-600"
            >
              Search
            </label>
            <div className="relative">
              <FiSearch className="absolute text-sm text-gray-400 -translate-y-1/2 left-3 top-1/2" />
              <input
                id="persons-search"
                name="persons-search"
                type="text"
                placeholder="Search name or ID"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-3.5 py-2 text-sm rounded-md border border-[#dce3dd] bg-white text-[#2c382d] outline-none focus:outline-none focus:border-[#dce3dd] focus:ring-0 min-w-[200px]"
              />
            </div>
          </div>
          <div>
            <label
              htmlFor="persons-department-filter"
              className="block mb-1 text-xs font-semibold text-gray-600"
            >
              Department
            </label>
            <select
              id="persons-department-filter"
              name="persons-department-filter"
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="py-2 px-3 text-sm rounded-md border border-[#dce3dd] bg-white text-[#2c382d] outline-none cursor-pointer focus:outline-none focus:border-[#dce3dd] focus:ring-0 min-w-[150px]"
            >
              <option value="">All Departments</option>
              {[
                ...new Set(persons.map((p) => p.department).filter(Boolean)),
              ].map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => setShowArchived((a) => !a)}
            className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-sm font-semibold border border-[#237227] cursor-pointer transition-colors bg-white text-[#237227] shadow-sm whitespace-nowrap focus:outline-none"
          >
            <FiArchive className="mr-1" />
            {showArchived ? "Show Active" : "Show Archived"}
          </button>
        </div>

        <div className="flex gap-2.5 items-center flex-wrap">
          <button
            onClick={handleSyncDahuaPersons}
            disabled={syncingDahuaUsers}
            className={`inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-sm font-semibold border-none cursor-pointer transition-colors bg-[#237227] hover:bg-[#1c5c20] text-white shadow-sm whitespace-nowrap focus:outline-none ${
              syncingDahuaUsers ? "opacity-70 cursor-not-allowed" : ""
            }`}
          >
            <FiRefreshCw className={`mr-1 text-white ${syncingDahuaUsers ? "animate-spin" : ""}`} />
            {syncingDahuaUsers ? "Syncing Dahua Users..." : "Sync Dahua Users"}
          </button>
          <button
            onClick={handleExportExcel}
            className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-sm font-semibold border-none cursor-pointer transition-colors bg-[#237227] text-white shadow-sm whitespace-nowrap focus:outline-none"
          >
            <FiDownload className="mr-1 text-white" /> Export Excel
          </button>
        </div>
      </div>

      {/* Card Grid */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-5 items-stretch mb-6">
        {currentRecords.length === 0 ? (
          <div className="px-5 py-16 text-base text-center text-gray-500 bg-white border border-gray-100 shadow-sm col-span-full rounded-2xl">
            No persons found.
          </div>
        ) : (
          currentRecords.map((p) => {
            const initials = (p.name || "")
              .split(" ")
              .map((n) => (n ? n[0] : ""))
              .slice(0, 2)
              .join("")
              .toUpperCase();
            const hasDepartment = Boolean(p.department && p.department.trim());
            // If person is not assigned a department, daily rate is 0.00
            // If assigned, derive from person daily_rate or department rate
            let displayDailyRate = 0;
            if (hasDepartment) {
              const matchedDept = deptRatesList.find(
                (d) => (d.department || "").trim().toLowerCase() === p.department.trim().toLowerCase()
              );
              if (p.daily_rate !== null && p.daily_rate !== undefined && p.daily_rate !== "" && Number(p.daily_rate) > 0) {
                displayDailyRate = Number(p.daily_rate);
              } else if (matchedDept && matchedDept.daily_rate !== null && matchedDept.daily_rate !== undefined && Number(matchedDept.daily_rate) > 0) {
                displayDailyRate = Number(matchedDept.daily_rate);
              } else {
                displayDailyRate = 0;
              }
            } else {
              displayDailyRate = 0;
            }
            return (
              <div
                key={p.id}
                className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col justify-between shadow-[0_8px_20px_rgba(16,185,129,0.05)]"
              >
                {/* Card Header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center justify-center w-[84px] h-[84px] mr-3 shrink-0">
                    {getPersonPhoto(p) ? (
                      <img
                        src={getPersonPhoto(p)}
                        alt={p.name || "person"}
                        className="w-[84px] h-[84px] rounded-full object-cover border-4 border-white shadow-md cursor-pointer"
                        onClick={() =>
                          openPhotoModal(
                            getPersonPhoto(p),
                            p.name || p.id,
                          )
                        }
                      />
                    ) : (
                      <div className="w-[84px] h-[84px] rounded-full bg-gradient-to-br from-[#0284c7] to-[#0ea5e9] text-white flex items-center justify-center font-bold text-2xl border-4 border-white shadow-md">
                        {initials}
                      </div>
                    )}
                  </div>
                  <div>
                    {p.archived ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-500 text-white shadow-sm">
                        Archived
                      </span>
                    ) : presenceMap[p.id] && presenceMap[p.id].present ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#237227] text-white shadow-sm">
                        Present
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-500 text-white shadow-sm">
                        Absent
                      </span>
                    )}
                  </div>
                </div>

                {/* Person Info */}
                <div className="mb-4">
                  <div className="mb-1 text-base font-bold text-gray-800 truncate">
                    {p.name || "Unnamed"}
                  </div>
                  <div className="inline-flex items-center justify-center w-5 h-5 mb-2 text-xs font-bold text-gray-600 bg-gray-100 rounded-full">
                    {p.id}
                  </div>
                  {p.department && (
                    <div className="flex items-center mb-1 text-xs text-gray-600 truncate">
                      <FiBriefcase className="mr-1.5 text-cyan-600 text-sm shrink-0" />
                      <span className="truncate">{p.department}</span>
                    </div>
                  )}
                  {p.email && (
                    <div className="flex items-center mb-1 text-xs text-gray-600 truncate">
                      <FiMail className="mr-1.5 text-cyan-600 text-sm shrink-0" />
                      <span className="truncate">{p.email}</span>
                    </div>
                  )}
                  {p.phone_number && (
                    <div className="flex items-center mb-2 text-xs text-gray-600 truncate">
                      <FiPhone className="mr-1.5 text-cyan-600 text-sm shrink-0" />
                      <span className="truncate">{p.phone_number}</span>
                    </div>
                  )}
                  <div className="text-xs font-semibold text-[#237227] mt-1">
                    Daily Rate (₱): ₱
                    {displayDailyRate.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 pt-2 border-t border-gray-100">
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleEdit(p)}
                      className="flex-1 py-1.5 px-3 rounded-md bg-[#237227] text-white text-xs font-semibold transition-colors cursor-pointer border-none focus:outline-none"
                    >
                      Edit
                    </button>
                    {p.archived ? (
                      <button
                        onClick={() => handleRestore(p)}
                        className="flex-1 py-1.5 px-3 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors cursor-pointer border-none focus:outline-none"
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        onClick={() => handleArchive(p)}
                        className="flex-1 py-1.5 px-3 rounded-md bg-white border border-gray-300 text-gray-700 text-xs font-semibold transition-colors cursor-pointer focus:outline-none"
                      >
                        Archive
                      </button>
                    )}
                  </div>
                  {!p.archived && (
                    <div className="flex flex-col gap-1.5 w-full">
                      <div className="flex gap-2 w-full">
                        <button
                          onClick={() => handleAdminAttendance(p)}
                          className="flex-1 py-1.5 px-2.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium transition-colors cursor-pointer border-none focus:outline-none whitespace-nowrap"
                          title="Record or customize attendance on behalf of this person"
                        >
                          Customize Attendance
                        </button>
                      </div>
                    </div>
                  )}
                  <button
                    onClick={() => handleDeletePerson(p)}
                    className="w-full py-1.5 px-3 rounded-md bg-[#D9361E] text-white text-xs font-semibold cursor-pointer border-none focus:outline-none"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Edit Modal */}
      {showEditModal && editPerson && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white text-gray-800 p-7 rounded-3xl max-w-[900px] w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-gray-200 font-sans">
            <h2 className="text-2xl font-bold mb-4 text-[#0f3d16] text-center flex items-center justify-center gap-2">
              <FiEdit className="text-[#237227]" /> Edit Person
            </h2>
            <form onSubmit={handleEditModalSave}>
              <div className="mb-4">
                <label className="block mb-2 text-xs font-semibold text-gray-700">
                  Enrolled Dahua Face Photo
                </label>
                <div className="flex items-center gap-3.5 flex-wrap">
                  {editPerson.registration_photo ? (
                    <div className="flex items-center gap-3">
                      <img
                        src={editPerson.registration_photo}
                        alt="person"
                        className="w-[84px] h-[84px] object-cover rounded-xl border-2 border-[#237227]/30 shadow-md cursor-pointer hover:opacity-90 transition-opacity"
                        onClick={() =>
                          openPhotoModal(
                            editPerson.registration_photo,
                            editPerson.name || editPerson.id,
                          )
                        }
                        title="Click to view full photo"
                      />
                      <div className="text-xs text-gray-500">
                        <span className="font-semibold text-gray-700 block mb-0.5">Device Synchronized</span>
                        <span>Synced directly from Dahua terminal. Click image to enlarge.</span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="w-[84px] h-[84px] rounded-xl bg-gray-100 border border-dashed border-gray-300 flex flex-col items-center justify-center text-gray-400 p-2 text-center text-xs">
                        No Photo
                      </div>
                      <div className="text-xs text-gray-500">
                        <span className="font-medium text-gray-700 block mb-0.5">Not Enrolled on Device</span>
                        <span>Enrolling a face on the Dahua terminal will automatically sync it here.</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="grid items-start grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="edit-person-name"
                    className="block text-xs font-semibold text-gray-700 mb-1.5"
                  >
                    Name
                  </label>
                  <input
                    id="edit-person-name"
                    name="edit-person-name"
                    value={editPerson.name || ""}
                    onChange={(e) =>
                      setEditPerson({ ...editPerson, name: e.target.value })
                    }
                    disabled
                    className="box-border w-full px-4 py-3 text-base text-gray-500 bg-gray-100 border border-gray-300 outline-none cursor-not-allowed rounded-2xl"                  />
                </div>
                <div>
                  <label
                    htmlFor="edit-person-department"
                    className="block text-xs font-semibold text-gray-700 mb-1.5"
                  >
                    Department
                  </label>
                  <select
                    id="edit-person-department"
                    name="edit-person-department"
                    value={editPerson.department || ""}
                    onChange={(e) =>
                      setEditPerson({
                        ...editPerson,
                        department: e.target.value,
                      })
                    }
                    className="w-full p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors cursor-pointer"
                  >
                    <option value="">(Select department)</option>
                    {departments && departments.length
                      ? departments.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))
                      : Array.from(
                          new Set(
                            persons.map((p) => p.department).filter(Boolean),
                          ),
                        ).map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                  </select>
                  {(() => {
                    const selDept = (editPerson.department || "").trim();
                    if (!selDept) {
                      return (
                        <span className="block text-[11px] text-amber-600 mt-1.5 font-medium">
                          No department assigned — Daily Rate is ₱0.00.
                        </span>
                      );
                    }
                    const matched = deptRatesList.find(
                      (d) => (d.department || "").trim().toLowerCase() === selDept.toLowerCase()
                    );
                    if (matched && matched.daily_rate) {
                      return (
                        <span className="block text-[11px] text-[#237227] mt-1.5 font-medium">
                          Department Daily Rate: ₱{Number(matched.daily_rate).toFixed(2)} / day
                        </span>
                      );
                    }
                    return null;
                  })()}
                </div>

                <div>
                  <label
                    htmlFor="edit-person-phone"
                    className="block text-xs font-semibold text-gray-700 mb-1.5"
                  >
                    Phone
                  </label>
                  <input
                    id="edit-person-phone"
                    name="edit-person-phone"
                    value={editPerson.phone_number || ""}
                    onChange={(e) =>
                      setEditPerson({
                        ...editPerson,
                        phone_number: e.target.value,
                      })
                    }
                    className="w-full p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors"
                  />
                </div>
                <div>
                  <label
                    htmlFor="edit-person-email"
                    className="block text-xs font-semibold text-gray-700 mb-1.5"
                  >
                    Email
                  </label>
                  <input
                    id="edit-person-email"
                    name="edit-person-email"
                    value={editPerson.email || ""}
                    onChange={(e) =>
                      setEditPerson({ ...editPerson, email: e.target.value })
                    }
                    className="w-full p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors"
                  />
                </div>

                <div>
                  <label
                    htmlFor="edit-person-address"
                    className="block text-xs font-semibold text-gray-700 mb-1.5"
                  >
                    Address
                  </label>
                  <input
                    id="edit-person-address"
                    name="edit-person-address"
                    value={editPerson.address || ""}
                    onChange={(e) =>
                      setEditPerson({ ...editPerson, address: e.target.value })
                    }
                    className="w-full p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors"
                  />
                </div>
                <div>
                  <label
                    htmlFor="edit-person-sex"
                    className="block text-xs font-semibold text-gray-700 mb-1.5"
                  >
                    Sex
                  </label>
                  <select
                    id="edit-person-sex"
                    name="edit-person-sex"
                    value={editPerson.sex || ""}
                    onChange={(e) =>
                      setEditPerson({ ...editPerson, sex: e.target.value })
                    }
                    className="w-full p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors cursor-pointer"
                  >
                    <option value="">Select sex</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                {/* Mandatory Contributions */}
                <div className="col-span-1 sm:col-span-2">
                  <label className="block mb-2 text-xs font-semibold text-gray-700">
                    Mandatory Contributions
                  </label>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-[200px] flex-1">
                      <label
                        htmlFor="edit-person-sss"
                        className="block text-xs text-gray-700 mb-1.5"
                      >
                        SSS Number
                      </label>
                      <input
                        id="edit-person-sss"
                        name="edit-person-sss"
                        type="text"
                        placeholder="e.g. 12-3456789-0"
                        value={editPerson.sss ?? ""}
                        onChange={(e) =>
                          setEditPerson({ ...editPerson, sss: e.target.value })
                        }
                        className="w-full p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors"
                      />
                    </div>

                    <div className="min-w-[200px] flex-1">
                      <label
                        htmlFor="edit-person-pag-ibig"
                        className="block text-xs text-gray-700 mb-1.5"
                      >
                        Pag-ibig Number
                      </label>
                      <input
                        id="edit-person-pag-ibig"
                        name="edit-person-pag-ibig"
                        type="text"
                        placeholder="e.g. 0000-0000-0000"
                        value={editPerson.pag_ibig ?? ""}
                        onChange={(e) =>
                          setEditPerson({
                            ...editPerson,
                            pag_ibig: e.target.value,
                          })
                        }
                        className="w-full p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors"
                      />
                    </div>

                    <div className="min-w-[200px] flex-1">
                      <label
                        htmlFor="edit-person-philhealth"
                        className="block text-xs text-gray-700 mb-1.5"
                      >
                        PhilHealth Number
                      </label>
                      <input
                        id="edit-person-philhealth"
                        name="edit-person-philhealth"
                        type="text"
                        placeholder="e.g. 123456789012"
                        value={editPerson.philhealth ?? ""}
                        onChange={(e) =>
                          setEditPerson({
                            ...editPerson,
                            philhealth: e.target.value,
                          })
                        }
                        className="w-full p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors"
                      />
                    </div>
                  </div>
                </div>

                {/* Add Cash Advance */}
                <div className="col-span-1 sm:col-span-2">
                  <label className="block mb-2 text-xs font-semibold text-gray-700">
                    Add Cash Advance
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="cash-advance-amount"
                      name="cash-advance-amount"
                      type="number"
                      placeholder="Amount"
                      value={newCashAmount}
                      onChange={(e) => setNewCashAmount(e.target.value)}
                      className="p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors max-w-[160px]"
                    />
                    <input
                      id="cash-advance-note"
                      name="cash-advance-note"
                      placeholder="Note (optional)"
                      value={newCashNote}
                      onChange={(e) => setNewCashNote(e.target.value)}
                      className="p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors flex-1"
                    />
                    <button
                      type="button"
                      onClick={addCashAdvance}
                      disabled={actionLoading}
                      className="inline-flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl text-sm font-semibold border-none cursor-pointer transition-colors bg-[#237227] text-white shadow-sm focus:outline-none"
                    >
                      <FiPlusCircle className="mr-1 text-base text-white" />
                      {actionLoading ? "Working..." : "Add"}
                    </button>
                  </div>
                </div>

                {/* Cash Advance History */}
                <div className="col-span-1 sm:col-span-2 mt-1.5">
                  <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                    Cash Advance History
                  </label>
                  {loadingCashAdvances ? (
                    <div className="text-xs text-gray-500">Loading...</div>
                  ) : editCashAdvances && editCashAdvances.length ? (
                    <div className="p-2 overflow-auto border border-gray-200 max-h-36 rounded-xl bg-gray-50/50">
                      {editCashAdvances.map((c) => (
                        <div
                          key={c.id}
                          className="flex justify-between items-center py-2 px-2.5 border-b border-gray-100 last:border-none"
                        >
                          <div className="text-xs text-gray-700">
                            {new Date(c.created_at).toLocaleString()}
                          </div>
                          <div className="flex items-center gap-3 text-right">
                            <div>
                              <div className="text-xs font-bold text-gray-900">{`₱${Number(c.amount || 0).toFixed(2)}`}</div>
                              {c.note ? (
                                <div className="text-[11px] text-gray-400">
                                  {c.note}
                                </div>
                              ) : null}
                            </div>
                            <div>
                              <button
                                type="button"
                                onClick={() => deleteCashAdvance(c.id)}
                                className="px-3 py-1 text-xs font-semibold text-red-600 transition-colors bg-white border border-red-200 rounded-lg cursor-pointer"
                                disabled={actionLoading}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400">
                      No cash advance history
                    </div>
                  )}
                </div>
              </div>

              {/* Modal Actions */}
              <div className="flex gap-2.5 justify-end mt-6">
                <button
                  type="button"
                  onClick={handleEditModalClose}
                  className="py-2.5 px-6 rounded-xl text-sm font-semibold border border-gray-300 bg-white text-gray-700 transition-colors cursor-pointer focus:outline-none"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="py-2.5 px-7 rounded-xl text-sm font-semibold border-none bg-[#237227] text-white transition-colors cursor-pointer focus:outline-none shadow-sm"
                >
                  {actionLoading ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin Attendance Modal */}
      {adminModal.visible && adminModal.person && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white text-gray-800 p-7 rounded-3xl max-w-[680px] w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-gray-200 font-sans">
            <h2 className="text-2xl font-bold mb-4 text-[#0f3d16] text-center">
              Record Attendance
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Row 1: Person (Full Width) */}
              <div className="col-span-1 sm:col-span-2">
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Person
                </label>
                <div className="py-2.5 px-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm text-gray-800 font-medium flex items-center justify-between">
                  <span>
                    <strong className="text-[#0f3d16]">{adminModal.person.name}</strong> • ID: {adminModal.person.id}
                  </span>
                  {adminModal.person.department && (
                    <span className="text-xs bg-[#237227]/10 text-[#237227] font-semibold px-2.5 py-0.5 rounded-full">
                      {adminModal.person.department}
                    </span>
                  )}
                </div>
              </div>

              {/* Missing Attendance Section */}
              <div className="col-span-1 sm:col-span-2 bg-[#f8faf8] rounded-2xl p-4 border border-[#e2ece3]">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-[#237227]/10 text-[#237227]">
                      <FiAlertCircle className="text-base" />
                    </span>
                    <div>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-[#0f3d16] m-0">
                        Missing Attendance Records
                      </h4>
                      <p className="text-[11px] text-gray-500 m-0">
                        Select a missing date below to auto-fill the record form
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={missingPeriod}
                      onChange={(e) => {
                        const newPeriod = e.target.value;
                        setMissingPeriod(newPeriod);
                        fetchMissingRecordsForPerson(adminModal.person, newPeriod);
                      }}
                      className="text-xs font-medium py-1.5 px-2.5 rounded-lg border border-gray-300 bg-white text-gray-700 outline-none focus:border-[#237227] cursor-pointer"
                    >
                      <option value="current">Current Cutoff</option>
                      <option value="previous">Previous Cutoff</option>
                      <option value="last30">Last 30 Days</option>
                    </select>
                  </div>
                </div>

                {/* Filter Pills */}
                {missingRecords.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {[
                      { key: "all", label: `All (${missingRecords.length})` },
                      { key: "missing-in", label: `Missing In (${missingRecords.filter((r) => r.type === "missing-in").length})` },
                      { key: "missing-out", label: `Missing Out (${missingRecords.filter((r) => r.type === "missing-out").length})` },
                      { key: "missing-both", label: `No Records (${missingRecords.filter((r) => r.type === "missing-both").length})` },
                    ].map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => setMissingFilter(f.key)}
                        className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg border transition-colors cursor-pointer ${
                          missingFilter === f.key
                            ? "bg-[#237227] text-white border-[#237227]"
                            : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* Missing List Display */}
                <div className="max-h-[200px] overflow-y-auto pr-1 flex flex-col gap-2">
                  {loadingMissing ? (
                    <div className="py-6 text-center text-xs text-gray-500 font-medium">
                      Scanning attendance logs for missing punches...
                    </div>
                  ) : missingRecords.length === 0 ? (
                    <div className="py-4 px-3 bg-white rounded-xl border border-emerald-100 flex items-center gap-2 text-xs text-emerald-700 font-medium">
                      <FiCheckCircle className="text-base text-emerald-600 shrink-0" />
                      <span>All attendance records are complete for this period. No missing time-in or time-out detected.</span>
                    </div>
                  ) : (
                    (() => {
                      const filtered = missingRecords.filter((item) => {
                        if (missingFilter === "all") return true;
                        return item.type === missingFilter;
                      });
                      if (filtered.length === 0) {
                        return (
                          <div className="py-4 text-center text-xs text-gray-400">
                            No records matching this filter.
                          </div>
                        );
                      }
                      return filtered.map((item) => {
                        const dt = new Date(item.date + "T00:00:00");
                        const dateFormatted = !isNaN(dt.getTime())
                          ? dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
                          : item.date;

                        return (
                          <div
                            key={item.date}
                            className="bg-white rounded-xl p-3 border border-gray-200/80 shadow-[0_1px_3px_rgba(0,0,0,0.02)] flex flex-wrap sm:flex-nowrap items-center justify-between gap-2.5 hover:border-[#237227]/40 transition-colors"
                          >
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-xs text-gray-800 font-mono">
                                  {dateFormatted}
                                </span>
                                {item.isToday && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded">
                                    TODAY
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px]">
                                {item.type === "missing-in" && (
                                  <>
                                    <span className="font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-md border border-rose-200">
                                      Missing Time In
                                    </span>
                                    {item.recordedOut && (
                                      <span className="text-gray-500">
                                        (Time Out: <span className="font-medium text-gray-700">{item.recordedOut}</span>)
                                      </span>
                                    )}
                                  </>
                                )}
                                {item.type === "missing-out" && (
                                  <>
                                    <span className="font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
                                      Missing Time Out
                                    </span>
                                    {item.recordedIn && (
                                      <span className="text-gray-500">
                                        (Time In: <span className="font-medium text-gray-700">{item.recordedIn}</span>)
                                      </span>
                                    )}
                                  </>
                                )}
                                {item.type === "missing-both" && (
                                  <span className="font-semibold text-gray-600 bg-gray-100 px-2 py-0.5 rounded-md border border-gray-200">
                                    No Attendance Recorded (Whole Day)
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                              {item.type === "missing-in" && (
                                <button
                                  type="button"
                                  onClick={() => handleFillMissing(item, "time-in")}
                                  className="text-xs font-semibold py-1 px-3 rounded-lg bg-[#237227] hover:bg-[#1c5c20] text-white border-none cursor-pointer flex items-center gap-1 transition-colors shadow-none"
                                >
                                  <FiPlus className="text-xs" /> Fill Time In
                                </button>
                              )}
                              {item.type === "missing-out" && (
                                <button
                                  type="button"
                                  onClick={() => handleFillMissing(item, "time-out")}
                                  className="text-xs font-semibold py-1 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white border-none cursor-pointer flex items-center gap-1 transition-colors shadow-none"
                                >
                                  <FiPlus className="text-xs" /> Fill Time Out
                                </button>
                              )}
                              {item.type === "missing-both" && (
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleFillMissing(item, "time-in")}
                                    className="text-xs font-semibold py-1 px-2.5 rounded-lg bg-[#237227] hover:bg-[#1c5c20] text-white border-none cursor-pointer flex items-center gap-0.5 transition-colors shadow-none"
                                  >
                                    <FiPlus className="text-xs" /> Time In
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleFillMissing(item, "time-out")}
                                    className="text-xs font-semibold py-1 px-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white border-none cursor-pointer flex items-center gap-0.5 transition-colors shadow-none"
                                  >
                                    <FiPlus className="text-xs" /> Time Out
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      });
                    })()
                  )}
                </div>
              </div>

              {/* Row 2: Event and Date & Time */}
              <div>
                <label
                  htmlFor="admin-attendance-event"
                  className="block text-xs font-semibold text-gray-700 mb-1.5"
                >
                  Event
                </label>
                <select
                  id="admin-attendance-event"
                  name="admin-attendance-event"
                  value={adminModal.event}
                  onChange={(e) =>
                    setAdminModal((s) => ({ ...s, event: e.target.value }))
                  }
                  className="w-full py-2.5 px-3.5 rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 text-sm cursor-pointer"
                >
                  <option value="time-in">Time In</option>
                  <option value="time-out">Time Out</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="admin-attendance-datetime"
                  className="block text-xs font-semibold text-gray-700 mb-1.5"
                >
                  Date & time
                </label>
                <DateTimeInput
                  id="admin-attendance-datetime"
                  name="admin-attendance-datetime"
                  value={adminModal.datetime}
                  onChange={(val) =>
                    setAdminModal((s) => ({ ...s, datetime: val }))
                  }
                  className="w-full py-2.5 px-3.5 rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 text-sm"
                />
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex gap-2.5 justify-end mt-6">
              <button
                onClick={() =>
                  setAdminModal({
                    visible: false,
                    person: null,
                    event: "time-in",
                    datetime: "",
                    photo: null,
                    note: "",
                  })
                }
                className="py-2.5 px-6 rounded-xl text-sm font-semibold border border-gray-300 bg-white text-gray-700 transition-colors cursor-pointer focus:outline-none"
              >
                Cancel
              </button>
              <button
                onClick={submitAdminAttendance}
                disabled={actionLoading}
                className="py-2.5 px-7 rounded-xl text-sm font-semibold border-none bg-[#237227] text-white transition-colors cursor-pointer focus:outline-none shadow-sm"
              >
                {actionLoading ? "Recording..." : "Record"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Night Shift Differential Modal */}
      {nsdModal.visible && nsdModal.person && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white text-gray-800 p-6 sm:p-7 rounded-3xl max-w-[500px] w-full shadow-2xl border border-gray-200 font-sans">
            <div className="flex items-center justify-between pb-3.5 mb-4 border-b border-gray-100">
              <div className="flex items-center gap-2.5">
                <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-[#708238]/15 text-[#708238]">
                  <FiMoon size={20} />
                </span>
                <div>
                  <h3 className="text-base sm:text-lg font-bold text-gray-900 m-0">
                    Night Shift Differential
                  </h3>
                  <p className="text-xs text-gray-500 m-0">
                    Input night differential hours for this employee
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCloseNsdModal}
                className="text-gray-400 hover:text-gray-600 text-xl font-bold p-1 border-none bg-transparent cursor-pointer"
                title="Close"
              >
                &times;
              </button>
            </div>

            {/* Person Info Card */}
            <div className="bg-gray-50 rounded-2xl p-4 border border-gray-200/80 mb-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-[11px] text-gray-500 font-medium uppercase tracking-wider">Employee</div>
                  <div className="text-sm font-bold text-gray-900">
                    {nsdModal.person.name}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-gray-500 font-medium uppercase tracking-wider">ID / Dept</div>
                  <div className="text-xs font-semibold text-gray-800">
                    ID: {nsdModal.person.id} • {nsdModal.person.department || "N/A"}
                  </div>
                </div>
              </div>
              <div className="pt-2 border-t border-gray-200/60 flex items-center justify-between text-xs text-gray-600">
                <span>Daily Rate: <strong>₱{Number(nsdModal.person.daily_rate || 500).toFixed(2)}</strong></span>
                <span>Hourly Rate (8h): <strong>₱{(Number(nsdModal.person.daily_rate || 500) / 8).toFixed(2)}/hr</strong></span>
              </div>
            </div>

            {/* Hours Input Field Action */}
            <div className="mb-4">
              <label
                htmlFor="nsd-hours-input"
                className="block text-xs font-bold uppercase tracking-wider text-gray-700 mb-1.5"
              >
                Night Shift Differential Hours (hrs)
              </label>
              <div className="relative">
                <input
                  id="nsd-hours-input"
                  type="number"
                  step="0.1"
                  min="0"
                  max="200"
                  value={nsdModal.hours}
                  onChange={(e) =>
                    setNsdModal((prev) => ({ ...prev, hours: e.target.value }))
                  }
                  placeholder="e.g. 2.0"
                  className="w-full py-2.5 px-3.5 pr-14 rounded-xl border border-gray-300 bg-white text-gray-900 text-base font-semibold outline-none focus:border-[#708238] focus:ring-2 focus:ring-[#708238]/20 transition-all"
                  autoFocus
                />
                <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-gray-400 pointer-events-none">
                  hours
                </span>
              </div>
              <p className="text-[11px] text-gray-500 mt-1.5">
                Applies standard +10% Night Shift Differential premium (for hours worked between 10:00 PM and 6:00 AM).
              </p>
            </div>

            {/* Quick Presets */}
            <div className="flex items-center gap-1.5 flex-wrap mb-4">
              <span className="text-xs font-medium text-gray-500 mr-1">Quick fill:</span>
              {[
                { label: "0.0h (Off)", val: "0.0" },
                { label: "1.0h", val: "1.0" },
                { label: "2.0h (Excel)", val: "2.0" },
                { label: "3.0h", val: "3.0" },
                { label: "4.0h", val: "4.0" },
              ].map((preset) => (
                <button
                  key={preset.val}
                  type="button"
                  onClick={() =>
                    setNsdModal((prev) => ({ ...prev, hours: preset.val }))
                  }
                  className={`text-xs font-semibold py-1 px-2.5 rounded-lg border transition-colors cursor-pointer ${
                    String(nsdModal.hours) === preset.val
                      ? "bg-[#708238] text-white border-[#708238]"
                      : "bg-white text-gray-700 border-gray-200 hover:border-gray-300"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Live Calculation Preview */}
            {(() => {
              const hRate = Number(nsdModal.person.daily_rate || 500) / 8;
              const hrs = Math.max(0, parseFloat(nsdModal.hours) || 0);
              const baseNsd = Math.round(hRate * 0.10 * hrs * 100) / 100;
              const otNsd = Math.round(hRate * 1.25 * 0.10 * hrs * 100) / 100;
              return (
                <div className="p-3 bg-[#708238]/10 rounded-xl border border-[#708238]/20 mb-5">
                  <div className="flex items-center justify-between text-xs text-gray-700 mb-1">
                    <span>Base NSD (+10% regular):</span>
                    <strong className="text-gray-900">+₱{baseNsd.toFixed(2)}</strong>
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-700">
                    <span>Overtime NSD (+10% on 1.25× OT):</span>
                    <strong className="text-[#556b2f] font-bold">+₱{otNsd.toFixed(2)}</strong>
                  </div>
                </div>
              );
            })()}

            {/* Modal Actions */}
            <div className="flex gap-2.5 justify-end">
              <button
                type="button"
                onClick={handleCloseNsdModal}
                className="py-2 px-5 rounded-xl text-sm font-semibold border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors cursor-pointer focus:outline-none"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveNsdModal}
                disabled={actionLoading}
                className="py-2 px-6 rounded-xl text-sm font-semibold border-none bg-[#708238] hover:bg-[#5f6f30] text-white transition-colors cursor-pointer focus:outline-none shadow-sm"
              >
                {actionLoading ? "Saving..." : "Save NSD Hours"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Photo modal for Registered Persons */}
      {photoModal.visible && (
        <div
          onClick={() => closePhotoModal()}
          className="fixed inset-0 bg-black/60 z-[10000] flex items-center justify-center p-5 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-w-[90%] max-h-[90%] rounded-2xl overflow-hidden bg-white p-3.5 shadow-2xl border border-gray-200"
          >
            <div className="flex justify-end">
              <button
                onClick={() => closePhotoModal()}
                aria-label="Close photo"
                className="text-2xl text-gray-700 bg-transparent border-none cursor-pointer hover:text-gray-900"
              >
                ×
              </button>
            </div>
            <div className="text-center">
              <img
                src={photoModal.src}
                alt={photoModal.title}
                className="max-w-full max-h-[80vh] block mx-auto rounded-lg object-contain"
              />
              {photoModal.title && (
                <div className="mt-2 text-sm font-semibold text-gray-800">
                  {photoModal.title}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
