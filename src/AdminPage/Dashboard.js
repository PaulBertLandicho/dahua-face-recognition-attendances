import React, { useEffect, useState, useRef, useMemo } from "react";
import { supabase } from "../supabaseClient";
import Swal from "sweetalert2";
import { FiTrendingUp, FiUsers, FiClock, FiDownload, FiChevronLeft, FiChevronRight } from "react-icons/fi";
import { getAttendanceStatus } from "./attendanceUtils";

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
    // get start of week (Monday)
    const day = (d.getDay() + 6) % 7;
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    const label = start.toLocaleString("en-US", { month: "short", day: "numeric" });
    res.push({ key, label });
  }
  return res;
}

// Try to extract an end date from a period string. Returns Date or null.
function parsePeriodEnd(period) {
  if (!period) return null;
  const s = String(period).trim();
  // ISO-like YYYY-MM-DD or YYYY/MM/DD: pick the last occurrence if there are multiple (range)
  let matches = Array.from(s.matchAll(/(\d{4}[-/]\d{2}[-/]\d{2})/g)).map((m) => m[1]);
  if (matches.length) return new Date(matches[matches.length - 1].replace(/\//g, "-"));

  // dd/mm/yyyy or dd-mm-yyyy: pick last occurrence
  matches = Array.from(s.matchAll(/(\d{2}[-/.]\d{2}[-/.]\d{4})/g)).map((m) => m[1]);
  if (matches.length) {
    const parts = matches[matches.length - 1].split(/[-/.]/);
    return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
  }

  // If it's a range like '2026-03-01 - 2026-03-31' or 'Mar 1, 2026 - Mar 31, 2026'
  if (s.includes("-")) {
    const parts = s.split(/[-–—]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      const parsed = parsePeriodEnd(last);
      if (parsed) return parsed;
    }
  }

  // If it contains 'to'
  if (/\bto\b/i.test(s)) {
    const parts = s.split(/to/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const parsed = parsePeriodEnd(parts[parts.length - 1]);
      if (parsed) return parsed;
    }
  }

  // Month Year like 'Apr 2026' -> assume end of month
  const my = s.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}/i);
  if (my) {
    const dt = new Date('1 ' + my[0]);
    if (!Number.isNaN(dt.getTime())) {
      // end of that month
      return new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
    }
  }

  // Fallback: try native parse
  const fallback = new Date(s);
  if (!Number.isNaN(fallback.getTime())) return fallback;
  return null;
}

function isPeriodEnded(period) {
  const end = parsePeriodEnd(period);
  if (!end) return false;
  const today = new Date();
  // consider period ended if end date is before or equal to today (end of day)
  const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
  return endOfDay <= today;
}

// Variant: consider period ended relative to work-hours settings.
// If the period end is today, treat the period as ended only after the configured
// afternoon end time (settings.afternoon_end). Otherwise fall back to end-of-day.
function isPeriodEndedNow(period, settings) {
  const end = parsePeriodEnd(period);
  if (!end) return false;
  const now = new Date();
  // If the period end is today (same date), compare to afternoon end time if available
  if (
    end.getFullYear() === now.getFullYear() &&
    end.getMonth() === now.getMonth() &&
    end.getDate() === now.getDate()
  ) {
    // parse afternoon_end from settings (HH:MM)
    try {
      const hhmm = (settings && settings.afternoon_end) || null;
      if (hhmm) {
        const parts = String(hhmm).split(":").map(Number);
        const h = Number.isFinite(parts[0]) ? parts[0] : 17;
        const m = Number.isFinite(parts[1]) ? parts[1] : 0;
        const endOfPeriod = new Date(end.getFullYear(), end.getMonth(), end.getDate(), h, m, 0, 0);
        return now >= endOfPeriod;
      }
    } catch (e) {
      // fallback to end of day
    }
    const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
    return now >= endOfDay;
  }
  // For non-today end dates, use end-of-day comparison
  const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
  return endOfDay <= now;
}

// Format a period string like '2026-04-07_to_2026-04-21' into
// 'April 07, 2026 to April 21, 2026'. Falls back to original string.
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
    // Try single date parse
    const single = s.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
    if (single) {
      const d = new Date(single[1].replace(/\//g, '-'));
      if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' });
    }
    // As a last resort, try native parse on the whole string
    const p = new Date(s);
    if (!Number.isNaN(p.getTime())) return p.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' });
  } catch (e) {}
  return String(period);
}

// Dashboard presentation styles (module-level so LineChart can access them)
const styles = {
  container: { padding: "32px 24px", maxWidth: 1600, margin: "0 auto", fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', background: "#ffffff", color: "#1f2937" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 16, marginBottom: 24 },
  card: { background: "#ffffff", borderRadius: 12, padding: 18, boxShadow: "0 8px 20px rgba(16,185,129,0.05)", border: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 12, minWidth: 0 },
  iconWrap: { width: 48, height: 48, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: "#237227", color: "#ffffff" },
  title: { fontSize: 14, color: "#6b7280" },
  value: { fontSize: 16, fontWeight: 700, color: "#1f2937", overflowWrap: "anywhere" },
  values: { fontSize: 13, fontWeight: 700, color: "#6d6d6d" },

  chartGrid: { display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(320px,1fr)", gap: 20, alignItems: "start" },
  chartCard: { background: "#ffffff", borderRadius: 12, padding: 24, boxShadow: "0 8px 20px rgba(16,185,129,0.05)", border: "1px solid #e5e7eb", minWidth: 0 },
  payrollCard: { background: "#ffffff", borderRadius: 12, padding: 20, boxShadow: "0 8px 20px rgba(16,185,129,0.05)", border: "1px solid #e5e7eb", minWidth: 0 },
  chartSvg: { width: "100%", height: 280 },
  payrollList: { marginTop: 12, display: "grid", gap: 12, maxHeight: 300, overflowY: 'auto', paddingRight: 8 },
  attendanceCard: { marginTop: 16, background: "#ffffff", borderRadius: 14, padding: 12, border: "1px solid #e5e7eb", boxShadow: "0 8px 20px rgba(16,185,129,0.05)", minWidth: 0 },
  attendanceHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 14px", borderBottom: "1px solid #f1f5f9" },
  attendanceToolbar: { marginTop: 12, marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", padding: "12px 14px", border: "1px solid #e5e7eb", borderRadius: 14, background: "#ffffff" },
  attendanceInput: { flex: "1 1 220px", minWidth: 180, padding: "10px 14px", borderRadius: 40, border: "1px solid #d1d5db", outline: "none", background: "#ffffff", color: "#1f2937" },
  attendanceSelect: { padding: "10px 14px", borderRadius: 40, border: "1px solid #d1d5db", background: "#ffffff", color: "#1f2937", outline: "none", cursor: "pointer" },
  attendanceExport: { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 40, border: "none", background: "#237227", color: "#ffffff", cursor: "pointer", fontWeight: 600, boxShadow: "0 2px 8px rgba(0,0,0,0.05)" },
  attendanceTable: { width: "100%", minWidth: 1120, borderCollapse: "collapse", fontSize: 13, textAlign: "left" },
  attendanceHeading: { padding: "14px 12px", background: "#ffffff", color: "#64748b", borderBottom: "1px solid #dbe3ea", fontWeight: 700, letterSpacing: "0.03em", textTransform: "uppercase", fontSize: 12 },
  attendanceRow: { borderBottom: "1px solid #e5e7eb", minWidth: 1120 },
  attendanceCell: { padding: "14px 12px", color: "#1f2937", verticalAlign: "middle" },
  attendanceStatus: { display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "4px 12px", borderRadius: 999, background: "#fff1f2", border: "1px solid #fecdd3", color: "#ef4444", fontWeight: 500, fontSize: 12 },
  attendancePhoto: { width: 48, height: 48, borderRadius: 12, overflow: "hidden", background: "#237227", display: "flex", alignItems: "center", justifyContent: "center", color: "#ffffff", fontWeight: 700, flexShrink: 0, border: "2px solid #e5e7eb" },
  sortToggle: {
    padding: "8px 16px",
    borderRadius: 22,
    background: "#f3f4f6",
    border: "1px solid #e6eef6",
    color: "#374151",
    fontSize: "0.95rem",
    cursor: "pointer",
    boxShadow: "0 2px 6px rgba(16,24,40,0.06)",
    minWidth: "72px",
    textAlign: "center",
    fontWeight: 600,
  },
};

// SVG line chart component — defined at module level so React keeps a stable
// component reference across Dashboard renders and can access module-level styles.
function LineChart({ data = [] }) {
  const svgRef = React.useRef(null);
  const [chartTooltip, setChartTooltip] = React.useState({ visible: false, x: 0, y: 0, label: "", value: 0 });

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
    setChartTooltip({ visible: true, x: rect.left + p.x, y: rect.top + p.y - 10, label: p.label, value: p.value });
  };
  const handleLeave = () => setChartTooltip((t) => ({ ...t, visible: false }));

  const gridLines = [0, 1, 2, 3, 4].map((i) => {
    const y = padding.t + (innerH * i) / 4;
    const val = Math.round(max * (1 - i / 4));
    return { y, val };
  });

  return (
    <div style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${h}`}
        style={styles.chartSvg}
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        <defs>
          <linearGradient id="g1" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#237227" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#237227" stopOpacity="0.02" />
          </linearGradient>
          <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#237227" floodOpacity="0.08" />
          </filter>
        </defs>
        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={padding.l} x2={padding.l + innerW} y1={g.y} y2={g.y} stroke="#eef2f6" strokeWidth={1} />
            <text x={8} y={g.y + 5} fontSize={11} fill="#9ca3af">{g.val}</text>
          </g>
        ))}
        <path d={areaPath} fill="url(#g1)" stroke="none" />
        <path d={altPath} fill="none" stroke="#86a987" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.35} />
        <path d={path} fill="none" stroke="#237227" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" style={{ filter: `url(#shadow)` }} />
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
      {chartTooltip.visible && (
        <div style={{ position: "fixed", left: chartTooltip.x + 8, top: chartTooltip.y - 28, background: "rgba(2,6,23,0.9)", color: "#fff", padding: "6px 8px", borderRadius: 6, fontSize: 12, pointerEvents: "none", zIndex: 9999 }}>
          <div style={{ fontWeight: 700 }}>{chartTooltip.value}</div>
          <div style={{ fontSize: 11 }}>{chartTooltip.label}</div>
        </div>
      )}
    </div>
  );
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
          supabase.from("attendance").select("device_time,person_id,photo,name,department,event,status,method,point,archived"),
          // persons table has `name` (single column) rather than first_name/last_name
          supabase.from("persons").select("id,name,department,registration_photo", { count: 'exact' }),
          supabase.from("payroll_periods").select("id,person_id,period,released"),
          supabase.from("settings").select("*").eq("id", 1).maybeSingle(),
        ]);

        if (!mounted) return;
        const dedupedAttendance = Array.from(
          new Map(
            (attRes.data || [])
              .filter((record) => record.person_id && !record.archived)
              .map((record) => {
                const normalizedTime = record.device_time
                  ? new Date(record.device_time).toISOString()
                  : "";
                return [`${record.person_id}|${record.event || ""}|${normalizedTime}`, record];
              })
          ).values()
        ).map((record) => ({
          ...record,
          status: getAttendanceStatus(record, settingsRes.data || {}),
        }));
        setAttendance(dedupedAttendance);
        setPersons(personsRes.data || []);
        // debug: log persons response when running locally
        try { console.debug && console.debug("personsRes", personsRes); } catch (e) {}
        // Use data length as authoritative fallback for totalEmployees
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
    const int = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) load(); }, 300_000); // refresh every 5min when visible
    return () => {
      mounted = false;
      clearInterval(int);
    };
  }, []);

  // Keep totalEmployees in sync with loaded persons
  useEffect(() => {
    setTotalEmployees((persons && persons.length) || 0);
  }, [persons]);

  // months not used in this component
  // viewMode: 'day' | 'week' | 'month'
  const [viewMode, setViewMode] = useState("month");

  const chartData = useMemo(() => {
    let buckets = [];
    if (viewMode === "day") buckets = buildLastNDays(30);
    else if (viewMode === "week") buckets = buildLastNWeeks(12);
    else buckets = buildLastNMonths(12);

    const counts = Object.fromEntries(buckets.map((b) => [b.key, 0]));

    const visibleAttendance = attendance.filter((record) => !record.archived);

    visibleAttendance.forEach((a) => {
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

      // update local state
      setPayrolls((prev) => prev.map((p) => (p.id === id ? { ...p, released: true } : p)));

      // Log activity: find payroll and person info
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

        // Optionally create next payroll period if configured
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
                // Try a more complete insert including numeric defaults (satisfy NOT NULL columns)
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

  // Recent today attendance (most recent first)
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
    // If not showing all, only include payrolls that are ready now
    if (!payrollShowAll) {
      return list.filter((p) => isPeriodEndedNow(p.period, settings));
    }
    return list;
  }, [payrolls, payrollSearch, payrollSort, personMap, payrollShowAll, settings]);

  // compute present/absent for today split by morning and afternoon shifts
  const {
    morningPresentNames,
    afternoonPresentNames,
    morningAbsentNames,
    afternoonAbsentNames,
  } = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    // parse settings times (fall back to broad windows when missing)
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

  useEffect(() => {
    setTodayPage((page) => Math.min(page, Math.max(1, Math.ceil(filteredTodayEntries.length / todayItemsPerPage))));
  }, [filteredTodayEntries.length]);

  const todayTotalPages = Math.max(1, Math.ceil(filteredTodayEntries.length / todayItemsPerPage));
  const todayStartIndex = (todayPage - 1) * todayItemsPerPage;
  const paginatedTodayEntries = filteredTodayEntries.slice(todayStartIndex, todayStartIndex + todayItemsPerPage);

  function showTooltip(ref, title, items) {
    // cancel any pending hide
    try { if (tooltipHideTimerRef.current) { clearTimeout(tooltipHideTimerRef.current); tooltipHideTimerRef.current = null; } } catch (e) {}
    // Default fallback coordinates
    let x = 12;
    let y = 12;
    if (ref && ref.current) {
      const r = ref.current.getBoundingClientRect();
      // Position the tooltip centered horizontally under the card, and slightly below the card's bottom edge
      x = Math.max(8, Math.round(r.left + r.width / 2));
      y = Math.min(Math.max(8, Math.round(r.bottom + 8)), window.innerHeight - 40);
      // keep tooltip inside viewport horizontally
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
        return "-";
      }
      return label && configTime ? `${label}: ${configTime}` : "-";
    } catch (e) {
      return "-";
    }
  }

  return (
    <div style={styles.container}>
      <h2 style={{ margin: 0, color: "#1f2937" }}>Dashboard</h2>
      <p style={{ color: "#6b7280", marginTop: 6 }}>Overview of attendance and payroll</p>

      <div style={styles.grid}>
        <div style={styles.card}>
          <div style={styles.iconWrap}><FiUsers size={20} /></div>
          <div>
            <div style={styles.title}>Total Employees</div>
            <div style={styles.value}>{compactNumber(totalEmployees)}</div>
          </div>
        </div>

        <div style={styles.card}>
          <div style={styles.iconWrap}><FiClock size={20} /></div>
          <div>
            <div style={styles.title}>Total Attendance (all time)</div>
            <div style={styles.value}>{compactNumber(totalAttendance)}</div>
          </div>
        </div>

        <div style={styles.card}>
          <div style={styles.iconWrap}><FiTrendingUp size={20} /></div>
          <div>
            <div style={styles.title}>Pending Payrolls</div>
            <div style={styles.value}>{compactNumber(pendingPayrolls)}</div>
          </div>
        </div>

        <div
          ref={presentCardRef}
          style={{ ...styles.card, cursor: 'default' }}
          onMouseEnter={() => showTooltip(
            presentCardRef,
            'Present Today',
            [
              <div style={styles.values}>{`Morning (${morningPresentNames.length})`}</div>,
              ...(morningPresentNames.length ? morningPresentNames : ['None']),
              '',
              <div style={styles.values}>{`Afternoon (${afternoonPresentNames.length})`}</div>,
              ...(afternoonPresentNames.length ? afternoonPresentNames : ['None']),
            ]
          )}
          onMouseLeave={() => scheduleHideTooltip()}
        >
          <div style={styles.iconWrap}><FiUsers size={20} /></div>
          <div>
            <div style={styles.title}>Present Today</div>
            <div style={styles.value}>{`Morning Shift : ${compactNumber(morningPresentNames.length)} Afternoon Shift: ${compactNumber(afternoonPresentNames.length)}`}</div>
          </div>
        </div>

        <div
          ref={absentCardRef}
          style={{ ...styles.card, cursor: 'default' }}
          onMouseEnter={() => showTooltip(
            absentCardRef,
            'Absent Today',
            [
              <div style={styles.values}>{`Morning Absent (${morningAbsentNames.length})`}</div>,
              ...(morningAbsentNames.length ? morningAbsentNames : ['None']),
              '',
              <div style={styles.values}>{`Afternoon Absent (${afternoonAbsentNames.length})`}</div>,
              ...(afternoonAbsentNames.length ? afternoonAbsentNames : ['None']),
            ]
          )}
          onMouseLeave={() => scheduleHideTooltip()}
        >
          <div style={styles.iconWrap}><FiClock size={20} /></div>
          <div>
            <div style={styles.title}>Absent Today</div>
            <div style={styles.value}>{`Morning Shift : ${compactNumber(Math.max(0, morningAbsentNames.length))} Afternoon Shift: ${compactNumber(Math.max(0, afternoonAbsentNames.length))}`}</div>
          </div>
        </div>
      </div>

      <div style={styles.chartGrid}>
        <div style={styles.chartCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 14, color: "#374151" }}>
                {`Attendances (${viewMode === "day" ? "last 30 days" : viewMode === "week" ? "last 12 weeks" : "12 months"})`}
              </div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>{viewMode === "day" ? "Daily total of attendance scans" : viewMode === "week" ? "Weekly total of attendance scans" : "Monthly total of attendance scans"}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setViewMode("day")} style={{ padding: "6px 10px", borderRadius: 999, border: viewMode === "day" ? "1px solid #237227" : "1px solid #e6eef6", background: viewMode === "day" ? "#237227" : "#fff", color: viewMode === "day" ? "#fff" : "#6b7280", cursor: "pointer", fontSize: 12 }}>Day</button>
              <button onClick={() => setViewMode("week")} style={{ padding: "6px 10px", borderRadius: 999, border: viewMode === "week" ? "1px solid #237227" : "1px solid #e6eef6", background: viewMode === "week" ? "#237227" : "#fff", color: viewMode === "week" ? "#fff" : "#6b7280", cursor: "pointer", fontSize: 12 }}>Week</button>
              <button onClick={() => setViewMode("month")} style={{ padding: "6px 10px", borderRadius: 999, border: viewMode === "month" ? "1px solid #237227" : "1px solid #e6eef6", background: viewMode === "month" ? "#237227" : "#fff", color: viewMode === "month" ? "#fff" : "#6b7280", cursor: "pointer", fontSize: 12 }}>Month</button>
            </div>
          </div>
          <LineChart data={chartData} />

          {/* Today's Attendance compact list moved to separate card below */}
        </div>

        <div style={styles.payrollCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h4 style={{ margin: 0, color: "#1f2937" }}>Payrolls Pending Release</h4>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                placeholder="Search name.."
                value={payrollSearch}
                onChange={(e) => setPayrollSearch(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 999, border: '1px solid #e6eef6', outline: 'none', minWidth: 110 }}
              />
              <button onClick={() => setPayrollShowAll((s) => !s)} style={{ padding: '8px 10px', borderRadius: 999, border: '1px solid #e6eef6', background: payrollShowAll ? '#eef2f6' : '#fff', cursor: 'pointer' }} title="Toggle show all pending payrolls">
                {payrollShowAll ? 'All' : 'Today'}
              </button>
              {/* Ready / Not-ready counts */}
              {readyPayrolls > 0 && (
                <div title={`${readyPayrolls} payroll(s) ready to release`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 99, background: "#10b981" }} />
                  <div style={{ fontSize: 12, color: "#6b7280" }}>{readyPayrolls} ready</div>
                </div>
              )}
              {notReadyPayrolls > 0 && (
                <div title={`${notReadyPayrolls} payroll(s) pending but not yet ended`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 99, background: "#f59e0b" }} />
                  <div style={{ fontSize: 12, color: "#6b7280" }}>{notReadyPayrolls} not ready</div>
                </div>
              )}
            </div>
          </div>
          <div style={styles.payrollList}>
            {(filteredPayrolls || []).map((p) => {
              const ready = isPeriodEndedNow(p.period, settings);
              const person = personMap[p.person_id] || null;
              const name = (person && (person.name || person.id)) || p.person_id || 'Unknown';
              return (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 10, borderRadius: 8, background: "#f8fafc", border: "1px solid #eef2f6" }}>
                  <div style={{ color: "#0f172a" }} title={name}>
                    <div style={{ fontWeight: 700 }}>{name}</div>
                    <div style={{ fontSize: 13, color: '#334155' }}>{formatPeriod(p.period)}{!ready && <span style={{ marginLeft: 8, color: '#9ca3af', fontSize: 12 }}>(ready after work-hours)</span>}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => releasePayroll(p.id, false)} disabled={!ready} style={{ padding: "6px 12px", borderRadius: 8, background: ready ? "#237227" : "#e6eef6", color: ready ? "#fff" : "#9ca3af", border: "none", cursor: ready ? "pointer" : "not-allowed" }}>{ready ? 'Release' : 'Release (disabled)'}</button>
                    {payrollShowAll && (
                      <button onClick={async () => {
                        const res = await Swal.fire({ title: 'Advance Release payroll?', text: `This will mark payroll for ${name} as released immediately (admin override). Continue?`, icon: 'warning', showCancelButton: true, confirmButtonText: 'Advance Release' });
                        if (res && res.isConfirmed) {
                          try { await releasePayroll(p.id, true); } catch (e) {}
                        }
                      }} style={{ padding: "6px 10px", borderRadius: 8, background: "#fff", color: "#374151", border: "1px solid #e6eef6", cursor: "pointer" }}>Advance Release</button>
                    )}
                  </div>
                </div>
              );
            })}
            {(filteredPayrolls || []).length === 0 && <div style={{ color: "#6b7280" }}>No pending payrolls ready for release</div>}
          </div>
        </div>
      </div>

    {/* Full width Today's Attendance card (table-like) */}
    <div style={styles.attendanceCard}>
      <div style={styles.attendanceHeader}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#1f2937" }}>Today's Attendance</div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 13, color: "#6b7280" }}>{filteredTodayEntries.length} records</div>
          <div style={{ fontSize: 12, color: "#9ca3af" }}>{todayLabel}</div>
        </div>
      </div>

      {/* Toolbar: search, status, department, sort, export */}
      <div style={styles.attendanceToolbar}>
        <input
          placeholder="Search name or ID"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={styles.attendanceInput}
        />

        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={styles.attendanceSelect}>
          <option value="all">All Status</option>
          <option value="on-time">On-time</option>
          <option value="late">Late</option>
          <option value="present">Present</option>
        </select>

        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={styles.attendanceSelect}>
          <option value="all">All Departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>

        <button
          aria-label="Toggle sort order"
          onClick={() => setSortOrder((s) => (s === "ascending" ? "descending" : "ascending"))}
          style={styles.sortToggle}
        >
          {sortOrder === "ascending" ? "Asc" : "Desc"}
        </button>


        <button onClick={() => {
          // export filteredTodayEntries to CSV
          try {
            const rows = filteredTodayEntries || [];
            const header = ['person_id','name','department','device_time','event','status'];
            const csv = [header.join(',')].concat(rows.map(r => {
                  const person = r.person || personMap[r.person_id] || {};
                  const name = (person && person.name) || r.name || '';
                  const dept = (person && person.department) || r.department || '';
                  return [r.person_id, `"${name.replace(/"/g,'""') }"`, `"${dept.replace(/"/g,'""') }"`, r.device_time, r.event || '', r.status || ''].join(',');
            })).join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `today_attendance_${new Date().toISOString().slice(0,10)}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          } catch (e) { console.error(e); }
        }} style={styles.attendanceExport}><FiDownload color="#ffffff" />Export Excel</button>
      </div>

      <div style={{ ...styles.attendanceTable, display: "grid", gridTemplateColumns: "2.3fr 1fr 1.1fr 1.7fr 1.2fr 1.2fr", gap: 8, alignItems: "center", ...styles.attendanceHeading }}>
        <div>PHOTO / ATTENDANCE TIME</div>
        <div>EMPLOYEE ID</div>
        <div>EMPLOYEE NAME</div>
        <div>DEPARTMENT / WORK HOURS</div>
        <div>ATTENDANCE STATUS</div>
        <div>ATTENDANCE METHOD</div>
      </div>

      <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid #e5e7eb", borderTop: "none", borderRadius: "0 0 10px 10px" }}>
        {(filteredTodayEntries.length === 0) && (
          <div style={{ padding: 16, color: "#6b7280" }}>No attendance recorded today</div>
        )}
        {paginatedTodayEntries.map((r, i) => {
          const person = r.person || personMap[r.person_id] || (persons || []).find((p) => String(p.name) === String(r.person_id)) || null;
          const name = (person && person.name) || r.name || `Person #${r.person_id}`;
          let timeLabel = "";
          try { timeLabel = new Date(r.device_time).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" }) + " - " + new Date(r.device_time).toLocaleTimeString("en-US"); } catch (e) {}
          const status = getAttendanceStatus(r, settings || {});
          return (
            <div key={i} style={{ ...styles.attendanceRow, display: "grid", gridTemplateColumns: "2.3fr 1fr 1.1fr 1.7fr 1.2fr 1.2fr", gap: 8, alignItems: "center", padding: "13px 12px", minHeight: 80 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div style={styles.attendancePhoto}>
                  {r.photo ? (
                    <img src={r.photo} alt={name || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer' }} onClick={() => openPhotoModal(r.photo, name)} />
                  ) : person && person.registration_photo ? (
                    <img src={person.registration_photo} alt={(person && person.name) || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer' }} onClick={() => openPhotoModal(person.registration_photo, (person && person.name) || '')} />
                  ) : (
                    ((person && (person.name)) ? ((person.name).slice(0,2)) : String(r.person_id).slice(0,2))
                  )}
                </div>
                <div>
                  <div style={{ color: "#0f172a", fontWeight: 700 }}>{timeLabel}</div>
                  <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>{new Date(r.device_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
                </div>
              </div>

              <div>
                <div style={{ fontSize: 13, color: "#0f172a", fontWeight: 700 }}>{person && person.id ? person.id : (r.person_id || '-')}</div>
              </div>

              <div>
                <div style={{ fontSize: 13, color: "#0f172a", fontWeight: 600 }}>{name}</div>
              </div>

              <div>
                <div style={{ color: "#0f172a" }}>{(person && person.department) || r.department || "-"}</div>
                <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 6 }}>{getWorkHoursLabel(r)}</div>
              </div>

              <div>
                <span style={{ ...styles.attendanceStatus, ...(status === "on-time" ? { background: "#ecfdf5", borderColor: "#bbf7d0", color: "#059669" } : status === "overtime" ? { background: "#eff6ff", borderColor: "#bfdbfe", color: "#2563eb" } : {}) }}>{status}</span>
              </div>

              <div style={{ color: "#6b7280" }}>{r.method || 'face-scan'}</div>

            </div>
          );
        })}
      </div>

      {filteredTodayEntries.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "14px 16px", background: "#f9fafb", borderTop: "1px solid #e5e7eb", color: "#475569", fontSize: 13 }}>
          <div>
            Showing <strong style={{ color: "#1f2937" }}>{todayStartIndex + 1}</strong> to{" "}
            <strong style={{ color: "#1f2937" }}>{Math.min(todayStartIndex + todayItemsPerPage, filteredTodayEntries.length)}</strong> of{" "}
            <strong style={{ color: "#1f2937" }}>{filteredTodayEntries.length}</strong> records
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setTodayPage((page) => Math.max(page - 1, 1))}
              disabled={todayPage === 1}
              aria-label="Previous page"
              style={{ width: 36, height: 36, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 10, border: "1px solid #e5e7eb", background: "#ffffff", color: "#64748b", cursor: todayPage === 1 ? "not-allowed" : "pointer", opacity: todayPage === 1 ? 0.45 : 1 }}
            >
              <FiChevronLeft size={16} />
            </button>
            <button
              type="button"
              aria-current="page"
              style={{ width: 36, height: 36, border: "1px solid #237227", borderRadius: 10, background: "#237227", color: "#ffffff", fontWeight: 700 }}
            >
              {todayPage}
            </button>
            <button
              type="button"
              onClick={() => setTodayPage((page) => Math.min(page + 1, todayTotalPages))}
              disabled={todayPage === todayTotalPages}
              aria-label="Next page"
              style={{ width: 36, height: 36, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 10, border: "1px solid #e5e7eb", background: "#ffffff", color: "#64748b", cursor: todayPage === todayTotalPages ? "not-allowed" : "pointer", opacity: todayPage === todayTotalPages ? 0.45 : 1 }}
            >
              <FiChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>

      {/* Tooltip for present/absent */}
      {/* Photo modal */}
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

      {/* Tooltip for present/absent */}
      {tooltip.visible && (
        <div
          onMouseEnter={() => { try { if (tooltipHideTimerRef.current) { clearTimeout(tooltipHideTimerRef.current); tooltipHideTimerRef.current = null; } } catch (e) {} setTooltip(t => ({...t, visible: true})); }}
          onMouseLeave={() => scheduleHideTooltip()}
          style={{ position: 'fixed', left: tooltip.x, top: tooltip.y, background: '#fff', border: '1px solid #e6eef6', borderRadius: 8, padding: 12, boxShadow: '0 8px 24px rgba(2,6,23,0.06)', zIndex: 9999, maxWidth: 300 }}
        >
          <div style={{ fontWeight: 700, color: '#237227', marginBottom: 8 }}>{tooltip.title}</div>
          <div style={{ maxHeight: 220, overflow: 'auto', fontSize: 13, color: '#374151' }}>
            {(tooltip.items && tooltip.items.length) ? tooltip.items.map((n, i) => <div key={i} style={{ padding: '4px 0', borderBottom: i < tooltip.items.length - 1 ? '1px solid #f1f5f9' : 'none' }}>{n}</div>) : <div style={{ color: '#9ca3af' }}>None</div>}
          </div>
        </div>
      )}

  </div>
  );
}
