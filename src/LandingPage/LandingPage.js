import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  FiCamera,
  FiClock,
  FiShield,
  FiWifi,
  FiWifiOff,
  FiMapPin,
  FiUserCheck,
  FiCheckCircle,
  FiArrowRight,
  FiGrid,
  FiLogIn,
  FiDatabase,
  FiDollarSign,
  FiUploadCloud,
} from "react-icons/fi";
import offlineQueue from "../utils/offlineQueue";
import { checkIsMobileDevice } from "../utils/deviceUtils";
import {
  getLoginRedirectPath,
  getSessionRole,
  hasAllowedRole,
  STAFF_ROLES,
  ADMIN_ROLE,
} from "../utils/authRoles";

const STEPS = [
  {
    icon: FiCamera,
    title: "Open the Scanner",
    text: "Tap “Launch Attendance Scanner” on your phone or tablet and allow camera and location access.",
  },
  {
    icon: FiUserCheck,
    title: "Verify Your Face",
    text: "Align your face inside the oval frame. Your identity is matched against registered records.",
  },
  {
    icon: FiCheckCircle,
    title: "Confirm Time In / Out",
    text: "Capture your site proof photo, then confirm Time In or Time Out. Works offline too.",
  },
];

const CAPABILITIES = [
  { icon: FiShield, label: "Dahua biometric face recognition" },
  { icon: FiUploadCloud, label: "Offline queue with auto-sync" },
  { icon: FiMapPin, label: "GPS-stamped site proof" },
  { icon: FiDollarSign, label: "Payroll, overtime & holiday rates" },
];

export default function LandingPage({ session }) {
  const [now, setNow] = useState(() => new Date());
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [pendingCount, setPendingCount] = useState(0);

  const hasStaffAccess = hasAllowedRole(session, STAFF_ROLES);
  const role = getSessionRole(session);
  const dashboardPath = getLoginRedirectPath(session);
  const dashboardLabel =
    role === ADMIN_ROLE ? "Go to Dashboard" : "Go to Attendance Table";
  const userEmail = session?.user?.email;

  // Mobile detection (same helper as App.js / scanner)
  const [isMobile, setIsMobile] = useState(() => checkIsMobileDevice());
  useEffect(() => {
    const handle = () => setIsMobile(checkIsMobileDevice());
    handle();
    window.addEventListener("resize", handle);
    window.addEventListener("orientationchange", handle);
    return () => {
      window.removeEventListener("resize", handle);
      window.removeEventListener("orientationchange", handle);
    };
  }, []);

  // Live clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Connectivity status
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Pending offline queue counter
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const q = await offlineQueue.getAllQueue();
        if (!cancelled) setPendingCount(Array.isArray(q) ? q.length : 0);
      } catch (e) {
        if (!cancelled) setPendingCount(0);
      }
    };
    load();
    const t = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [isOnline]);

  const time = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const date = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="w-full min-h-screen flex flex-col bg-[#f9fafc] text-gray-900 font-sans text-left">
      {/* Header */}
      {!isMobile && (
      <header className="sticky top-0 z-[100] w-full bg-white border-b border-[#eef2f6] shadow-[0_4px_14px_rgba(0,0,0,0.03)]">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/image/logosidebar.jpg"
              alt="Multifactors Sales Attendance Logo"
              className="h-9 sm:h-11 object-contain shrink-0"
            />
            <span className="hidden sm:block text-base lg:text-lg font-bold text-black truncate">
              Face Recognition Time and Attendance
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border ${
                isOnline
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-amber-50 text-amber-700 border-amber-200"
              }`}
              aria-live="polite"
            >
              {isOnline ? <FiWifi /> : <FiWifiOff />}
              {isOnline ? "Online" : "Offline"}
              {pendingCount > 0 && (
                <span className="ml-1 px-1.5 rounded-full bg-amber-500 text-white">
                  {pendingCount} pending
                </span>
              )}
            </span>

            {hasStaffAccess ? (
              <Link
                to={dashboardPath}
                className="inline-flex items-center gap-2 py-2 px-4 rounded-full bg-[#237227] hover:bg-[#1a541c] text-white text-sm font-bold no-underline shadow-sm transition-colors"
              >
                <FiGrid /> <span className="hidden sm:inline">{dashboardLabel}</span>
                <span className="sm:hidden">Dashboard</span>
              </Link>
            ) : (
              <Link
                to="/admin"
                className="inline-flex items-center gap-2 py-2 px-4 rounded-full border border-[#237227] text-[#237227] hover:bg-[#237227] hover:text-white text-sm font-bold no-underline transition-colors"
              >
                <FiLogIn /> Sign In
              </Link>
            )}
          </div>
        </div>
      </header>
      )}

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {/* Hero */}
        {!isMobile && (
        <section className="text-center mb-10">
          {!isMobile && (
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[rgba(35,114,39,0.1)] text-[#237227] text-xs font-bold tracking-wide uppercase mb-4">
            <FiShield /> Multifactors Sales Attendance
          </div>
          )}
          <h1 className="m-0 text-3xl sm:text-4xl lg:text-5xl font-extrabold text-gray-900 leading-tight">
            Smart attendance, <span className="text-[#237227]">verified by face.</span>
          </h1>
          <p className="max-w-2xl mx-auto mt-4 mb-6 text-base sm:text-lg text-gray-600 leading-relaxed">
            Record Time In and Time Out with biometric verification and site proof —
            online or offline — with payroll-ready records for your team.
          </p>
          <div className="inline-flex flex-col items-center bg-white border border-gray-100 rounded-2xl px-8 py-4 shadow-[0_10px_25px_rgba(0,0,0,0.05)]">
            <div className="flex items-center gap-2 text-3xl sm:text-4xl font-bold font-mono text-gray-900 tabular-nums">
              <FiClock className="text-[#237227]" />
              <span>{time}</span>
            </div>
            <div className="text-sm text-gray-500 mt-1">{date}</div>
          </div>
        </section>
        )}

        {/* Gateway cards */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {/* Scanner */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_10px_25px_rgba(0,0,0,0.05)] p-6 sm:p-8 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="w-14 h-14 rounded-2xl bg-[rgba(35,114,39,0.1)] text-[#237227] flex items-center justify-center text-2xl">
                <FiCamera />
              </div>
              <span className="text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                Biometric &amp; Offline Ready
              </span>
            </div>
            <h2 className="m-0 text-2xl font-bold text-gray-900">Employee Attendance</h2>
            <p className="mt-2 mb-4 text-gray-600 leading-relaxed">
              Record your Time In or Time Out with face recognition and site location
              photo proof.
            </p>
            <ul className="list-none p-0 m-0 mb-6 flex flex-col gap-2 text-sm text-gray-700">
              {["Instant biometric matching", "GPS geo-stamped records", "Keeps working without internet"].map(
                (t) => (
                  <li key={t} className="flex items-center gap-2">
                    <FiCheckCircle className="text-[#237227] shrink-0" /> {t}
                  </li>
                )
              )}
            </ul>
            <Link
              to="/scan"
              className="mt-auto inline-flex items-center justify-center gap-2 min-h-[48px] px-5 py-3 rounded-xl bg-[#237227] hover:bg-[#1a541c] text-white font-bold text-base no-underline shadow-lg transition-colors"
            >
              Launch Attendance Scanner <FiArrowRight />
            </Link>
          </div>

          {/* Admin */}
          {!isMobile && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_10px_25px_rgba(0,0,0,0.05)] p-6 sm:p-8 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="w-14 h-14 rounded-2xl bg-slate-100 text-slate-700 flex items-center justify-center text-2xl">
                <FiDatabase />
              </div>
              <span className="text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                Management Access
              </span>
            </div>
            <h2 className="m-0 text-2xl font-bold text-gray-900">Staff &amp; Administration</h2>
            <p className="mt-2 mb-4 text-gray-600 leading-relaxed">
              Manage time logs, employee records, Dahua device monitoring and automated payroll
              calculations.
            </p>
            <ul className="list-none p-0 m-0 mb-6 flex flex-col gap-2 text-sm text-gray-700">
              {["Real-time attendance logs", "Department rates & holiday rules", "PDF payslip export"].map(
                (t) => (
                  <li key={t} className="flex items-center gap-2">
                    <FiCheckCircle className="text-[#237227] shrink-0" /> {t}
                  </li>
                )
              )}
            </ul>
            {hasStaffAccess && userEmail && (
              <div className="mb-3 text-xs text-gray-500">
                Signed in as <span className="font-semibold text-gray-700">{userEmail}</span>
              </div>
            )}
            <Link
              to={hasStaffAccess ? dashboardPath : "/admin"}
              className="mt-auto inline-flex items-center justify-center gap-2 min-h-[48px] px-5 py-3 rounded-xl border-2 border-[#237227] text-[#237227] hover:bg-[#237227] hover:text-white font-bold text-base no-underline transition-colors"
            >
              {hasStaffAccess ? dashboardLabel : "Management Sign In"} <FiArrowRight />
            </Link>
          </div>
          )}
        </section>

        {/* How to */}
        <section className="mb-12">
          <h2 className="text-center m-0 mb-6 text-2xl font-bold text-gray-900">
            How to Clock In
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              return (
                <div
                  key={s.title}
                  className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm flex gap-4"
                >
                  <div className="shrink-0 w-10 h-10 rounded-full bg-[#237227] text-white font-bold flex items-center justify-center">
                    {i + 1}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 font-bold text-gray-900">
                      <Icon className="text-[#237227]" /> {s.title}
                    </div>
                    <p className="mt-1 mb-0 text-sm text-gray-600 leading-relaxed">{s.text}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Capabilities */}
        {!isMobile && (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {CAPABILITIES.map((c) => {
            const Icon = c.icon;
            return (
              <div
                key={c.label}
                className="flex items-center gap-3 bg-white border border-gray-100 rounded-xl px-4 py-3 text-sm font-semibold text-gray-700"
              >
                <Icon className="text-[#237227] text-lg shrink-0" /> {c.label}
              </div>
            );
          })}
        </section>
        )}
      </main>

      <footer className="w-full py-6 px-4 sm:px-6 lg:px-8 text-sm text-gray-600 bg-gray-50 border-t border-gray-200">
        <div className="w-full text-left">
          © 2026 Multifactors Sales Attendance. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
