
import { useEffect, useState, useRef, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import Swal from "sweetalert2";
import { supabase, SUPABASE_CONFIGURED } from "../supabaseClient";
import {
  toFloat32Array,
  normalizeDescriptor,
  euclideanDistance,
  averageDescriptors,
} from "../utils/faceUtils";
import { recordAttendanceForPerson } from "../AdminPage/attendanceUtils";

// Face recognition threshold – adjust based on your model
const FACE_MATCH_THRESHOLD = 0.35;

export default function PersonDetails({
  scanPayload,
  onComplete,
  hidePersonTable = false,
}) {
  const rawDescriptor = scanPayload?.descriptor || null;
  const descriptor = rawDescriptor
    ? normalizeDescriptor(toFloat32Array(rawDescriptor))
    : null;
  const isRegistrationMode = descriptor && descriptor.length > 0;

  const [persons, setPersons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState({
    id: "",
    name: "",
    department: "",
    phone_number: "",
    email: "",
    address: "",
    sex: "",
  });
  const [deptRates, setDeptRates] = useState([]);
  const [saving, setSaving] = useState(false);
  const [customDepartment, setCustomDepartment] = useState(false);
  const [customDeptValue, setCustomDeptValue] = useState("");
  const [settings, setSettings] = useState(null);
  const [matchedCandidate, setMatchedCandidate] = useState(null);

  const selectedPerson =
    persons.find((person) => person.id === selectedId) || null;
  const isLinkingExistingPerson = isRegistrationMode && Boolean(selectedId);
  const selectedPersonHasFace = Boolean(
    selectedPerson?.descriptor && selectedPerson.descriptor.length
  );
  
  // Derive department list from deptRates
  const departmentList = deptRates.map((d) => d.department).filter(Boolean);

  // Guard refs to avoid overlapping fetches
  const fetchInProgressRef = useRef(false);
  const lastFetchAtRef = useRef(0);
  const rejectedMatchRef = useRef(false);

  const loadPersons = useCallback(
    async (opts = { force: false }) => {
      if (!SUPABASE_CONFIGURED || !supabase) {
        setError(
          "Supabase not configured in frontend. Please set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY."
        );
        setLoading(false);
        return;
      }

      const now = Date.now();
      if (!opts.force && fetchInProgressRef.current) return;
      if (!opts.force && now - lastFetchAtRef.current < 2000) return; // rate-limit

      fetchInProgressRef.current = true;
      setError(null);
      setLoading(true);
      try {
        const { data, error: err } = await supabase
          .from("persons")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(200);

        if (err) throw err;
        const list = data || [];

        const mapped = list.map((p) => ({
          ...p,
          descriptor: p.descriptor
            ? Array.isArray(p.descriptor) && Array.isArray(p.descriptor[0])
              ? averageDescriptors(p.descriptor)
              : normalizeDescriptor(toFloat32Array(p.descriptor))
            : null,
        }));
        setPersons(mapped);

        // Auto-select first person if appropriate (only when NOT in registration mode)
          if (!selectedId && mapped.length && !descriptor) {
          const first = mapped[0];
          setSelectedId(first.id);
          setForm({
              id: first.id || "",
              name: first.name || "",
              phone_number: first.phone_number || "",
              email: first.email || "",
              address: first.address || "",
              sex: first.sex || "",
          });
          if (
            first.department &&
            !departmentList.includes(first.department)
          ) {
            setCustomDepartment(true);
            setCustomDeptValue(first.department);
          } else {
            setCustomDepartment(false);
            setCustomDeptValue("");
          }
        }

        // If we have a live descriptor (registration scan), try to find a confident match and pre-select it
        if (descriptor && mapped.length) {
          if (rejectedMatchRef.current) {
            setMatchedCandidate(null);
          } else {
            const candidates = mapped
              .filter((p) => p.descriptor)
              .map((p) => ({
                p,
                dist: euclideanDistance(descriptor, p.descriptor),
              }))
              .sort((a, b) => a.dist - b.dist);
            const best = candidates.length ? candidates[0] : null;
            const second = candidates.length > 1 ? candidates[1] : null;
            const margin = second ? second.dist - best.dist : Infinity;
            if (best && best.dist < FACE_MATCH_THRESHOLD && margin >= 0.05) {
              // pre-select the matched person but allow user to change
              setSelectedId(best.p.id);
              setMatchedCandidate({
                id: best.p.id,
                name: best.p.name || "",
                dist: best.dist,
              });
              setForm((prev) => ({
                ...prev,
                id: best.p.id,
                name: best.p.name || prev.name,
                department: best.p.department || prev.department,
                phone_number: best.p.phone_number || prev.phone_number,
                address: best.p.address || prev.address,
                sex: best.p.sex || prev.sex,
              }));
            } else {
              setMatchedCandidate(null);
            }
          }
        } else {
          setMatchedCandidate(null);
        }

        lastFetchAtRef.current = Date.now();
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
          setError(
            "Network error: unable to reach Supabase. Check your internet connection and REACT_APP_SUPABASE_URL."
          );
        } else {
          setError(msg);
        }
        console.error("Error loading persons:", e);
      } finally {
        fetchInProgressRef.current = false;
        setLoading(false);
      }
    },
    [descriptor, selectedId, departmentList]
  );

  useEffect(() => {
    // initial load
    loadPersons();

    // fetch department rates and settings once
    async function fetchDeptRates() {
      if (!SUPABASE_CONFIGURED || !supabase) return;
      try {
        const { data, error } = await supabase
          .from("department_rates")
          .select("*");
        if (!error && data) setDeptRates(data);
      } catch (err) {
        console.error("Error fetching department rates:", err);
      }
    }
    async function fetchSettings() {
      if (!SUPABASE_CONFIGURED || !supabase) return;
      try {
        const { data, error } = await supabase
          .from("settings")
          .select("*")
          .eq("id", 1)
          .maybeSingle();
        if (!error && data) setSettings(data);
      } catch (err) {
        console.error("Error fetching settings:", err);
      }
    }

    fetchDeptRates();
    fetchSettings();
  }, [loadPersons]);

  function onSelect(person) {
    setSelectedId(person.id);
    setForm({
      id: person.id || "",
      name: person.name || "",
      department: person.department || "",
      phone_number: person.phone_number || "",
      email: person.email || "",
      address: person.address || "",
      sex: person.sex || "",
    });
    if (person.department && !departmentList.includes(person.department)) {
      setCustomDepartment(true);
      setCustomDeptValue(person.department);
    } else {
      setCustomDepartment(false);
      setCustomDeptValue("");
    }
  }

  function onChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function handleDepartmentChange(e) {
    const value = e.target.value;
    if (value === "Other") {
      setCustomDepartment(true);
      setForm((prev) => ({ ...prev, department: "" }));
    } else {
      setCustomDepartment(false);
      setCustomDeptValue("");
      setForm((prev) => ({ ...prev, department: value }));
    }
  }

  function handleCustomDeptChange(e) {
    setCustomDeptValue(e.target.value);
  }

  function handleRejectMatch() {
    rejectedMatchRef.current = true;
    setMatchedCandidate(null);
    setSelectedId("");
    setForm({
      id: "",
      name: "",
      department: "",
      phone_number: "",
      address: "",
      sex: "",
    });
  }

  useEffect(() => {
    // When a new scan payload arrives, clear any previous "reject" state so matching can run again
    rejectedMatchRef.current = false;
  }, [scanPayload]);

  async function onSave(e) {
    e.preventDefault();
    if (!SUPABASE_CONFIGURED || !supabase) {
      setError(
        "Supabase not configured in frontend. Please set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY."
      );
      return;
    }

    let personId = form.id;
    const isNew = !personId;
    if (isNew) {
      // Generate a readable incremental employee ID like EMP001, EMP002, ...
      // We look for existing IDs starting with 'EMP' and pick the next number.
      try {
        const { data: empRows, error: empErr } = await supabase
          .from("persons")
          .select("id")
          .like("id", "EMP%");

        if (empErr) throw empErr;
        const numbers = (empRows || [])
          .map((r) => {
            const m = /^EMP0*(\d+)$/.exec(r.id || "");
            return m ? parseInt(m[1], 10) : null;
          })
          .filter((n) => n !== null);
        const max = numbers.length ? Math.max(...numbers) : 0;
        const next = max + 1;
        personId = `EMP${String(next).padStart(3, "0")}`;
      } catch (e) {
        // Fallback to UUID if anything goes wrong with the ID generation
        personId = uuidv4();
      }
    }

    // Determine final department value
    let finalDepartment = form.department;
    if (customDepartment) {
      finalDepartment = customDeptValue.trim() || null;
    }

    // Get department rate
    let daily_rate = null;
    let late_penalty = null;
    if (finalDepartment) {
      const dept = deptRates.find((d) => d.department === finalDepartment);
      if (dept) {
        daily_rate = dept.daily_rate;
        late_penalty = dept.late_penalty;
      }
    }

    setSaving(true);
    setError(null);

    try {
      const isLinkingExistingRecord = Boolean(form.id);
      const existingPersonForSave =
        persons.find((person) => person.id === personId) || null;
      const isLinkingFaceEnrollment =
        isRegistrationMode &&
        isLinkingExistingRecord &&
        !existingPersonForSave?.descriptor;

      // --- FACE DUPLICATE VALIDATION ---
      if (descriptor) {
        const newDesc = descriptor; // already normalized Float32Array
        const duplicateFace = persons.find((p) => {
          if (p.id === personId) return false; // skip current person
          if (!p.descriptor) return false;
          const dist = euclideanDistance(newDesc, p.descriptor);
          return dist < FACE_MATCH_THRESHOLD;
        });

        if (duplicateFace) {
          await Swal.fire({
            toast: true,
            position: "top-end",
            icon: "error",
            title: `Duplicate Face: ${duplicateFace.name || "another person"} (ID: ${duplicateFace.id}). Registration denied.`,
            showConfirmButton: false,
            timer: 3500,
            timerProgressBar: true,
            customClass: {
              popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
              title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
              timerProgressBar: "!bg-red-500",
            },
          });
          setSaving(false);
          return;
        }
      }

      // --- NAME DUPLICATE VALIDATION (optional) ---
      if (form.name && form.name.trim() !== "") {
        const newName = form.name.trim();
        const duplicateName = persons.find((p) => {
          if (p.id === personId) return false; // skip current person
          return (
            p.name && p.name.trim().toLowerCase() === newName.toLowerCase()
          );
        });

        if (duplicateName) {
          await Swal.fire({
            toast: true,
            position: "top-end",
            icon: "error",
            title: `Duplicate Name: "${form.name}" already used by ${duplicateName.name}.`,
            showConfirmButton: false,
            timer: 3500,
            timerProgressBar: true,
            customClass: {
              popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
              title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
              timerProgressBar: "!bg-red-500",
            },
          });
          setSaving(false);
          return;
        }
      }

      // --- END VALIDATION ---

      // Decide whether to store a registration photo.
      // To avoid unexpected image changes, we only ever set
      // registration_photo when creating a brand-new person here.
      // Existing persons keep whatever registration_photo they already have.
      const registrationPhoto =
        isNew && scanPayload && scanPayload.photoDataUrl
          ? scanPayload.photoDataUrl
          : undefined;

      const payload = {
        id: personId,
        name: form.name || null,
        department: finalDepartment,
        phone_number: form.phone_number || null,
        email: form.email || null,
        address: form.address || null,
        sex: form.sex || null,
        descriptor: descriptor ? Array.from(descriptor) : null,
        daily_rate,
        late_penalty,
        registration_photo: registrationPhoto,
      };

      const { error: err } = await supabase
        .from("persons")
        .upsert([payload], { onConflict: "id" });

      if (err) throw err;

      // Refresh list
      const { data } = await supabase
        .from("persons")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);

      setPersons(data || []);
      setSelectedId(personId);
      setForm({
        id: personId,
        name: form.name,
        department: finalDepartment,
        phone_number: form.phone_number,
        email: form.email,
        address: form.address,
        sex: form.sex,
      });

      // Reset custom department state
      if (finalDepartment && !departmentList.includes(finalDepartment)) {
        setCustomDepartment(true);
        setCustomDeptValue(finalDepartment);
      } else {
        setCustomDepartment(false);
        setCustomDeptValue("");
      }

      const savedPerson = {
        id: personId,
        name: form.name || null,
        department: finalDepartment,
      };

      // Only record attendance if linking a face to an existing person (not for new registration)
      if (
        isRegistrationMode &&
        scanPayload &&
        settings &&
        isLinkingFaceEnrollment
      ) {
        const attendanceResult = await recordAttendanceForPerson({
          supabase,
          person: savedPerson,
          settings,
          scanPayload,
        });

        if (attendanceResult.inserted) {
          await Swal.fire({
            toast: true,
            position: "top-end",
            icon: attendanceResult.status === "late" ? "warning" : "success",
            title: "Face linked & attendance recorded!",
            showConfirmButton: false,
            timer: 2500,
            timerProgressBar: true,
            iconColor: attendanceResult.status === "late" ? "#f59e0b" : "#237227",
            customClass: {
              popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
              title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
              timerProgressBar: attendanceResult.status === "late" ? "!bg-[#f59e0b]" : "!bg-[#237227]",
            },
          });
        } else {
          let blockedMessage = attendanceResult.message;
          if (attendanceResult.event === "already-timed-in") {
            blockedMessage =
              "Face linked to person, but already timed in for current work window.";
          }
          await Swal.fire({
            toast: true,
            position: "top-end",
            icon: "info",
            title: blockedMessage || "Face linked successfully!",
            showConfirmButton: false,
            timer: 3000,
            timerProgressBar: true,
            customClass: {
              popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
              title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
              timerProgressBar: "!bg-blue-500",
            },
          });
        }
      } else {
        await Swal.fire({
          toast: true,
          position: "top-end",
          icon: "success",
          title: "Person registered successfully!",
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

      if (typeof onComplete === "function") {
        onComplete();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="person-details-container mt-6 w-full max-w-full">
      <style>{`
        .person-details-container button,
        .person-details-container button:hover,
        .person-details-container button:focus,
        .person-details-container button:active,
        .person-details-container * {
          transform: none !important;
        }
        .person-details-container button:hover {
          box-shadow: none !important;
        }
        .person-details-container input:focus,
        .person-details-container select:focus {
          outline: none !important;
          box-shadow: none !important;
          border-color: #237227 !important;
        }
      `}</style>
      <h2 className="text-xl font-bold mb-4">Person Details Registration</h2>
      {isRegistrationMode &&
        (matchedCandidate ? (
          <div className="mb-4 py-3 px-4 rounded-md bg-blue-900 border border-blue-800 text-blue-100 flex justify-between items-center">
            <div>
              Face appears to match{" "}
              <strong className="font-bold">{matchedCandidate.name || matchedCandidate.id}</strong>{" "}
              (distance {matchedCandidate.dist.toFixed(3)}). You can confirm or
              choose another person.
            </div>
            <div className="ml-3 shrink-0">
              <button
                type="button"
                onClick={handleRejectMatch}
                className="py-1.5 px-2.5 bg-orange-500 hover:bg-orange-600 text-white border-none rounded-lg cursor-pointer transition-colors shadow-none hover:shadow-none !transform-none focus:outline-none focus:ring-0"
              >
                Not my face
              </button>
            </div>
          </div>
        ) : (
          <div className="mb-4 py-3 px-4 rounded-md bg-[#1f3b2f] border border-[#2f855a] text-[#e6fffa]">
            Face not enrolled yet. Complete registration first, or select an
            existing person without a saved face to link this scan before
            attendance can be logged.
          </div>
        ))}

      {!hidePersonTable && loading && <p className="text-gray-500">Loading persons...</p>}
      {!hidePersonTable && error && (
        <div className="mb-3">
          <p className="text-red-500 m-0">{error}</p>
          <div className="mt-2">
            <button
              onClick={() => {
                setError(null);
                loadPersons({ force: true });
              }}
              className="py-1.5 px-2.5 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg transition-colors shadow-none hover:shadow-none !transform-none focus:outline-none focus:ring-0"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <div className={`flex gap-6 items-start w-full ${hidePersonTable ? 'flex-col' : 'flex-col md:flex-row'}`}>
        {!hidePersonTable && (
          <div className="flex-1 max-h-[360px] overflow-y-auto w-full md:w-auto">
            <table className="w-full border-collapse text-sm text-left">
              <thead>
                <tr>
                  <th className="border-b border-gray-600 p-2 font-semibold">ID</th>
                  <th className="border-b border-gray-600 p-2 font-semibold">Name</th>
                  <th className="border-b border-gray-600 p-2 font-semibold">Department</th>
                  <th className="border-b border-gray-600 p-2 font-semibold">Phone</th>
                  <th className="border-b border-gray-600 p-2 font-semibold">Address</th>
                  <th className="border-b border-gray-600 p-2 font-semibold">Gender</th>
                </tr>
              </thead>
              <tbody>
                {persons.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => onSelect(p)}
                    className={`cursor-pointer transition-colors ${selectedId === p.id ? 'bg-gray-700' : 'hover:bg-gray-800/50'}`}
                  >
                    <td className="border-b border-gray-700 p-1.5">{p.id}</td>
                    <td className="border-b border-gray-700 p-1.5">{p.name || ""}</td>
                    <td className="border-b border-gray-700 p-1.5">{p.department || ""}</td>
                    <td className="border-b border-gray-700 p-1.5">{p.phone_number || ""}</td>
                    <td className="border-b border-gray-700 p-1.5">{p.address || ""}</td>
                    <td className="border-b border-gray-700 p-1.5">{p.sex || ""}</td>
                  </tr>
                ))}
                {!persons.length && !loading && (
                  <tr>
                    <td colSpan={6} className="p-2 text-gray-500 text-center">
                      No persons yet. They will appear after the first scan or
                      you can add one manually.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <form
          onSubmit={onSave}
          className={`${hidePersonTable ? 'w-full' : 'md:basis-[280px] w-full shrink-0'}`}
        >
          <h3 className="text-lg font-semibold mb-3">
            {isLinkingExistingPerson
              ? "Link Face To Existing Person"
              : selectedId
              ? "Edit Person"
              : "Add Person"}
          </h3>
          {isRegistrationMode && !selectedId && (
            <p className="mt-0 mb-3 text-slate-300 text-[13px] leading-[1.4]">
              This face is not enrolled yet. Save a new profile or select an
              existing person without a saved face, and the current scan will be
              used right away unless the work-hours rules block attendance for
              this time window.
            </p>
          )}
          {isLinkingExistingPerson && !selectedPersonHasFace && (
            <p className="mt-0 mb-3 text-slate-300 text-[13px] leading-[1.4]">
              You are linking this scanned face to the selected existing person
              record.
            </p>
          )}

          {/* Person ID - only show when editing, read-only */}
          {selectedId && (
            <div className="mb-2 text-left flex flex-col">
              <label className="text-sm text-gray-200">Person ID</label>
              <input
                name="id"
                value={form.id}
                readOnly
                className="w-full p-1.5 mt-1 bg-gray-700 border border-gray-600 text-gray-300 rounded cursor-not-allowed focus:outline-none"
              />
            </div>
          )}

          {/* Name field */}
          <div className="mb-2 text-left flex flex-col">
            <label className="text-sm text-gray-200">Name</label>
            <input
              name="name"
              value={form.name}
              onChange={onChange}
              className="w-full p-1.5 mt-1 bg-gray-800 border border-gray-600 text-white rounded focus:outline-none focus:border-[#237227] focus:ring-0 transition-colors"
            />
          </div>

          {/* Phone number field */}
          <div className="mb-2 text-left flex flex-col">
            <label className="text-sm text-gray-200">Phone Number</label>
            <input
              name="phone_number"
              value={form.phone_number}
              onChange={onChange}
              className="w-full p-1.5 mt-1 bg-gray-800 border border-gray-600 text-white rounded focus:outline-none focus:border-[#237227] focus:ring-0 transition-colors"
            />
          </div>

          {/* Email field */}
          <div className="mb-2 text-left flex flex-col">
            <label className="text-sm text-gray-200">Email</label>
            <input
              name="email"
              type="email"
              value={form.email}
              onChange={onChange}
              className="w-full p-1.5 mt-1 bg-gray-800 border border-gray-600 text-white rounded focus:outline-none focus:border-[#237227] focus:ring-0 transition-colors"
            />
          </div>

          {/* Address field */}
          <div className="mb-2 text-left flex flex-col">
            <label className="text-sm text-gray-200">Address</label>
            <input
              name="address"
              value={form.address}
              onChange={onChange}
              className="w-full p-1.5 mt-1 bg-gray-800 border border-gray-600 text-white rounded focus:outline-none focus:border-[#237227] focus:ring-0 transition-colors"
            />
          </div>

          {/* Sex field */}
          <div className="mb-2 text-left flex flex-col">
            <label className="text-sm text-gray-200">Sex</label>
            <select
              name="sex"
              value={form.sex}
              onChange={onChange}
              className="w-full p-1.5 mt-1 bg-gray-800 border border-gray-600 text-white rounded focus:outline-none focus:border-[#237227] focus:ring-0 transition-colors"
            >
              <option value="">Select sex</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
          </div>

          {/* Department dropdown */}
          <div className="mb-3 text-left flex flex-col">
            <label className="text-sm text-gray-200">Department</label>
            <select
              value={customDepartment ? "" : form.department}
              onChange={handleDepartmentChange}
              className="w-full p-1.5 mt-1 bg-gray-800 border border-gray-600 text-white rounded focus:outline-none focus:border-[#237227] focus:ring-0 transition-colors"
            >
              <option value="">Select department</option>
              {departmentList.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
            {customDepartment && (
              <div className="mt-1">
                <input
                  type="text"
                  placeholder="Enter department"
                  value={customDeptValue}
                  onChange={handleCustomDeptChange}
                  className="w-full p-1.5 mt-1 bg-gray-800 border border-gray-600 text-white rounded focus:outline-none focus:border-[#237227] focus:ring-0 transition-colors"
                />
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={saving}
            className="w-full py-2.5 px-4 bg-[#237227] hover:bg-[#1e5f21] disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors focus:outline-none focus:ring-0 shadow-none hover:shadow-none !transform-none hover:!transform-none"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </form>
      </div>
    </div>
  );
}