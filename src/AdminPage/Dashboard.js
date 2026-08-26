import React, { useEffect, useState, useRef, useMemo, Fragment } from "react";
import { supabase } from "../supabaseClient";
import Swal from "sweetalert2";
import { FiTrendingUp, FiUsers, FiClock, FiDownload, FiChevronLeft, FiChevronRight } from "react-icons/fi";
import { determineAttendanceStatus } from "./attendanceUtils";

function compactNumber(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function buildLastNMonths(n = 12) {
  const res = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("en-US", { month: "short", year: "numeric" });
    res.push({ key, label });
  }
  return res;
}

function buildLastNDays(n = 30) {
  const res = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const label = d.toLocaleString("en-US", { month: "short", day: "numeric" });
    res.push({ key, label });
  }
  return res;
}

function buildLastNWeeks(n = 12) {
  const res = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const day = (d.getDay() + 6) % 7;
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    const label = start.toLocaleString("en-US", { month: "short", day: "numeric" });
    res.push({ key, label });
  }
  return res;
}

function parsePeriodEnd(period) {
  if (!period) return null;
  const s = String(period).trim();
  let matches = Array.from(s.matchAll(/(\d{4}[-/]\d{2}[-/]\d{2})/g)).map((m) => m[1]);
  if (matches.length) return new Date(matches[matches.length - 1].replace(/\//g, "-"));

  matches = Array.from(s.matchAll(/(\d{2}[-/.]\d{2}[-/.]\d{4})/g)).map((m) => m[1]);
  if (matches.length) {
    const parts = matches[matches.length - 1].split(/[-/.]/);
    return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
  }

  if (s.includes("-")) {
    const parts = s.split(/[-–—]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      const parsed = parsePeriodEnd(last);
      if (parsed) return parsed;
    }
  }

  if (/\bto\b/i.test(s)) {
    const parts = s.split(/to/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const parsed = parsePeriodEnd(parts[parts.length - 1]);
      if (parsed) return parsed;
    }
  }

  const my = s.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}/i);
  if (my) {
    const dt = new Date('1 ' + my[0]);
    if (!Number.isNaN(dt.getTime())) {
      return new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
    }
  }

  const fallback = new Date(s);
  if (!Number.isNaN(fallback.getTime())) return fallback;
  return null;
}

function isPeriodEnded(period) {
  const end = parsePeriodEnd(period);
  if (!end) return false;
  const today = new Date();
  const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
  return endOfDay <= today;
}

function isPeriodEndedNow(period, settings) {
  const end = parsePeriodEnd(period);
  if (!end) return false;
  const now = new Date();
  if (
    end.getFullYear() === now.getFullYear() &&
    end.getMonth() === now.getMonth() &&
    end.getDate() === now.getDate()
  ) {
    try {
      const hhmm = (settings && settings.afternoon_end) || null;
      if (hhmm) {
        const parts = String(hhmm).split(":").map(Number);
        const h = Number.isFinite(parts[0]) ? parts[0] : 17;
        const m = Number.isFinite(parts[1]) ? parts[1] : 0;
        const endOfPeriod = new Date(end.getFullYear(), end.getMonth(), end.getDate(), h, m, 0, 0);
        return now >= endOfPeriod;
      }
    } catch (e) {}
    const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
    return now >= endOfDay;
  }
  const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
  return endOfDay <= now;
}

function formatPeriod(period) {
  if (!period) return "";
  try {
    const s = String(period).replace(/_/g, " ");
    const matches = Array.from(s.matchAll(/(\d{4}[-/]\d{2}[-/]\d{2})/g)).map(m => m[1]);
    if (matches.length >= 2) {
      const d1 = new Date(matches[0].replace(/\//g, '-'));
      const d2 = new Date(matches[1].replace(/\//g, '-'));
      if (!Number.isNaN(d1.getTime()) && !Number.isNaN(d2.getTime())) {
        const f1 = d1.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' });
        const f2 = d2.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' });
        return `${f1} to ${f2}`;
      }
    }
    const single = s.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
    if (single) {
      const d = new Date(single[1].replace(/\//g, '-'));
      if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' });
    }
    const p = new Date(s);
    if (!Number.isNaN(p.getTime())) return p.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' });
  } catch (e) {}
  return String(period);
}

export default function Dashboard() {
  const [attendance, setAttendance] = useState([]);
  const [persons, setPersons] = useState([]);
  const [totalEmployees, setTotalEmployees] = useState(0);
  const [settings, setSettings] = useState(null);
  const [payrolls, setPayrolls] = useState([]);
  const [payrollSearch, setPayrollSearch] = useState("");
  const [payrollSort] = useState("name-asc");
  const [payrollShowAll, setPayrollShowAll] = useState(false);
  const [, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState({ visible: false, x: 0, y: 0, title: "", items: [] });
  const presentCardRef = useRef(null);
  const absentCardRef = useRef(null);
  const tooltipHideTimerRef = useRef(null);
  const [photoModal, setPhotoModal] = useState({ visible: false, src: "", title: "" });

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      try {
        const [attRes, personsRes, payrollRes, settingsRes] = await Promise.all([
          supabase.from("attendance").select("device_time,person_id,photo,name,department,event,status,method,point"),
          supabase.from("persons").select("id,name,department,registration_photo", { count: 'exact' }),
          supabase.from("payroll_periods").select("id,person_id,period,released"),
          supabase.from("settings").select("*").eq("id", 1).maybeSingle(),
        ]);

        if (!mounted) return;
        setAttendance(attRes.data || []);
        setPersons(personsRes.data || []);
        try { console.debug && console.debug("personsRes", personsRes); } catch (e) {}
        setTotalEmployees((personsRes && personsRes.data && personsRes.data.length) || 0);
        setPayrolls(payrollRes.data || []);
        try {
          const debugPayrolls = (payrollRes.data || []).map((p) => ({
            id: p.id,
            period: p.period,
            released: !!p.released,
            parsedEnd: parsePeriodEnd(p.period),
            ended: isPeriodEnded(p.period),
          }));
          console.debug('payrolls debug', debugPayrolls);
        } catch (e) {}
        setSettings(settingsRes && settingsRes.data ? settingsRes.data : null);
      } catch (err) {
        console.error(err);
        Swal.fire("Data load error", err.message || String(err), "error");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    const int = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) load(); }, 300_000);
    return () => {
      mounted = false;
      clearInterval(int);
    };
  }, []);

  useEffect(() => {
    setTotalEmployees((persons && persons.length) || 0);
  }, [persons]);

  const [viewMode, setViewMode] = useState("month");

  const chartData = useMemo(() => {
    let buckets = [];
    if (viewMode === "day") buckets = buildLastNDays(30);
    else if (viewMode === "week") buckets = buildLastNWeeks(12);
    else buckets = buildLastNMonths(12);

    const counts = Object.fromEntries(buckets.map((b) => [b.key, 0]));

    attendance.forEach((a) => {
      try {
        const d = new Date(a.device_time);
        if (Number.isNaN(d.getTime())) return;
        let key;
        if (viewMode === "day") {
          key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        } else if (viewMode === "week") {
          const day = (d.getDay() + 6) % 7;
          const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
          key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
        } else {
          key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        }
        if (key in counts) counts[key]++;
      } catch (e) {}
    });

    return buckets.map((b) => ({ label: b.label, value: counts[b.key] || 0 }));
  }, [attendance, viewMode]);

  const totalAttendance = attendance.length;
  const pendingPayrolls = payrolls.filter((p) => !p.released).length;
  const notReadyPayrolls = payrolls.filter((p) => !p.released && !isPeriodEndedNow(p.period, settings)).length;
  const readyPayrolls = payrolls.filter((p) => !p.released && isPeriodEndedNow(p.period, settings)).length;

  async function releasePayroll(id, isAdvanceRelease = false) {
    try {
      const { error } = await supabase.from("payroll_periods").update({ released: true }).eq("id", id);
      if (error) throw error;

      setPayrolls((prev) => prev.map((p) => (p.id === id ? { ...p, released: true } : p)));

      try {
        const payroll = (payrolls || []).find((p) => p.id === id) || null;
        const personId = payroll ? payroll.person_id : null;
        const person = personMap[personId] || null;
        const personName = (person && person.name) || null;

        let releasedBy = "admin";
        try {
          const sessionStr = localStorage.getItem("sb-session");
          if (sessionStr) {
            const sess = JSON.parse(sessionStr);
            if (sess && sess.user && sess.user.email) releasedBy = sess.user.email;
          }
        } catch (e) {}

        await supabase.from("payroll_activity_logs").insert([
          {
            payroll_period_id: id,
            person_id: personId,
            person_name: personName,
            released_by: releasedBy,
            action: isAdvanceRelease ? "Advance Release" : "Period Released",
            timestamp: new Date().toISOString(),
          },
        ]);

        try {
          if (settings && settings.auto_create_next_period) {
            const end = parsePeriodEnd(payroll && payroll.period);
            const periodDays = Number(settings.payroll_period_days) || 15;
            if (end && personId) {
              const nextStart = new Date(end.getFullYear(), end.getMonth(), end.getDate());
              nextStart.setDate(nextStart.getDate() + 1);
              const nextEnd = new Date(nextStart);
              nextEnd.setDate(nextStart.getDate() + periodDays - 1);
              const y = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
              const newPeriod = `${y(nextStart)}_to_${y(nextEnd)}`;
              const { data: newRows, error: insErr } = await supabase.from("payroll_periods").insert([{ person_id: personId, period: newPeriod, released: false }]).select();
              if (!insErr && Array.isArray(newRows) && newRows.length) {
                setPayrolls((prev) => [...prev, ...newRows]);
              } else {
                try {
                  const { data: personFull } = await supabase.from('persons').select('daily_rate,late_penalty').eq('id', personId).maybeSingle();
                  const dailyRate = Number(personFull && (personFull.daily_rate || personFull.daily_rate === 0) ? personFull.daily_rate : 0) || 0;
                  const latePenalty = Number(personFull && (personFull.late_penalty || personFull.late_penalty === 0) ? personFull.late_penalty : 0) || 0;
                  const insertObj = {
                    person_id: personId,
                    period: newPeriod,
                    days_present: 0,
                    daily_rate: dailyRate,
                    late_penalty: latePenalty,
                    late_count: 0,
                    gross: 0,
                    total_late_deduction: 0,
                    total_deductions: 0,
                    net: 0,
                    released: false,
                  };
                  const { data: inserted, error: insertErr } = await supabase.from('payroll_periods').insert([insertObj]).select();
                  if (!insertErr && Array.isArray(inserted) && inserted.length) setPayrolls((prev) => [...prev, ...inserted]);
                } catch (e) {
                  console.error('fallback insert next period failed', e);
                }
              }
            }
          }
        } catch (e) { console.error('auto create next period failed', e); }
      } catch (e) { console.error('logging payroll release failed', e); }

      Swal.fire("Released", "Payroll released successfully.", "success");
    } catch (err) {
      console.error(err);
      Swal.fire("Error", err.message || String(err), "error");
    }
  }

  const personMap = useMemo(() => Object.fromEntries((persons || []).map((p) => [p.id, p])), [persons]);

  const todayEntries = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return (attendance || [])
      .map((a) => ({ person_id: a.person_id, device_time: a.device_time, photo: a.photo || null, name: a.name || null, department: a.department || null, event: a.event || null, status: a.status || null, method: a.method || null, point: a.point || null, person: personMap[a.person_id] || null }))
      .filter((a) => {
        try {
          const d = new Date(a.device_time);
          return d >= start && d <= end;
        } catch (e) { return false; }
      })
      .sort((x, y) => new Date(y.device_time) - new Date(x.device_time));
  }, [attendance, personMap]);

  const filteredPayrolls = useMemo(() => {
    const q = (payrollSearch || "").trim().toLowerCase();
    let list = (payrolls || []).filter((p) => !p.released);
    if (q) {
      list = list.filter((p) => {
        const person = personMap[p.person_id] || {};
        const name = (person.name || "").toLowerCase();
        const id = String(p.person_id || "").toLowerCase();
        const period = String(p.period || "").toLowerCase();
        return name.includes(q) || id.includes(q) || period.includes(q);
      });
    }
    const sortFn = (a, b) => {
      if (payrollSort === "name-asc" || payrollSort === "name-desc") {
        const an = (personMap[a.person_id]?.name || "").toLowerCase();
        const bn = (personMap[b.person_id]?.name || "").toLowerCase();
        if (an < bn) return payrollSort === "name-asc" ? -1 : 1;
        if (an > bn) return payrollSort === "name-asc" ? 1 : -1;
        return 0;
      }
      if (payrollSort === "period-asc" || payrollSort === "period-desc") {
        const pa = String(a.period || "");
        const pb = String(b.period || "");
        if (pa < pb) return payrollSort === "period-asc" ? -1 : 1;
        if (pa > pb) return payrollSort === "period-asc" ? 1 : -1;
        return 0;
      }
      return 0;
    };
    list.sort(sortFn);
    if (!payrollShowAll) {
      return list.filter((p) => isPeriodEndedNow(p.period, settings));
    }
    return list;
  }, [payrolls, payrollSearch, payrollSort, personMap, payrollShowAll, settings]);

  const {
    morningPresentNames,
    afternoonPresentNames,
    morningAbsentNames,
    afternoonAbsentNames,
  } = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const parseHHMM = (s, defH = 0, defM = 0) => {
      try {
        if (!s) return defH * 60 + defM;
        const parts = String(s).split(":").map(Number);
        return (parts[0] || 0) * 60 + (parts[1] || 0);
      } catch (e) {
        return defH * 60 + defM;
      }
    };

    const morningStartMin = settings ? parseHHMM(settings.morning_start, 0, 0) : 0;
    const morningEndMin = settings ? parseHHMM(settings.morning_end, 11, 59) : 11 * 60 + 59;
    const afternoonStartMin = settings ? parseHHMM(settings.afternoon_start, 12, 0) : 12 * 60;
    const afternoonEndMin = settings ? parseHHMM(settings.afternoon_end, 17, 0) : 17 * 60;

    const morningPresentIds = new Set();
    const afternoonPresentIds = new Set();

    (attendance || []).forEach((a) => {
      try {
        const d = new Date(a.device_time);
        if (d >= start && d <= end && a.person_id) {
          const minutes = d.getHours() * 60 + d.getMinutes();
          if (minutes >= morningStartMin && minutes <= morningEndMin) morningPresentIds.add(a.person_id);
          if (minutes >= afternoonStartMin && minutes <= afternoonEndMin) afternoonPresentIds.add(a.person_id);
        }
      } catch (e) {}
    });

    const morningPresent = [];
    const afternoonPresent = [];
    const morningAbsent = [];
    const afternoonAbsent = [];

    (persons || []).forEach((p) => {
      const name = (p && (p.name || p.id)) || String(p);
      if (morningPresentIds.has(p.id)) morningPresent.push(name);
      else morningAbsent.push(name);
      if (afternoonPresentIds.has(p.id)) afternoonPresent.push(name);
      else afternoonAbsent.push(name);
    });

    return {
      morningPresentNames: morningPresent,
      afternoonPresentNames: afternoonPresent,
      morningAbsentNames: morningAbsent,
      afternoonAbsentNames: afternoonAbsent,
    };
  }, [attendance, persons, settings]);

  const todayLabel = useMemo(() => {
    try {
      const d = new Date();
      return d.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' });
    } catch (e) { return ''; }
  }, []);

  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [deptFilter, setDeptFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("descending");
  const [todayPage, setTodayPage] = useState(1);
  const todayItemsPerPage = 6;

  useEffect(() => {
    setTodayPage(1);
  }, [searchText, statusFilter, deptFilter, sortOrder]);

  const departments = useMemo(() => {
    const s = new Set();
    (persons || []).forEach((p) => { if (p && p.department) s.add(p.department); });
    return Array.from(s).sort();
  }, [persons]);

  const filteredTodayEntries = useMemo(() => {
    let rows = (todayEntries || []).slice();
    if (searchText && searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      rows = rows.filter((r) => {
        const person = r.person || personMap[r.person_id] || null;
        const name = (person && person.name) || r.name || "";
        const id = r.person_id ? String(r.person_id) : "";
        return name.toLowerCase().includes(q) || id.toLowerCase().includes(q);
      });
    }
    if (statusFilter && statusFilter !== "all") {
      rows = rows.filter((r) => ((r && r.status) || "").toLowerCase() === statusFilter);
    }
    if (deptFilter && deptFilter !== "all") {
      rows = rows.filter((r) => {
        const person = r.person || personMap[r.person_id] || null;
        const dept = (person && person.department) || r.department || "";
        return dept === deptFilter;
      });
    }
    rows.sort((a, b) => {
      const da = new Date(a.device_time).getTime();
      const db = new Date(b.device_time).getTime();
      return sortOrder === "ascending" ? da - db : db - da;
    });
    return rows;
  }, [todayEntries, searchText, statusFilter, deptFilter, sortOrder, personMap]);

  const todayTotalPages = Math.max(1, Math.ceil(filteredTodayEntries.length / todayItemsPerPage));
  const todayStartIndex = (todayPage - 1) * todayItemsPerPage;
  const paginatedTodayEntries = filteredTodayEntries.slice(todayStartIndex, todayStartIndex + todayItemsPerPage);

  function showTooltip(ref, title, items) {
    try { if (tooltipHideTimerRef.current) { clearTimeout(tooltipHideTimerRef.current); tooltipHideTimerRef.current = null; } } catch (e) {}
    let x = 12;
    let y = 12;
    if (ref && ref.current) {
      const r = ref.current.getBoundingClientRect();
      x = Math.max(8, Math.round(r.left + r.width / 2));
      y = Math.min(Math.max(8, Math.round(r.bottom + 8)), window.innerHeight - 40);
      x = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 320));
    }
    setTooltip({ visible: true, x, y, title, items });
  }
  function hideTooltip() { setTooltip({ visible: false, x: 0, y: 0, title: "", items: [] }); }

  function scheduleHideTooltip(delay = 200) {
    try { if (tooltipHideTimerRef.current) clearTimeout(tooltipHideTimerRef.current); } catch (e) {}
    tooltipHideTimerRef.current = setTimeout(() => {
      tooltipHideTimerRef.current = null;
      hideTooltip();
    }, delay);
  }

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

  function getWorkHoursLabel(row) {
    if (!settings) return "-";
    try {
      let label = "";
      let configTime = "";
      if (row.event === "time-in") {
        label = "Morning In";
        configTime = settings.morning_start;
        if (settings.morning_end && settings.afternoon_start) {
          const d = new Date(row.device_time);
          const minutes = d.getHours() * 60 + d.getMinutes();
          const morningEnd = settings.morning_end.split(":").map(Number);
          const morningEndMin = morningEnd[0] * 60 + morningEnd[1];
          const morningGrace = Number(settings.morning_grace_minutes) || 0;
          if (minutes > morningEndMin + morningGrace) {
            label = "Afternoon In";
            configTime = settings.afternoon_start;
          }
        }
      } else if (row.event === "time-out") {
        label = "Morning Out";
        configTime = settings.morning_end;
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
        return "-";
      }
      return label && configTime ? `${label}: ${configTime}` : "-";
    } catch (e) {
      return "-";
    }
  }

  // SVG line chart
  const LineChart = ({ data = [] }) => {
    const svgRef = useRef(null);
    const [tooltip, setTooltip] = useState({ visible: false, x: 0, y: 0, label: "", value: 0 });

    const w = 900;
    const h = 280;
    const padding = { l: 48, r: 18, t: 16, b: 56 };
    const innerW = w - padding.l - padding.r;
    const innerH = h - padding.t - padding.b;
    const values = data.map((d) => d.value);
    const max = Math.max(...values, 1);
    const xStep = innerW / Math.max(1, data.length - 1);
    const points = data.map((d, i) => {
      const x = padding.l + i * xStep;
      const y = padding.t + innerH - (d.value / max) * innerH;
      return { x, y, label: d.label, value: d.value };
    });

    function catmullRom2bezier(pts) {
      if (!pts || pts.length === 0) return "";
      if (pts.length === 1) return `M ${pts[0].x},${pts[0].y}`;
      let d = "M " + pts[0].x + "," + pts[0].y + " ";
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = i === 0 ? pts[0] : pts[i - 1];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = i + 2 < pts.length ? pts[i + 2] : p2;
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        d += `C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y} `;
      }
      return d;
    }

    const path = catmullRom2bezier(points);
    const areaPath = `${path} L ${padding.l + innerW},${padding.t + innerH} L ${padding.l},${padding.t + innerH} Z`;
    const altPoints = points.map((p) => ({ x: p.x, y: Math.min(p.y + 12, padding.t + innerH) }));
    const altPath = catmullRom2bezier(altPoints);

    const handleMove = (e) => {
      if (!svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      let idx = 0;
      let minD = Infinity;
      points.forEach((p, i) => {
        const d = Math.abs(p.x - x);
        if (d < minD) { minD = d; idx = i; }
      });
      const p = points[idx];
      setTooltip({ visible: true, x: rect.left + p.x, y: rect.top + p.y - 10, label: p.label, value: p.value });
    };
    const handleLeave = () => setTooltip((t) => ({ ...t, visible: false }));

    const gridLines = [0, 1, 2, 3, 4].map((i) => {
      const y = padding.t + (innerH * i) / 4;
      const val = Math.round(max * (1 - i / 4));
      return { y, val };
    });

    return (
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${w} ${h}`}
          className="w-full h-[280px]"
          preserveAspectRatio="xMidYMid meet"
          onMouseMove={handleMove}
          onMouseLeave={handleLeave}
        >
          <defs>
            <linearGradient id="g1" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#9E9E9E" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#9E9E9E" stopOpacity="0.02" />
            </linearGradient>
            <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#9E9E9E" floodOpacity="0.08" />
            </filter>
          </defs>

          {gridLines.map((g, i) => (
            <g key={i}>
              <line x1={padding.l} x2={padding.l + innerW} y1={g.y} y2={g.y} stroke="#eef2f6" strokeWidth={1} />
              <text x={8} y={g.y + 5} fontSize={11} fill="#9ca3af">{g.val}</text>
            </g>
          ))}

          <path d={areaPath} fill="url(#g1)" stroke="none" />
          <path d={altPath} fill="none" stroke="#9E9E9E" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.15} />
          <path d={path} fill="none" stroke="#9E9E9E" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" style={{ filter: `url(#shadow)` }} />

          {points.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={6} fill="#237227" stroke="#ffffff" strokeWidth={1.2} />
              <text x={p.x} y={p.y - 10} textAnchor="middle" fontSize={12} fill="#0f172a">{p.value}</text>
            </g>
          ))}

          {points.map((p, i) => (
            <text key={i} x={p.x} y={padding.t + innerH + 26} textAnchor="middle" fontSize={11} fill="#6b7280">
              {p.label.split(" ")[0]}
            </text>
          ))}
        </svg>

        {tooltip.visible && (
          <div
            className="fixed z-[9999] pointer-events-none bg-[rgba(2,6,23,0.9)] text-white px-2 py-1.5 rounded-md text-xs"
            style={{ left: tooltip.x + 8, top: tooltip.y - 28 }}
          >
            <div className="font-bold">{tooltip.value}</div>
            <div className="text-[11px]">{tooltip.label}</div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="p-6 font-sans dashboard-root">
      <style>{`
        .dashboard-root button,
        .dashboard-root button:hover,
        .dashboard-root button:hover:not(:disabled),
        .dashboard-root button:focus,
        .dashboard-root button:active,
        .dashboard-root input,
        .dashboard-root input:focus,
        .dashboard-root select,
        .dashboard-root select:focus,
        .dashboard-root *:focus,
        .dashboard-root div,
        .dashboard-root a {
          transform: none !important;
          outline: none !important;
          box-shadow: none !important;
        }
        .dashboard-root input:focus,
        .dashboard-root select:focus {
          border-color: #e6eef6 !important;
          outline: none !important;
          box-shadow: none !important;
        }
        .dashboard-root button:focus,
        .dashboard-root button:focus-visible {
          outline: none !important;
          box-shadow: none !important;
        }
      `}</style>
      <h2 className="m-0 font-bold text-[#000000]">Dashboard</h2>
      <p className="text-gray-500 mt-1.5">Overview of attendance and payroll</p>

      {/* Stats Grid */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4 mb-5">
        {/* Total Employees */}
        <div className="bg-white rounded-xl p-[18px] shadow-[0_8px_24px_rgba(16,185,129,0.06)] border border-[#e6f4ef] flex items-center gap-3">
          <div className="w-12 h-12 rounded-full flex-shrink-0 aspect-square flex items-center justify-center bg-[#237227] text-emerald-600">
            <FiUsers size={20}  color="#ffffff"/>
          </div>
          <div>
            <div className="text-sm text-[#9E9E9E]">Total Employees</div>
            <div className="text-base font-bold text-[#9E9E9E]">{compactNumber(totalEmployees)}</div>
          </div>
        </div>

        {/* Total Attendance */}
        <div className="bg-white rounded-xl p-[18px] shadow-[0_8px_24px_rgba(16,185,129,0.06)] border border-[#e6f4ef] flex items-center gap-3">
          <div className="w-12 h-12 rounded-full flex-shrink-0 aspect-square flex items-center justify-center bg-[#237227] text-emerald-600">
            <FiClock size={20}  color="#ffffff"/>
          </div>
          <div>
            <div className="text-sm text-[#9E9E9E]">Total Attendance (all time)</div>
            <div className="text-base font-bold text-[#9E9E9E]">{compactNumber(totalAttendance)}</div>
          </div>
        </div>

        {/* Pending Payrolls */}
        <div className="bg-white rounded-xl p-[18px] shadow-[0_8px_24px_rgba(16,185,129,0.06)] border border-[#e6f4ef] flex items-center gap-3">
          <div className="w-12 h-12 rounded-full flex-shrink-0 aspect-square flex items-center justify-center bg-[#237227] text-emerald-600">
            <FiTrendingUp size={20}  color="#ffffff"/>
          </div>
          <div>
            <div className="text-sm text-[#9E9E9E]">Pending Payrolls</div>
            <div className="text-base font-bold text-[#9E9E9E]">{compactNumber(pendingPayrolls)}</div>
          </div>
        </div>

        {/* Present Today */}
        <div
          ref={presentCardRef}
          className="bg-white rounded-xl p-4  border border-[#e6f4ef] flex items-center gap-3 cursor-default"
          onMouseEnter={() => showTooltip(
            presentCardRef,
            'Present Today',
            [
              <div className="text-sm font-bold text-[#6d6d6d]">{`Morning (${morningPresentNames.length})`}</div>,
              ...(morningPresentNames.length ? morningPresentNames : ['None']),
              '',
              <div className="text-sm font-bold text-[#6d6d6d]">{`Afternoon (${afternoonPresentNames.length})`}</div>,
              ...(afternoonPresentNames.length ? afternoonPresentNames : ['None']),
            ]
          )}
          onMouseLeave={() => scheduleHideTooltip()}
        >
          <div className="w-12 h-12 rounded-full flex-shrink-0 aspect-square flex items-center justify-center bg-[#237227] text-emerald-600">
            <FiUsers size={20}  color="#ffffff"/>
          </div>
          <div>
            <div className="text-sm text-[#9E9E9E]">Present Today</div>
            <div className="text-base font-bold text-[#9E9E9E]">{`Morning Shift : ${compactNumber(morningPresentNames.length)} Afternoon Shift: ${compactNumber(afternoonPresentNames.length)}`}</div>
          </div>
        </div>

        {/* Absent Today */}
        <div
          ref={absentCardRef}
          className="bg-white rounded-xl p-4 border border-[#e6f4ef] flex items-center gap-3 cursor-default"
          onMouseEnter={() => showTooltip(
            absentCardRef,
            'Absent Today',
            [
              <div className="text-sm font-bold text-[#6d6d6d]">{`Morning Absent (${morningAbsentNames.length})`}</div>,
              ...(morningAbsentNames.length ? morningAbsentNames : ['None']),
              '',
              <div className="text-sm font-bold text-[#6d6d6d]">{`Afternoon Absent (${afternoonAbsentNames.length})`}</div>,
              ...(afternoonAbsentNames.length ? afternoonAbsentNames : ['None']),
            ]
          )}
          onMouseLeave={() => scheduleHideTooltip()}
        >
          <div className="w-12 h-12 rounded-full flex-shrink-0 aspect-square flex items-center justify-center bg-[#237227] text-emerald-600">
            <FiClock size={20}  color="#ffffff"/>
          </div>
          <div>
            <div className="text-sm text-[#9E9E9E]">Absent Today</div>
            <div className="text-base font-bold text-[#9E9E9E]">{`Morning Shift : ${compactNumber(Math.max(0, morningAbsentNames.length))} Afternoon Shift: ${compactNumber(Math.max(0, afternoonAbsentNames.length))}`}</div>
          </div>
        </div>
      </div>

      {/* Chart + Payroll grid */}
      <div className="grid grid-cols-[2fr_1fr] gap-4 items-start">
        {/* Chart Card */}
        <div className="bg-white rounded-xl p-6 shadow-[0_8px_24px_rgba(2,132,199,0.04)] border border-[#e6f0f7]">
          <div className="flex justify-between items-center mb-2.5">
            <div>
              <div className="text-sm text-gray-700">
                {`Attendances (${viewMode === "day" ? "last 30 days" : viewMode === "week" ? "last 12 weeks" : "12 months"})`}
              </div>
              <div className="text-xs text-gray-500">
                {viewMode === "day" ? "Daily total of attendance scans" : viewMode === "week" ? "Weekly total of attendance scans" : "Monthly total of attendance scans"}
              </div>
            </div>
            <div className="flex gap-2">
              {["day", "week", "month"].map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs cursor-pointer border transition-colors ${
                    viewMode === mode
                      ? "border-[#237227] bg-[#237227] text-white"
                      : "border-[#e6eef6] bg-white text-gray-500 "
                  }`}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <LineChart data={chartData} />
        </div>

        {/* Payroll Card */}
        <div className="bg-white rounded-xl p-[18px]  border border-[#eef2f6]">
          <div className="flex justify-between items-center mb-2">
            <h5 className="m-0 text-[#9E9E9E]">Payrolls Pending Release</h5>
            <div className="flex items-center gap-2">
              <input
                placeholder="Search name.."
                value={payrollSearch}
                onChange={(e) => setPayrollSearch(e.target.value)}
                className="px-2.5 py-2 rounded-lg border border-[#237227] outline-none min-w-[110px] text-sm"
                style={{ border: "1px solid #e6eef6", outline: "none", boxShadow: "none" }}
              />
              <button
                onClick={() => setPayrollShowAll((s) => !s)}
                className="px-2.5 py-2 rounded-lg bg-[#237227] text-[#ffffff] cursor-pointer text-sm"
                title="Toggle show all pending payrolls"
              >
                {payrollShowAll ? 'All' : 'Today'}
              </button>
              {readyPayrolls > 0 && (
                <div title={`${readyPayrolls} payroll(s) ready to release`} className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  <div className="text-xs text-gray-500">{readyPayrolls} ready</div>
                </div>
              )}
              {notReadyPayrolls > 0 && (
                <div title={`${notReadyPayrolls} payroll(s) pending but not yet ended`} className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                  <div className="text-xs text-gray-500">{notReadyPayrolls} not ready</div>
                </div>
              )}
            </div>
          </div>

          <div className="mt-2 grid gap-2 max-h-[300px] overflow-y-auto pr-2">
            {(filteredPayrolls || []).map((p) => {
              const ready = isPeriodEndedNow(p.period, settings);
              const person = personMap[p.person_id] || null;
              const name = (person && (person.name || person.id)) || p.person_id || 'Unknown';
              return (
                <div key={p.id} className="flex justify-between items-center p-2.5 rounded-lg bg-[#f8fafc] border border-[#eef2f6]">
                  <div className="text-slate-900" title={name}>
                    <div className="font-bold">{name}</div>
                    <div className="text-[13px] text-slate-700">
                      {formatPeriod(p.period)}
                      {!ready && <span className="ml-2 text-gray-400 text-xs">(ready after work-hours)</span>}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => releasePayroll(p.id, false)}
                      disabled={!ready}
                      className={`px-3 py-1.5 rounded-lg border-none text-sm ${ready ? "bg-[#237227] text-white cursor-pointer" : "bg-[#e6eef6] text-gray-400 cursor-not-allowed"}`}
                    >
                      {ready ? 'Release' : 'Release (disabled)'}
                    </button>
                    {payrollShowAll && (
                      <button
                        onClick={async () => {
                          const res = await Swal.fire({ title: 'Advance Release payroll?', text: `This will mark payroll for ${name} as released immediately (admin override). Continue?`, icon: 'warning', showCancelButton: true, confirmButtonText: 'Advance Release' });
                          if (res && res.isConfirmed) {
                            try { await releasePayroll(p.id, true); } catch (e) {}
                          }
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-white text-gray-700 border border-[#e6eef6] cursor-pointer text-sm"
                      >
                        Advance Release
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {(filteredPayrolls || []).length === 0 && (
              <div className="text-gray-500 text-sm">No pending payrolls ready for release</div>
            )}
          </div>
        </div>
      </div>

      {/* Today's Attendance Table */}
      <div className="mt-4 bg-white rounded-xl p-3 border border-[#eef2f6]">
        <div className="flex justify-between items-center px-3 py-2 border-b border-[#f1f5f9]">
          <div className="text-sm font-bold text-[#000000]">Today's Attendance</div>
          <div className="text-right">
            <div className="text-[13px] text-gray-500">{filteredTodayEntries.length} records</div>
            <div className="text-xs text-gray-400">{todayLabel}</div>
          </div>
        </div>

        {/* Toolbar */}
        <div className="mt-3 mb-3 flex gap-3 items-center px-3 py-2.5 border border-[#eef2f6] rounded-xl bg-white">
          <input
            placeholder="Search name or ID"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="flex-1 px-3 py-2.5 rounded-lg border border-[#e6eef6] outline-none text-sm"
            style={{ border: "1px solid #e6eef6", outline: "none", boxShadow: "none" }}
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2.5 py-2 rounded-lg border border-[#e6eef6] bg-white text-sm"
          >
            <option value="all">All Status</option>
            <option value="on-time">On-time</option>
            <option value="late">Late</option>
            <option value="present">Present</option>
          </select>
          <select
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
            className="px-2.5 py-2 rounded-lg border border-[#e6eef6] bg-white text-sm"
          >
            <option value="all">All Departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button
            aria-label="Toggle sort order"
            onClick={() => setSortOrder((s) => (s === "ascending" ? "descending" : "ascending"))}
            className="px-4 py-2 rounded-lg text-[#ffffff] bg-[#237227] border border-[#e6eef6] text-[0.95rem] cursor-pointer shadow-sm min-w-[72px] text-center font-semibold transition-colors"
          >
            {sortOrder === "ascending" ? "Asc" : "Desc"}
          </button>
          <button
            onClick={() => {
              try {
                const rows = filteredTodayEntries || [];
                const header = ['person_id', 'name', 'department', 'device_time', 'event', 'status'];
                const csv = [header.join(',')].concat(rows.map(r => {
                  const person = r.person || personMap[r.person_id] || {};
                  const name = (person && person.name) || r.name || '';
                  const dept = (person && person.department) || r.department || '';
                  return [r.person_id, `"${name.replace(/"/g, '""')}"`, `"${dept.replace(/"/g, '""')}"`, r.device_time, r.event || '', r.status || ''].join(',');
                })).join('\n');
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `today_attendance_${new Date().toISOString().slice(0, 10)}.csv`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              } catch (e) { console.error(e); }
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border-none bg-[#237227] text-white text-sm cursor-pointer transition-colors"
          >
            <FiDownload color="#ffffff" />
            Export Excel
          </button>
        </div>

        {/* Table Container */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px] text-left">
            <thead className="sticky top-0 bg-white z-10">
              <tr className="text-gray-500 border-b border-gray-200 text-[12px] font-semibold tracking-wider uppercase">
                <th className="py-3 px-3">Photo / Attendance Time</th>
                <th className="py-3 px-3">Employee ID</th>
                <th className="py-3 px-3">Employee Name</th>
                <th className="py-3 px-3">Department / Work Hours</th>
                <th className="py-3 px-3">Location</th>
                <th className="py-3 px-3">Attendance Status</th>
                <th className="py-3 px-3">Attendance Method</th>
              </tr>
            </thead>
            <tbody>
              {filteredTodayEntries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-gray-500">
                    No attendance recorded today
                  </td>
                </tr>
              ) : (
                paginatedTodayEntries.map((r, i) => {
                  const person = r.person || personMap[r.person_id] || (persons || []).find((p) => String(p.name) === String(r.person_id)) || null;
                  const name = (person && person.name) || r.name || `Person #${r.person_id}`;
                  let timeLabel = "";
                  try { timeLabel = new Date(r.device_time).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" }) + " - " + new Date(r.device_time).toLocaleTimeString("en-US"); } catch (e) {}
                  let status = (r && r.status) || "";
                  if (!status) {
                    try {
                      const d = new Date(r.device_time);
                      if (!Number.isNaN(d.getTime())) {
                        const hhmm = d.toTimeString().slice(0, 5);
                        const event = (r && r.event) || "time-in";
                        status = determineAttendanceStatus(hhmm, event, settings || {}, false);
                      } else {
                        status = "present";
                      }
                    } catch (e) {
                      status = "present";
                    }
                  }

                  const normStatus = String(status || "").toLowerCase().trim();
                  let badgeStyle = "bg-gray-100 text-gray-700 border-gray-200";
                  if (normStatus === "on-time" || normStatus === "ontime" || normStatus === "present") {
                    badgeStyle = "bg-[#237227]/10 text-[#237227] border border-[#237227]/30";
                  } else if (normStatus === "late") {
                    badgeStyle = "bg-red-50 text-red-600 border border-red-200";
                  } else if (normStatus === "overtime") {
                    badgeStyle = "bg-blue-50 text-blue-600 border border-blue-200";
                  }

                  return (
                    <tr key={i} className="border-b border-gray-100">
                      {/* Photo / Attendance Time */}
                      <td className="py-3 px-3">
                        <div className="flex gap-3 items-center">
                          <div className="w-12 h-12 rounded-full overflow-hidden bg-[#237227] flex items-center justify-center text-[#ffffff] font-bold flex-shrink-0">
                            {r.photo ? (
                              <img src={r.photo} alt={name || ''} className="w-full h-full object-cover cursor-pointer" onClick={() => openPhotoModal(r.photo, name)} />
                            ) : person && person.registration_photo ? (
                              <img src={person.registration_photo} alt={(person && person.name) || ''} className="w-full h-full object-cover cursor-pointer" onClick={() => openPhotoModal(person.registration_photo, (person && person.name) || '')} />
                            ) : (
                              ((person && person.name) ? person.name.slice(0, 2).toUpperCase() : String(r.person_id).slice(0, 2))
                            )}
                          </div>
                          <div>
                            <div className="text-slate-900 font-bold text-sm">{timeLabel}</div>
                            <div className="text-xs text-gray-400 mt-1">{new Date(r.device_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
                          </div>
                        </div>
                      </td>

                      {/* Employee ID */}
                      <td className="py-3 px-3 text-[13px] text-slate-900 font-bold font-mono">
                        {person && person.id ? person.id : (r.person_id || '-')}
                      </td>

                      {/* Employee Name */}
                      <td className="py-3 px-3 text-[13px] text-slate-900 font-semibold">
                        {name}
                      </td>

                      {/* Department / Work Hours */}
                      <td className="py-3 px-3">
                        <div className="text-slate-900 font-medium">{(person && person.department) || r.department || "-"}</div>
                        <div className="text-xs text-gray-400 mt-1">{getWorkHoursLabel(r)}</div>
                      </td>

                      {/* Location */}
                      <td className="py-3 px-3 text-xs text-slate-900 break-words max-w-[220px]">
                        {r.point ? r.point : <span className="text-gray-400">—</span>}
                      </td>

                      {/* Attendance Status */}
                      <td className="py-3 px-3">
                        <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${badgeStyle}`}>
                          {status || "—"}
                        </span>
                      </td>

                      {/* Attendance Method */}
                      <td className="py-3 px-3 text-gray-500">
                        {r.method || 'face-scan'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        {filteredTodayEntries.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 bg-gray-50 border-t border-gray-200">
            {/* Left: Record Count Info */}
            <div className="text-xs text-gray-600">
              Showing <span className="font-semibold text-gray-800">{todayStartIndex + 1}</span> to{" "}
              <span className="font-semibold text-gray-800">
                {Math.min(todayStartIndex + todayItemsPerPage, filteredTodayEntries.length)}
              </span>{" "}
              of <span className="font-semibold text-gray-800">{filteredTodayEntries.length}</span> records
            </div>

            {/* Right: Page Navigation with Chevron Icons */}
            <div className="flex items-center gap-1.5">
              {/* Previous Page Button */}
              <button
                type="button"
                onClick={() => setTodayPage((prev) => Math.max(prev - 1, 1))}
                disabled={todayPage === 1}
                className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-gray-300 bg-white text-gray-700 text-xs font-medium outline-none focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                title="Previous Page"
              >
                <FiChevronLeft className="text-sm" />
              </button>

              {/* Page Number Buttons */}
              {Array.from({ length: todayTotalPages }, (_, i) => i + 1)
                .filter((pageNum) => {
                  if (todayTotalPages <= 7) return true;
                  if (pageNum === 1 || pageNum === todayTotalPages) return true;
                  if (Math.abs(pageNum - todayPage) <= 1) return true;
                  return false;
                })
                .map((pageNum, idx, arr) => {
                  const prevPage = arr[idx - 1];
                  const showEllipsis = prevPage && pageNum - prevPage > 1;

                  return (
                    <Fragment key={pageNum}>
                      {showEllipsis && (
                        <span className="px-1 text-gray-400 select-none text-xs">...</span>
                      )}
                      <button
                        type="button"
                        onClick={() => setTodayPage(pageNum)}
                        className={`inline-flex items-center justify-center min-w-[32px] h-8 px-2 rounded-lg text-xs font-semibold outline-none focus:outline-none ${
                          todayPage === pageNum
                            ? "bg-[#237227] text-white"
                            : "border border-gray-300 bg-white text-gray-700"
                        }`}
                      >
                        {pageNum}
                      </button>
                    </Fragment>
                  );
                })}

              {/* Next Page Button */}
              <button
                type="button"
                onClick={() => setTodayPage((prev) => Math.min(prev + 1, todayTotalPages))}
                disabled={todayPage === todayTotalPages || todayTotalPages === 0}
                className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-gray-300 bg-white text-gray-700 text-xs font-medium outline-none focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                title="Next Page"
              >
                <FiChevronRight className="text-sm" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Photo Modal */}
      {photoModal.visible && (
        <div
          onClick={() => closePhotoModal()}
          className="fixed inset-0 bg-black/60 z-[10000] flex items-center justify-center p-5"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-w-[90%] max-h-[90%] rounded-lg overflow-hidden bg-white p-3 shadow-md"
          >
            <div className="flex justify-end">
              <button
                onClick={() => closePhotoModal()}
                aria-label="Close photo"
                className="bg-transparent border-none text-slate-900 text-[22px] cursor-pointer leading-none"
              >
                ×
              </button>
            </div>
            <div className="text-center">
              <img src={photoModal.src} alt={photoModal.title} className="max-w-full max-h-[80vh] block mx-auto" />
              {photoModal.title && <div className="mt-2 text-slate-900">{photoModal.title}</div>}
            </div>
          </div>
        </div>
      )}

      {/* Present/Absent Tooltip */}
      {tooltip.visible && (
        <div
          onMouseEnter={() => { try { if (tooltipHideTimerRef.current) { clearTimeout(tooltipHideTimerRef.current); tooltipHideTimerRef.current = null; } } catch (e) {} setTooltip(t => ({ ...t, visible: true })); }}
          onMouseLeave={() => scheduleHideTooltip()}
          className="fixed bg-white border border-[#e6eef6] rounded-lg p-3 shadow-md z-[9999] max-w-[300px]"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-bold text-[#237227] mb-2">{tooltip.title}</div>
          <div className="max-h-[220px] overflow-auto text-[13px] text-gray-700">
            {(tooltip.items && tooltip.items.length)
              ? tooltip.items.map((n, i) => (
                <div key={i} className={`py-1 ${i < tooltip.items.length - 1 ? "border-b border-[#f1f5f9]" : ""}`}>{n}</div>
              ))
              : <div className="text-gray-400">None</div>
            }
          </div>
        </div>
      )}
    </div>
  );
}
