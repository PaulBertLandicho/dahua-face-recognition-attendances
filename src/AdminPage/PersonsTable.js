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
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 12; // 12 fits nicely in a grid (e.g. 4x3 or 3x4)

  useEffect(() => {
    setCurrentPage(1);
  }, [search, departmentFilter, showArchived]);

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

  const Icons = {
    download: <FiDownload color="#ffffff" style={{ marginRight: 8 }} />,
    archive: <FiArchive />,
    edit: <FiEdit color="#ffffff" style={{ marginRight: 8 }} />,
    circle: <FiPlusCircle color="#ffffff" style={{ marginRight: 0 }} />,
  };

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
      Swal.fire("Added", "Cash advance recorded.", "success");
    } catch (e) {
      console.error(e);
      Swal.fire("Error", e.message || String(e), "error");
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
      showCancelButton: true,
      confirmButtonText: "Delete",
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
      Swal.fire("Deleted", "Cash advance removed.", "success");
    } catch (e) {
      console.error(e);
      Swal.fire("Error", e.message || String(e), "error");
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
      showCancelButton: true,
      confirmButtonText: "Archive",
      cancelButtonText: "Cancel",
      focusCancel: true,
      customClass: { popup: "swal2-modal" },
    }).then(async (result) => {
      if (result.isConfirmed) {
        const { error: archErr } = await supabase
          .from("persons")
          .update({ archived: true })
          .eq("id", person.id);
        if (archErr) {
          Swal.fire("Error", archErr.message, "error");
        } else {
          setPersons((prev) =>
            prev.map((p) =>
              p.id === person.id ? { ...p, archived: true } : p,
            ),
          );
          Swal.fire("Archived!", "", "success");
        }
      }
    });
  };

  // Admin: record attendance on behalf of a person (customize attendance)
  const handleAdminAttendance = async (person) => {
    if (!person || !person.id) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const localIsoForInput = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    setLocLoading(true);
    try {
      const locationResult = adminModal.point ? { point: adminModal.point, status: adminModal.locationStatus || "ok", message: adminModal.locationMessage || "" } : await getCurrentLocationPoint();
      setAdminModal({ visible: true, person, event: "time-in", datetime: localIsoForInput, photo: person.registration_photo || null, note: "", point: locationResult.point, locationStatus: locationResult.status, locationMessage: locationResult.message });
    } catch (e) {
      setAdminModal({ visible: true, person, event: "time-in", datetime: localIsoForInput, photo: person.registration_photo || null, note: "", point: null, locationStatus: "unavailable", locationMessage: "Location could not be determined on this device." });
    } finally {
      setLocLoading(false);
    }
  };

  // Helper to get photo for a person (latest attendance photo or registration photo)
  const getPersonPhoto = (person) => {
    // Always use registration photo if available
    if (person && person.registration_photo) return person.registration_photo;
    return null;
  };

  // Removed unused: closeModal

  const handleEditModalClose = () => {
    setShowEditModal(false);
    setEditPerson(null);
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

      Swal.fire("Recorded", "Attendance recorded.", "success");
      setAdminModal({ visible: false, person: null, event: "time-in", datetime: "", photo: null, note: "", point: null, locationStatus: null, locationMessage: "" });
    } catch (err) {
      console.error(err);
      Swal.fire("Error", err.message || String(err), "error");
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

  const handleEditPhotoChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") return;
      setEditPerson((prev) =>
        prev ? { ...prev, registration_photo: dataUrl } : prev,
      );
    };
    reader.readAsDataURL(file);
  };

  const handleEditModalSave = async (e) => {
    e.preventDefault();
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
      Swal.fire("Error", error.message, "error");
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
      Swal.fire("Updated!", "", "success");
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

  // Pagination logic
  const activeRecords = sortedPersons;
  const totalRecords = activeRecords.length;
  const totalPages = Math.ceil(totalRecords / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentRecords = activeRecords.slice(startIndex, startIndex + itemsPerPage);

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
    <div style={styles.container}>
      {error && (
        <div
          role="alert"
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            border: "1px solid #fecaca",
            borderRadius: 8,
            background: "#fef2f2",
            color: "#b91c1c",
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}
      <div style={styles.header}>
        <h1 style={styles.title}>
          <span style={styles.titleBlack}>Registered </span>
          <span style={styles.titlePrimary}>Persons</span>
        </h1>
      </div>

      {/* Filter Bar */}
      <div style={styles.filterBar}>
        <div style={styles.filterGroup}>
          <div style={styles.searchWrapper}>
            <label htmlFor="persons-search" style={{ display: "block", marginBottom: 4, fontSize: 12, color: "#4b5563", fontWeight: 600 }}>Search</label>
            <input
              id="persons-search"
              name="persons-search"
              type="text"
              placeholder="Search name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={styles.searchInput}
            />
          </div>
          <div>
            <label htmlFor="persons-department-filter" style={{ display: "block", marginBottom: 4, fontSize: 12, color: "#4b5563", fontWeight: 600 }}>Department</label>
            <select
              id="persons-department-filter"
              name="persons-department-filter"
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              style={styles.select}
            >
              <option value="">All Departments</option>
              {[...new Set(persons.map((p) => p.department).filter(Boolean))].map(
                (dept) => (
                  <option key={dept} value={dept}>
                    {dept}
                  </option>
                ),
              )}
            </select>
          </div>
          <button
            onClick={() => setShowArchived((a) => !a)}
            style={{ ...styles.button, ...styles.buttonSecondary }}
          >
            {showArchived ? (
              <>{Icons.archive} Show Active</>
            ) : (
              <>{Icons.archive} Show Archived</>
            )}
          </button>
        </div>

        <div style={styles.actionButtons}>
          <button
            onClick={handleSyncDahuaPersons}
            disabled={syncingDahuaUsers}
            style={{
              ...styles.button,
              ...styles.buttonPrimary,
              opacity: syncingDahuaUsers ? 0.7 : 1,
            }}
          >
            <FiRefreshCw color="#ffffff" style={{ marginRight: 8 }} />
            {syncingDahuaUsers ? "Syncing Dahua Users..." : "Sync Dahua Users"}
          </button>
          <button
            onClick={handleExportExcel}
            style={{ ...styles.button, ...styles.buttonPrimary }}
          >
            {Icons.download} Export Excel
          </button>
        </div>
      </div>

      {/* Card Grid */}
      <div style={styles.tableContainer}>
        <div style={{ padding: 24 }}>
          <div style={styles.cardsGrid}>
            {currentRecords.length === 0 ? (
              <div style={styles.emptyState}>No persons found.</div>
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
                  <div key={p.id} style={styles.card}>
                    <div style={styles.cardHeader}>
                      <div style={styles.cardAvatarWrapper}>
                        {getPersonPhoto(p) ? (
                          <img
                            src={getPersonPhoto(p)}
                            alt={p.name || "person"}
                            style={{ ...styles.cardAvatar, cursor: 'pointer' }}
                            onClick={() => openPhotoModal(getPersonPhoto(p), p.name || p.id)}
                          />
                        ) : (
                          <div style={styles.cardAvatarPlaceholder}>
                            {initials || "?"}
                          </div>
                        )}
                      </div>
                      <div style={styles.cardStatus}>
                        {p.archived ? (
                          <span style={styles.badgeArchived}>Archived</span>
                        ) : presenceMap[p.id] && presenceMap[p.id].present ? (
                          <span style={styles.badgePresent}>Present</span>
                        ) : (
                          <span style={styles.badgeAbsent}>Absent</span>
                        )}
                      </div>
                    </div>

                    <div style={styles.cardBody}>
                      <h3 style={styles.cardName}>{p.name || "Unnamed"}</h3>
                      <div style={styles.cardId}>{p.id}</div>

                      <div style={styles.cardInfoRow}>
                        <span style={styles.iconAndText}>
                          <FiBriefcase style={styles.deptIcon} />{" "}
                          {p.department || ""}
                        </span>
                      </div>
                      <div style={styles.phoneRow}>
                        <span style={styles.iconAndText}>
                          <FiMail style={styles.emailIcon} />
                          <span style={styles.contactText}>
                            {p.email || ""}
                          </span>
                        </span>
                      </div>
                      <div style={styles.phoneRow}>
                        <span style={styles.iconAndText}>
                          <FiPhone style={styles.phoneIcon} />
                          <span style={styles.contactText}>
                            {p.phone_number || ""}
                          </span>
                        </span>
                      </div>
                      <div style={styles.netPayRow}>
                        <div style={styles.iconAndTexts}>
                          Daily Rate (₱):{" "}
                          <strong>
                            {`₱${displayAmount.toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`}
                          </strong>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "16px" }}>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          onClick={() => handleEdit(p)}
                          style={{
                            flex: 1,
                            padding: "10px 0",
                            borderRadius: "10px",
                            fontSize: "0.85rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            transition: "all 0.2s",
                            background: "#237227",
                            color: "#ffffff",
                            border: "none",
                            textAlign: "center"
                          }}
                        >
                          Edit
                        </button>
                        {!p.archived && (
                          <button
                            onClick={() => handleArchive(p)}
                            style={{
                              flex: 1,
                              padding: "10px 0",
                              borderRadius: "10px",
                              fontSize: "0.85rem",
                              fontWeight: 600,
                              cursor: "pointer",
                              transition: "all 0.2s",
                              background: "#ffffff",
                              color: "#1f2937",
                              border: "1px solid #d1d5db",
                              textAlign: "center"
                            }}
                          >
                            Archive
                          </button>
                        )}
                      </div>
                      {!p.archived && (
                        <button
                          onClick={() => handleAdminAttendance(p)}
                          style={{
                            width: "100%",
                            padding: "10px 0",
                            borderRadius: "10px",
                            fontSize: "0.85rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            transition: "all 0.2s",
                            background: "#e5e7eb",
                            color: "#1f2937",
                            border: "none",
                            textAlign: "center"
                          }}
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

      {/* Edit Modal */}
      {showEditModal && editPerson && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalContent}>
            <h2 style={styles.modalTitle}>
              <FiEdit style={styles.modalTitleIcon} /> Edit Person
            </h2>
            <form onSubmit={handleEditModalSave}>
              <div style={styles.modalField}>
                <label style={styles.modalLabel}>Registration Photo</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    flexWrap: "wrap",
                  }}
                >
                  {editPerson.registration_photo ? (
                    <img
                      src={editPerson.registration_photo}
                      alt="person"
                      style={{ ...styles.photoPreview, cursor: 'pointer' }}
                      onClick={() => openPhotoModal(editPerson.registration_photo, editPerson.name || editPerson.id)}
                    />
                  ) : (
                    <span style={{ color: "#9ca3af", fontSize: "0.9rem" }}>
                      No photo
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      editPhotoInputRef.current &&
                      editPhotoInputRef.current.click()
                    }
                    style={{
                      ...styles.button,
                      ...styles.buttonSecondary,
                      padding: "8px 16px",
                    }}
                  >
                    Upload New Photo
                  </button>
                </div>
                <input
                  ref={editPhotoInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={handleEditPhotoChange}
                />

              </div>
              <div className="persons-modal-grid" style={styles.modalGrid}>
                <div style={styles.modalField}>
                  <label htmlFor="edit-person-name" style={styles.modalLabel}>Name</label>
                  <input
                    id="edit-person-name"
                    name="edit-person-name"
                    value={editPerson.name || ""}
                    onChange={(e) =>
                      setEditPerson({ ...editPerson, name: e.target.value })
                    }
                    style={styles.modalInput}
                  />
                </div>
                <div style={styles.modalField}>
                  <label htmlFor="edit-person-department" style={styles.modalLabel}>Department</label>
                  <select
                    id="edit-person-department"
                    name="edit-person-department"
                    value={editPerson.department || ""}
                    onChange={(e) =>
                      setEditPerson({ ...editPerson, department: e.target.value })
                    }
                    style={styles.modalSelect}
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

                <div style={styles.modalField}>
                  <label htmlFor="edit-person-phone" style={styles.modalLabel}>Phone</label>
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
                    style={styles.modalInput}
                  />
                </div>
                <div style={styles.modalField}>
                  <label htmlFor="edit-person-email" style={styles.modalLabel}>Email</label>
                  <input
                    id="edit-person-email"
                    name="edit-person-email"
                    value={editPerson.email || ""}
                    onChange={(e) =>
                      setEditPerson({ ...editPerson, email: e.target.value })
                    }
                    style={styles.modalInput}
                  />
                </div>

                <div style={styles.modalField}>
                  <label htmlFor="edit-person-address" style={styles.modalLabel}>Address</label>
                  <input
                    id="edit-person-address"
                    name="edit-person-address"
                    value={editPerson.address || ""}
                    onChange={(e) =>
                      setEditPerson({ ...editPerson, address: e.target.value })
                    }
                    style={styles.modalInput}
                  />
                </div>
                <div style={styles.modalField}>
                  <label htmlFor="edit-person-sex" style={styles.modalLabel}>Sex</label>
                  <select
                    id="edit-person-sex"
                    name="edit-person-sex"
                    value={editPerson.sex || ""}
                    onChange={(e) =>
                      setEditPerson({ ...editPerson, sex: e.target.value })
                    }
                    style={styles.modalSelect}
                  >
                    <option value="">Select sex</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                <div style={{ gridColumn: "1 / -1" }}>
                <label style={styles.modalLabel}>Mandatory Contributions</label>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 200 }}>
                      <label htmlFor="edit-person-sss" style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>SSS Number</label>
                      <input
                        id="edit-person-sss"
                        name="edit-person-sss"
                        type="text"
                        placeholder="e.g. 12-3456789-0"
                        value={editPerson.sss ?? ''}
                        onChange={(e) =>
                          setEditPerson({ ...editPerson, sss: e.target.value })
                        }
                        style={styles.modalInput}
                      />
                    </div>

                    <div style={{ minWidth: 200 }}>
                      <label htmlFor="edit-person-pag-ibig" style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>Pag-ibig Number</label>
                      <input
                        id="edit-person-pag-ibig"
                        name="edit-person-pag-ibig"
                        type="text"
                        placeholder="e.g. 0000-0000-0000"
                        value={editPerson.pag_ibig ?? ''}
                        onChange={(e) =>
                          setEditPerson({ ...editPerson, pag_ibig: e.target.value })
                        }
                        style={styles.modalInput}
                      />
                    </div>

                    <div style={{ minWidth: 200 }}>
                      <label htmlFor="edit-person-philhealth" style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>PhilHealth Number</label>
                      <input
                        id="edit-person-philhealth"
                        name="edit-person-philhealth"
                        type="text"
                        placeholder="e.g. 123456789012"
                        value={editPerson.philhealth ?? ''}
                        onChange={(e) =>
                          setEditPerson({ ...editPerson, philhealth: e.target.value })
                        }
                        style={styles.modalInput}
                      />
                    </div>
                  </div>
                </div>

                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={styles.modalLabel}>Add Cash Advance</label>
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <input
                      id="cash-advance-amount"
                      name="cash-advance-amount"
                      type="number"
                      placeholder="Amount"
                      value={newCashAmount}
                      onChange={(e) => setNewCashAmount(e.target.value)}
                      style={{ ...styles.modalInput, maxWidth: 160 }}
                    />
                    <input
                      id="cash-advance-note"
                      name="cash-advance-note"
                      placeholder="Note (optional)"
                      value={newCashNote}
                      onChange={(e) => setNewCashNote(e.target.value)}
                      style={{ ...styles.modalInput, flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={addCashAdvance}
                      disabled={actionLoading}
                      style={{
                        ...styles.button,
                        ...styles.buttonPrimary,
                        padding: "8px 12px",
                      }}
                    >
                     {Icons.circle}{actionLoading ? "Working..." : "Add"}
                    </button>
                  </div>
                </div>

                <div style={{ gridColumn: "1 / -1", marginTop: 6 }}>
                  <label style={styles.modalLabel}>Cash Advance History</label>
                  {loadingCashAdvances ? (
                    <div style={{ color: "#6b7280" }}>Loading...</div>
                  ) : editCashAdvances && editCashAdvances.length ? (
                    <div
                      style={{
                        maxHeight: 140,
                        overflow: "auto",
                        border: "1px solid #e6eef6",
                        borderRadius: 8,
                        padding: 6,
                      }}
                    >
                      {editCashAdvances.map((c) => (
                        <div
                          key={c.id}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            padding: "6px 8px",
                            borderBottom: "1px solid #f1f5f9",
                          }}
                        >
                          <div style={{ color: "#374151", fontSize: 13 }}>
                            {new Date(c.created_at).toLocaleString()}
                          </div>
                          <div
                            style={{
                              textAlign: "right",
                              display: "flex",
                              gap: 12,
                              alignItems: "center",
                            }}
                          >
                            <div>
                              <div
                                style={{ fontWeight: 700, color: "#0f172a" }}
                              >{`₱${Number(c.amount || 0).toFixed(2)}`}</div>
                              {c.note ? (
                                <div style={{ fontSize: 12, color: "#9ca3af" }}>
                                  {c.note}
                                </div>
                              ) : null}
                            </div>
                            <div>
                              <button
                                type="button"
                                onClick={() => deleteCashAdvance(c.id)}
                                style={{
                                  ...styles.smallButton,
                                  ...styles.buttonSecondary,
                                }}
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
                    <div style={{ color: "#9ca3af" }}>
                      No cash advance history
                    </div>
                  )}
                </div>
              </div>
              <div style={styles.modalActions}>
                <button
                  type="submit"
                  style={{ ...styles.button, ...styles.buttonPrimary }}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={handleEditModalClose}
                  style={{ ...styles.button, ...styles.buttonSecondary }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin Attendance Modal */}
      {adminModal.visible && adminModal.person && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalContent}>
            <h2 style={styles.modalTitle}>Record Attendance</h2>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label style={styles.modalLabel}>Person</label>
                <div style={{ padding: 8, background: "#f9fafb", borderRadius: 8 }}>{adminModal.person.name} • ID: {adminModal.person.id}</div>
              </div>
              <div>
                <label htmlFor="admin-attendance-event" style={styles.modalLabel}>Event</label>
                <select id="admin-attendance-event" name="admin-attendance-event" value={adminModal.event} onChange={(e) => setAdminModal((s) => ({ ...s, event: e.target.value }))} style={styles.modalSelect}>
                  <option value="time-in">Time In</option>
                  <option value="time-out">Time Out</option>
                </select>
              </div>
              <div>
                <label htmlFor="admin-attendance-datetime" style={styles.modalLabel}>Date & time</label>
                <input id="admin-attendance-datetime" name="admin-attendance-datetime" type="datetime-local" value={adminModal.datetime} onChange={(e) => setAdminModal((s) => ({ ...s, datetime: e.target.value }))} style={styles.modalInput} />
              </div>
              <div>
                <label style={styles.modalLabel}>Location</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1, padding: 8, background: '#f9fafb', borderRadius: 8, minHeight: 40 }}>{adminModal.point ? adminModal.point : <span style={{ color: '#9ca3af' }}>—</span>}</div>
                  <button
                    onClick={async () => {
                      try {
                        setLocLoading(true);
                        const locationResult = await getCurrentLocationPoint();
                        setAdminModal((s) => ({ ...s, point: locationResult.point, locationStatus: locationResult.status, locationMessage: locationResult.message }));
                      } catch (e) {
                        setAdminModal((s) => ({ ...s, point: null, locationStatus: "unavailable", locationMessage: "Location could not be determined on this device." }));
                      } finally {
                        setLocLoading(false);
                      }
                    }}
                    style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}
                    disabled={locLoading}
                  >
                    {locLoading ? 'Refreshing...' : 'Refresh'}
                  </button>
                </div>
                {adminModal.locationMessage && adminModal.locationStatus && adminModal.locationStatus !== "ok" && (
                  <div style={{ marginTop: 6, color: '#b45309', fontSize: 12, lineHeight: 1.4 }}>
                    {adminModal.locationMessage}
                  </div>
                )}
              </div>
              {/* <div>
                <label style={styles.modalLabel}>Registered Photo</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {adminModal.photo && <img src={adminModal.photo} alt="preview" style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 8 }} />}
                </div>
              </div> */}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setAdminModal({ visible: false, person: null, event: "time-in", datetime: "", photo: null, note: "", point: null })} style={{ ...styles.button, ...styles.buttonSecondary }}>Cancel</button>
                <button onClick={submitAdminAttendance} style={{ ...styles.button, ...styles.buttonPrimary }}>{actionLoading ? "Recording..." : "Record"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Photo modal for Registered Persons */}
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
  actionButtons: {
    display: "flex",
    gap: "10px",
    flexWrap: "nowrap",
    alignItems: "center",
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
  buttonSuccess: {
    background: "#237227",
    color: "#ffffff",
  },
  smallButton: {
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
  },
  td: {
    padding: "14px 12px",
    borderBottom: "1px solid #e5e7eb",
    color: "#1f2937",
  },
  tr: {
    transition: "background 0.2s",
  },
  photo: {
    width: "48px",
    height: "48px",
    objectFit: "cover",
    borderRadius: "8px",
    border: "1px solid #e5e7eb",
  },
  photoPreview: {
    width: "88px",
    height: "88px",
    objectFit: "cover",
    borderRadius: "12px",
    border: "2px solid rgba(34,197,94,0.12)",
    boxShadow: "0 6px 18px rgba(16,185,129,0.08)",
  },
  actionCell: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  },
  cardsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "20px",
    alignItems: "stretch",
  },
  card: {
    background: "#ffffff",
    borderRadius: "12px",
    border: "1px solid #e5e7eb",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    boxShadow: "0 8px 20px rgba(16,185,129,0.05)",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "12px",
  },
  cardAvatarWrapper: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "84px",
    height: "84px",
    marginRight: "12px",
  },
  cardAvatar: {
    width: "84px",
    height: "84px",
    borderRadius: "50%",
    objectFit: "cover",
    border: "4px solid #fff",
    boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
  },
  cardAvatarPlaceholder: {
    width: "84px",
    height: "84px",
    borderRadius: "50%",
    background: "linear-gradient(135deg,#3b82f6,#06b6d4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontWeight: 700,
    fontSize: "1.2rem",
  },
  cardStatus: {
    marginLeft: "auto",
  },
  badgePresent: {
    background: "#237227",
    color: "#fff",
    padding: "6px 10px",
    borderRadius: "20px",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  badgeAbsent: {
    background: "#ef4444",
    color: "#fff",
    padding: "6px 10px",
    borderRadius: "20px",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  badgeActive: {
    background: "#237227",
    color: "#fff",
    padding: "6px 10px",
    borderRadius: "20px",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  badgeArchived: {
    background: "#ef4444",
    color: "#fff",
    padding: "6px 10px",
    borderRadius: "20px",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  cardBody: {
    paddingTop: "6px",
    paddingBottom: "12px",
  },
  cardName: {
    margin: 0,
    fontSize: "1.05rem",
    fontWeight: 700,
    color: "#111827",
  },
  cardId: {
    display: "inline-block",
    marginTop: "6px",
    padding: "6px 10px",
    borderRadius: "12px",
    background: "#e5e7eb",
    color: "#374151",
    fontSize: "0.8rem",
    fontFamily: "monospace",
  },
  cardInfoRow: {
    marginTop: "10px",
    color: "#6b7280",
    fontSize: "0.95rem",
  },
  iconAndText: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    color: "#374151",
    flexWrap: "wrap",
  },
  deptIcon: {
    color: "#06b6d4",
    fontSize: "1.05rem",
  },
  phoneRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: "8px",
  },
  phoneIcon: {
    color: "#3b82f6",
    fontSize: "1rem",
  },
  emailIcon: {
    color: "#6b7280",
    fontSize: "1rem",
    marginRight: 6,
    marginTop: 2,
  },
  contactText: {
    maxWidth: "220px",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
    color: "#374151",
    display: "inline-block",
  },
  netPayRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: "8px",
  },
  iconAndTexts: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    fontWeight: 700,
    color: "#237227",
  },
  cardActions: {
    display: "flex",
    gap: "8px",
    marginTop: "12px",
    justifyContent: "flex-start",
  },
  emptyState: {
    textAlign: "center",
    padding: "60px 20px",
    color: "#6b7280",
    fontSize: "1.1rem",
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
  error: {
    color: "#ef4444",
    textAlign: "center",
    padding: "40px",
    background: "#ffffff",
    borderRadius: "32px",
    margin: "40px auto",
    maxWidth: "800px",
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
  modalOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    background: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1000,
    backdropFilter: "blur(4px)",
  },
  modalContent: {
    background: "#fff",
    color: "#1f2937",
    padding: "28px",
    borderRadius: "28px",
    maxWidth: "900px",
    width: "95%",
    overflowY: "auto",
    maxHeight: "90%",
    boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
    border: "1px solid #e5e7eb",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  modalClose: {
    position: "absolute",
    top: "14px",
    right: "14px",
    background: "#fff",
    border: "none",
    color: "#6b7280",
    fontSize: "1.1rem",
    cursor: "pointer",
    lineHeight: 1,
    width: 40,
    height: 40,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 6px 18px rgba(15,23,42,0.06)",
  },
  modalTitle: {
    fontSize: "2rem",
    fontWeight: 700,
    marginBottom: "16px",
    color: "#0f3d16",
    textAlign: "center",
  },
  modalTitleIcon: {
    color: "#237227",
    marginRight: 8,
    verticalAlign: "middle",
    fontSize: "1.25rem",
  },
  modalField: {
    marginBottom: "18px",
    display: "block",
  },
  modalLabel: {
    display: "block",
    fontSize: "0.85rem",
    fontWeight: 600,
    color: "#374151",
    marginBottom: "8px",
  },
  modalInput: {
    width: "100%",
    padding: "12px 14px",
    fontSize: "1rem",
    borderRadius: "12px",
    border: "1px solid #e6eef6",
    background: "#ffffff",
    color: "#0f172a",
    outline: "none",
    transition: "border-color 0.12s, box-shadow 0.12s",
    boxSizing: "border-box",
    boxShadow: "inset 0 1px 2px rgba(15,23,42,0.03)",
  },
  modalSelect: {
    width: "100%",
    padding: "12px 14px",
    fontSize: "1rem",
    borderRadius: "12px",
    border: "1px solid #e6eef6",
    background: "#ffffff",
    color: "#0f172a",
    outline: "none",
  },
  modalCheckboxGroup: {
    display: "flex",
    gap: "20px",
    flexWrap: "wrap",
  },
  modalCheckbox: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    color: "#374151",
  },
  modalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "12px",
    marginTop: "20px",
  },
  modalGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
    alignItems: "start",
  },
};

// Add global keyframes and focus styles
const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  input:focus, select:focus, button:focus {
    border-color: #237227 !important;
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2) !important;
    outline: none;
  }
  button:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
  }
  /* SweetAlert2 light theme overrides */
  .swal-light-popup {
    background: #ffffff !important;
    color: #1f2937 !important;
    border-radius: 28px !important;
    border: 1px solid #e5e7eb !important;
  }
  .swal-light-title {
    color: #1f2937 !important;
  }
  .swal-light-html {
    color: #4b5563 !important;
  }
  .swal-light-confirm {
    background: #237227 !important;
    border: none !important;
    border-radius: 40px !important;
    padding: 10px 24px !important;
    font-weight: 600 !important;
  }
  .swal-light-cancel {
    background: #e5e7eb !important;
    color: #1f2937 !important;
    border-radius: 40px !important;
    border: 1px solid #d1d5db !important;
  }
`;
document.head.appendChild(styleSheet);
// Responsive grid for the modal form
const extraStyles = document.createElement("style");
extraStyles.textContent = `
.persons-modal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
@media (max-width: 640px) {
  .persons-modal-grid { grid-template-columns: 1fr !important; }
}
`;
document.head.appendChild(extraStyles);
