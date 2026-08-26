import { useEffect, useState, useRef } from "react";
import { supabase } from "../supabaseClient";
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
} from "react-icons/fi";
import { determineAttendanceStatus } from "./attendanceUtils";
import { syncDahuaUsers } from "../utils/dahuaApi";

export default function PersonsTable() {
  const adminLastLocationRef = useRef({ point: "Location unavailable", ts: 0 });

  const buildLocationResult = (point, status, message) => ({ point, status, message });

  const requestBrowserLocation = () => new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      resolve,
      (error) => resolve({ error }),
      {
        enableHighAccuracy: true,
        timeout: 25000,
        maximumAge: 0,
      },
    );
  });

  const getCurrentLocationPoint = async () => {
    const now = Date.now();
    if (adminLastLocationRef.current?.point && now - (adminLastLocationRef.current.ts || 0) < 60 * 1000) {
      return buildLocationResult(adminLastLocationRef.current.point, "ok", "Using cached location.");
    }

    if (typeof window !== "undefined" && window.isSecureContext === false) {
      return buildLocationResult(
        "Location unavailable",
        "insecure-context",
        "Location requires HTTPS or localhost. Open the app over a secure connection.",
      );
    }

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      return buildLocationResult(
        "Location unavailable",
        "unsupported",
        "This device or browser does not support location services.",
      );
    }

    try {
      if (navigator.permissions && navigator.permissions.query) {
        const permission = await navigator.permissions.query({ name: "geolocation" });
        if (permission.state === "denied") {
          return buildLocationResult(
            "Location unavailable",
            "permission-denied",
            "Browser location permission is denied. Allow location for this site in the browser settings and retry.",
          );
        }
      }
    } catch (e) {}

    let lastError = null;
    let locationResult = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await requestBrowserLocation();
      if (result && !result.error) {
        const position = result;
          const latNum = Number(position.coords.latitude || 0);
          const lngNum = Number(position.coords.longitude || 0);
          const lat = latNum.toFixed(6);
          const lng = lngNum.toFixed(6);
          const accuracy = Number(position.coords.accuracy || 0);

          try {
            const reverseUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1`;
            const res = await fetch(reverseUrl, {
              headers: {
                Accept: "application/json",
                "Accept-Language": "en",
              },
            });
            if (res.ok) {
              const data = await res.json();
              const addr = data?.address || {};
              const placeParts = [
                addr.road || addr.neighbourhood || addr.suburb || addr.village || addr.town || addr.city || addr.municipality,
                addr.city || addr.town || addr.village || addr.municipality,
                addr.state || addr.region || addr.province,
                addr.country,
              ].filter(Boolean);

              const uniqueParts = [...new Set(placeParts)];
              if (uniqueParts.length) {
                locationResult = buildLocationResult(uniqueParts.join(", "), "ok", accuracy && accuracy > 250 ? `Location detected, but GPS accuracy is about ${Math.round(accuracy)} meters.` : "Location detected.");
                break;
              }
              if (data?.display_name) {
                locationResult = buildLocationResult(String(data.display_name), "ok", accuracy && accuracy > 250 ? `Location detected, but GPS accuracy is about ${Math.round(accuracy)} meters.` : "Location detected.");
                break;
              }
            }
          } catch (e) {
            // Fallback handled below when reverse geocoding fails.
          }

          if (!locationResult) {
            locationResult = buildLocationResult(
              `Coordinates: ${lat}, ${lng}`,
              "ok",
              accuracy && accuracy > 250 ? `Location detected, but GPS accuracy is about ${Math.round(accuracy)} meters.` : "Location detected.",
            );
          }

          if (accuracy && accuracy > 300 && attempt < 2) {
            lastError = { code: "LOW_ACCURACY", message: `GPS accuracy is too coarse (${Math.round(accuracy)} meters). Retrying.` };
            locationResult = null;
            continue;
          }
          break;
      }

      lastError = result?.error || result || lastError;
      if (lastError?.code === 1) {
        locationResult = buildLocationResult(
          "Location unavailable",
          "permission-denied",
          "Browser location permission is denied. Allow location for this site in the browser settings and retry.",
        );
        break;
      }
      if (attempt < 2) {
        continue;
      }
    }

    if (!locationResult) {
      if (lastError?.code === 2) {
        locationResult = buildLocationResult(
          "Location unavailable",
          "position-unavailable",
          "The device could not determine a GPS or network location. Move to an open area and try again.",
        );
      } else if (lastError?.code === 3) {
        locationResult = buildLocationResult(
          "Location unavailable",
          "timeout",
          "Location request timed out. Try again with better signal or wait a few seconds.",
        );
      } else if (lastError?.code === "LOW_ACCURACY") {
        locationResult = buildLocationResult(
          "Location unavailable",
          "position-unavailable",
          lastError.message,
        );
      } else {
        locationResult = buildLocationResult(
          "Location unavailable",
          "unavailable",
          "Location could not be determined on this device.",
        );
      }
    }

    if (locationResult.status === "ok" && locationResult.point && locationResult.point !== "Location unavailable") {
      adminLastLocationRef.current = { point: locationResult.point, ts: now };
    }
    return locationResult;
  };

  const [search, setSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [sortKey] = useState("created_at");
  const [sortOrder] = useState("desc");
  const [showArchived, setShowArchived] = useState(false);

  const [persons, setPersons] = useState([]);
  const [photoModal, setPhotoModal] = useState({ visible: false, src: "", title: "" });
  const [payrollMap, setPayrollMap] = useState({});
  const [payrollGrossMap, setPayrollGrossMap] = useState({});
  const [presenceMap, setPresenceMap] = useState({});
  const [departments, setDepartments] = useState([]);
  const [syncingDahuaUsers, setSyncingDahuaUsers] = useState(false);
  const [error, setError] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editPerson, setEditPerson] = useState(null);
  const [editCashAdvances, setEditCashAdvances] = useState([]);
  const [loadingCashAdvances, setLoadingCashAdvances] = useState(false);
  const [newCashAmount, setNewCashAmount] = useState("");
  const [newCashNote, setNewCashNote] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [locLoading, setLocLoading] = useState(false);
  const editPhotoInputRef = useRef(null);
  const [adminModal, setAdminModal] = useState({ visible: false, person: null, event: "time-in", datetime: "", photo: null, note: "", point: null, locationStatus: null, locationMessage: "" });

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
        const { data, error: err } = await supabase.from("persons").select("*");
        if (err) throw err;
        const list = data || [];
        setPersons(list);

        // Fetch latest payroll/net for these persons
        try {
          const ids = list.map((p) => p.id).filter(Boolean);
          if (ids.length) {
            const [activeRes, historyRes] = await Promise.all([
              supabase
                .from("payroll_periods")
                .select("person_id, net, gross, period")
                .in("person_id", ids)
                .order("period", { ascending: false }),
              supabase
                .from("payroll_released_history")
                .select("person_id, net, gross, period")
                .in("person_id", ids)
                .order("period", { ascending: false }),
            ]);

            const payrolls = [
              ...(Array.isArray(activeRes.data) ? activeRes.data : []),
              ...(Array.isArray(historyRes.data) ? historyRes.data : []),
            ];
            const map = {};
            const gmap = {};
            for (const pr of payrolls) {
              if (!map[pr.person_id]) map[pr.person_id] = pr.net || 0;
              if (!gmap[pr.person_id]) gmap[pr.person_id] = pr.gross || 0;
            }
            setPayrollMap(map);
            setPayrollGrossMap(gmap);
            // Fetch today's attendance for presence
            try {
              const start = new Date();
              start.setHours(0, 0, 0, 0);
              const end = new Date();
              end.setHours(23, 59, 59, 999);
              const { data: atts, error: attErr } = await supabase
                .from("attendance")
                .select("person_id, event, device_time")
                .in("person_id", ids)
                .gte("device_time", start.toISOString())
                .lte("device_time", end.toISOString());
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
                    if ((r.event || "").toLowerCase() === "time-in") {
                      if (hour < 12) pmap[pid].morning = true;
                      else pmap[pid].afternoon = true;
                    }
                    // track earliest time-in for the person today
                    if (!pmap[pid].firstScan)
                      pmap[pid].firstScan = dt.toISOString();
                    else {
                      const existing = new Date(pmap[pid].firstScan);
                      if (dt.getTime() < existing.getTime())
                        pmap[pid].firstScan = dt.toISOString();
                    }
                  } catch (e) {}
                });
                // mark present if any session true
                Object.keys(pmap).forEach((k) => {
                  pmap[k].present = !!(pmap[k].morning || pmap[k].afternoon);
                });
                setPresenceMap(pmap);
                // fetch department rates list (for edit dropdown)
                try {
                  const { data: deptData, error: deptErr } = await supabase
                    .from("department_rates")
                    .select("department");
                  if (!deptErr && Array.isArray(deptData)) {
                    const uniq = Array.from(
                      new Set(
                        deptData.map((d) => d.department).filter(Boolean),
                      ),
                    );
                    setDepartments(uniq);
                  }
                } catch (e) {
                  // ignore department fetch errors
                }
              }
            } catch (e) {
              // ignore attendance fetch errors
            }
          }
        } catch (e) {
          // ignore payroll fetch errors
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

  // Admin: record attendance on behalf of a person (customize attendance)
  const handleAdminAttendance = async (person) => {
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
      point: null,
      locationStatus: "fetching",
      locationMessage: "Fetching current location...",
    });
    const locationResult = await getCurrentLocationPoint();
    setAdminModal((s) => ({
      ...s,
      point: locationResult.point,
      locationStatus: locationResult.status,
      locationMessage: locationResult.message,
    }));
  };

  // eslint-disable-next-line no-unused-vars
  const handleRefreshAdminLocation = async () => {
    setAdminModal((s) => ({
      ...s,
      locationStatus: "fetching",
      locationMessage: "Fetching current location...",
    }));
    const locationResult = await getCurrentLocationPoint();
    setAdminModal((s) => ({
      ...s,
      point: locationResult.point,
      locationStatus: locationResult.status,
      locationMessage: locationResult.message,
    }));
  };

  // Admin attendance modal handlers
  
  const submitAdminAttendance = async () => {
    if (!adminModal.visible || !adminModal.person) return;
    const person = adminModal.person;
    const dtStr = adminModal.datetime;
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

      const iso = new Date(dtStr).toISOString();
      const hhmm = new Date(dtStr).toTimeString().slice(0, 5);
      const locationResult = adminModal.point ? { point: adminModal.point, status: adminModal.locationStatus || "ok", message: adminModal.locationMessage || "" } : await getCurrentLocationPoint();
      if (locationResult.status !== "ok") {
        setAdminModal((s) => ({ ...s, point: locationResult.point, locationStatus: locationResult.status, locationMessage: locationResult.message }));
        Swal.fire(
          "Location unavailable",
          locationResult.message || "Please enable location and try again.",
          locationResult.status === "permission-denied" ? "error" : "warning",
        );
        return;
      }
      const locationPoint = locationResult.point;
      let status = "on-time";
      try {
        status = determineAttendanceStatus(hhmm, adminModal.event, settingsData || {}, false);
      } catch (e) {}

      const payload = {
        person_id: person.id,
        name: person.name,
        department: person.department,
        event: adminModal.event,
        method: "admin-entry",
        device_time: iso,
        status,
        point: locationPoint,
        photo: adminModal.photo || null,
      };

      const { error: insertErr } = await supabase.from("attendance").insert([payload]);
      if (insertErr) throw insertErr;

      // refresh presenceMap for the day
      try {
        const dt = new Date(iso);
        const start = new Date(dt);
        start.setHours(0, 0, 0, 0);
        const end = new Date(dt);
        end.setHours(23, 59, 59, 999);
        const { data: atts, error: attErr } = await supabase
          .from("attendance")
          .select("person_id, event, device_time")
          .eq("person_id", person.id)
          .gte("device_time", start.toISOString())
          .lte("device_time", end.toISOString());
        if (!attErr && Array.isArray(atts)) {
          const pmap = {};
          pmap[person.id] = { morning: false, afternoon: false, firstScan: null };
          atts.forEach((r) => {
            try {
              const dt2 = new Date(r.device_time);
              const hour = dt2.getHours();
              if ((r.event || "").toLowerCase() === "time-in") {
                if (hour < 12) pmap[person.id].morning = true;
                else pmap[person.id].afternoon = true;
              }
              if (!pmap[person.id].firstScan) pmap[person.id].firstScan = dt2.toISOString();
              else if (new Date(pmap[person.id].firstScan).getTime() > dt2.getTime())
                pmap[person.id].firstScan = dt2.toISOString();
            } catch (e) {}
          });
          pmap[person.id].present = !!(pmap[person.id].morning || pmap[person.id].afternoon);
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
      setAdminModal({ visible: false, person: null, event: "time-in", datetime: "", photo: null, note: "", point: null, locationStatus: null, locationMessage: "" });
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

  const handleEditPhotoChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setEditPerson((p) => ({ ...p, registration_photo: reader.result }));
    };
    reader.readAsDataURL(file);
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
    const { error } = await supabase
      .from("persons")
      .update({
        name,
        department,
        phone_number,
        address,
        email,
        sex,
        sss: sssVal,
        pag_ibig: pagIbigVal,
        philhealth: philhealthVal,
        cash_advance,
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
                department,
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
      html: "Fetching enrolled users from <b>DHI-ASA3213GL-MW</b> and saving them to Supabase...",
      allowOutsideClick: false,
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

      Swal.fire({
        icon: "success",
        title: "Users Synced!",
        html: `Synced <b>${data?.count || 0}</b> user(s) from Dahua to Supabase.`,
        timer: 2800,
      });
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Sync Error",
        text: err?.message || "Failed to sync users from Dahua device.",
      });
    } finally {
      setSyncingDahuaUsers(false);
    }
  };

  const handleExportExcel = () => {
    if (!Array.isArray(sortedPersons)) return;
    const exportData = sortedPersons.map((row) => ({
      ID: row.id,
      Name: row.name || "",
      Department: row.department || "",
      Phone: row.phone_number || "",
      Address: row.address || "",
      Email: row.email || "",
      Sex: row.sex || "",
      RegisteredAt: row.created_at
        ? new Date(row.created_at).toLocaleString()
        : "",
      SSS: row.sss || "",
      Pag_ibig: row.pag_ibig || "",
      PhilHealth: row.philhealth || "",
      Cash_Advance: row.cash_advance || "",
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Persons");
    XLSX.writeFile(wb, "persons.xlsx");
  };

  return (
    <div className="mx-auto p-7 md:p-9 max-w-full bg-white min-h-screen text-gray-800 font-sans">
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
              className="block mb-1 text-xs text-gray-600 font-semibold"
            >
              Search
            </label>
            <div className="relative">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm" />
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
              className="block mb-1 text-xs text-gray-600 font-semibold"
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
            className={`inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-sm font-semibold border-none cursor-pointer transition-colors bg-[#237227] text-white shadow-sm whitespace-nowrap focus:outline-none ${
              syncingDahuaUsers ? "opacity-70 cursor-not-allowed" : ""
            }`}
          >
            <FiRefreshCw className="mr-1 text-white" />
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
          <div className="col-span-full text-center py-16 px-5 text-gray-500 text-base bg-white rounded-2xl border border-gray-100 shadow-sm">
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
            // Compute display amount: prefer explicit daily_rate, then payroll gross, then net
            const displayAmount = Number(
              p.daily_rate ??
                payrollGrossMap[p.id] ??
                p.gross ??
                payrollMap[p.id] ??
                p.net ??
                0,
            );
            return (
              <div
                key={p.id}
                className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col justify-between shadow-[0_8px_20px_rgba(16,185,129,0.05)]"
              >
                {/* Card Header */}
                <div className="flex justify-between items-center mb-3">
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
                  <div className="font-bold text-base text-gray-800 mb-1 truncate">
                    {p.name || "Unnamed"}
                  </div>
                  <div className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 text-gray-600 text-xs font-bold mb-2">
                    {p.id}
                  </div>
                  {p.department && (
                    <div className="flex items-center text-xs text-gray-600 mb-1 truncate">
                      <FiBriefcase className="mr-1.5 text-cyan-600 text-sm shrink-0" />
                      <span className="truncate">{p.department}</span>
                    </div>
                  )}
                  {p.email && (
                    <div className="flex items-center text-xs text-gray-600 mb-1 truncate">
                      <FiMail className="mr-1.5 text-cyan-600 text-sm shrink-0" />
                      <span className="truncate">{p.email}</span>
                    </div>
                  )}
                  {p.phone_number && (
                    <div className="flex items-center text-xs text-gray-600 mb-2 truncate">
                      <FiPhone className="mr-1.5 text-cyan-600 text-sm shrink-0" />
                      <span className="truncate">{p.phone_number}</span>
                    </div>
                  )}
                  <div className="text-xs font-semibold text-[#237227] mt-1">
                    Daily Rate (₱): ₱
                    {displayAmount.toLocaleString(undefined, {
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
                    {!p.archived && (
                      <button
                        onClick={() => handleArchive(p)}
                        className="flex-1 py-1.5 px-3 rounded-md bg-white border border-gray-300 text-gray-700 text-xs font-semibold transition-colors cursor-pointer focus:outline-none"
                      >
                        Archive
                      </button>
                    )}
                  </div>
                  {!p.archived && (
                    <button
                      onClick={() => handleAdminAttendance(p)}
                      className="w-full py-1.5 px-3 rounded-md bg-slate-100 text-slate-700 text-xs font-medium transition-colors cursor-pointer border-none focus:outline-none"
                    >
                      Customize Attendance
                    </button>
                  )}
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
                <label className="block text-xs font-semibold text-gray-700 mb-2">
                  Registration Photo
                </label>
                <div className="flex items-center gap-3 flex-wrap">
                  {editPerson.registration_photo ? (
                    <img
                      src={editPerson.registration_photo}
                      alt="person"
                      className="w-[88px] h-[88px] object-cover rounded-xl border-2 border-emerald-500/20 shadow-md cursor-pointer"
                      onClick={() =>
                        openPhotoModal(
                          editPerson.registration_photo,
                          editPerson.name || editPerson.id,
                        )
                      }
                    />
                  ) : (
                    <span className="text-gray-400 text-sm">No photo</span>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      editPhotoInputRef.current &&
                      editPhotoInputRef.current.click()
                    }
                    className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-sm font-semibold border border-[#237227] bg-white text-[#237227] shadow-sm cursor-pointer"
                  >
                    Upload New Photo
                  </button>
                </div>
                <input
                  ref={editPhotoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleEditPhotoChange}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
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
                    className="w-full p-2.5 text-sm rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 transition-colors"
                  />
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
                  <label className="block text-xs font-semibold text-gray-700 mb-2">
                    Mandatory Contributions
                  </label>
                  <div className="flex gap-3 items-center flex-wrap">
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
                  <label className="block text-xs font-semibold text-gray-700 mb-2">
                    Add Cash Advance
                  </label>
                  <div className="flex gap-2 items-center flex-wrap">
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
                      <FiPlusCircle className="mr-1 text-white text-base" />
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
                    <div className="text-gray-500 text-xs">Loading...</div>
                  ) : editCashAdvances && editCashAdvances.length ? (
                    <div className="max-h-36 overflow-auto border border-gray-200 rounded-xl p-2 bg-gray-50/50">
                      {editCashAdvances.map((c) => (
                        <div
                          key={c.id}
                          className="flex justify-between items-center py-2 px-2.5 border-b border-gray-100 last:border-none"
                        >
                          <div className="text-gray-700 text-xs">
                            {new Date(c.created_at).toLocaleString()}
                          </div>
                          <div className="text-right flex gap-3 items-center">
                            <div>
                              <div className="font-bold text-gray-900 text-xs">{`₱${Number(c.amount || 0).toFixed(2)}`}</div>
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
                                className="py-1 px-3 rounded-lg text-xs font-semibold border border-red-200 bg-white text-red-600 transition-colors cursor-pointer"
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
                    <div className="text-gray-400 text-xs">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Row 1: Person (Full Width) */}
              <div className="col-span-1 sm:col-span-2">
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Person
                </label>
                <div className="py-2.5 px-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm text-gray-800 font-medium">
                  {adminModal.person.name} • ID: {adminModal.person.id}
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
                <input
                  id="admin-attendance-datetime"
                  name="admin-attendance-datetime"
                  type="datetime-local"
                  value={adminModal.datetime}
                  onChange={(e) =>
                    setAdminModal((s) => ({ ...s, datetime: e.target.value }))
                  }
                  className="w-full py-2.5 px-3.5 rounded-xl border border-gray-200 bg-white text-gray-900 outline-none focus:border-[#237227] focus:ring-0 text-sm"
                />
              </div>

              {/* Row 3: Location (Full Width) */}
              <div className="col-span-1 sm:col-span-2">
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Location
                </label>
                <div className="flex gap-2 items-center">
                  <div
                    className="flex-1 py-2.5 px-3.5 bg-gray-50 rounded-xl border border-gray-200 min-h-[42px] text-xs text-gray-800 overflow-hidden text-ellipsis whitespace-nowrap"
                    title={adminModal.point || ""}
                  >
                    {adminModal.point ? (
                      adminModal.point
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        setLocLoading(true);
                        const locationResult = await getCurrentLocationPoint();
                        setAdminModal((s) => ({
                          ...s,
                          point: locationResult.point,
                          locationStatus: locationResult.status,
                          locationMessage: locationResult.message,
                        }));
                      } catch (e) {
                        setAdminModal((s) => ({
                          ...s,
                          point: null,
                          locationStatus: "unavailable",
                          locationMessage:
                            "Location could not be determined on this device.",
                        }));
                      } finally {
                        setLocLoading(false);
                      }
                    }}
                    className="py-2.5 px-4 rounded-xl border border-gray-300 bg-white cursor-pointer font-semibold text-xs text-gray-700 whitespace-nowrap"
                    disabled={locLoading}
                  >
                    {locLoading ? "..." : "Refresh"}
                  </button>
                </div>
                {adminModal.locationMessage &&
                  adminModal.locationStatus &&
                  adminModal.locationStatus !== "ok" && (
                    <div className="mt-1.5 text-amber-700 text-xs leading-relaxed">
                      {adminModal.locationMessage}
                    </div>
                  )}
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
                    point: null,
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
                className="bg-transparent border-none text-gray-700 hover:text-gray-900 text-2xl cursor-pointer"
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
                <div className="mt-2 text-gray-800 font-semibold text-sm">
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
