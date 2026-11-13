import PersonRegistration from "./AdminPage/PersonRegistration";
import PayrollPage from "./AdminPage/PayrollPage";
// App.js
import {
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useLoading } from "./LoadingContext";
import { supabase } from "./mysqlClient";
import {
  AUTH_EXPIRED_EVENT,
  getStoredSession,
  saveStoredSession,
  clearStoredSession,
} from "./utils/authSession";

import AdminLogin from "./AdminPage/AdminLogin";
import DefaultLanding from "./CameraAttendance/DefaultLanding";
import UserAttendanceScanner from "./CameraAttendance/UserAttendanceScanner";
import { FiLogIn } from "react-icons/fi";
import Dashboard from "./AdminPage/Dashboard";
import ReleasedHistoryPayroll from "./AdminPage/ReleasedHistoryPayroll";
import ReleasedPayrollLogs from "./AdminPage/ReleasedPayrollLogs";
import AdminSettings from "./AdminPage/AdminSettings";
import AttendanceTable from "./AdminPage/AttendanceTable";
import FieldAttendanceTable from "./AdminPage/FieldAttendanceTable";
import AdminSidebar from "./AdminPage/AdminSidebar";
import DepartmentRates from "./AdminPage/DepartmentRates";
import PersonsTable from "./AdminPage/PersonsTable";
import StaffLoginModal from "./AdminPage/StaffLoginModal";
import DeviceMonitoring from "./AdminPage/DeviceMonitoring";
import AccountSettings from "./AdminPage/AccountSettings";
import {
  ADMIN_ROLE,
  STAFF_ROLES,
  getLoginRedirectPath,
  getSessionRole,
  hasAllowedRole,
} from "./utils/authRoles";
import { checkIsMobileDevice } from "./utils/deviceUtils";

function ProtectedRoute({ session, allowedRoles = STAFF_ROLES, children }) {
  return hasAllowedRole(session, allowedRoles) ? (
    children
  ) : (
    <Navigate to="/admin" replace />
  );
}

function App() {
  const modalTimerRef = useRef(null);
  const [showStaffLogin, setShowStaffLogin] = useState(false);
  const [session, setSession] = useState(() => {
    const stored = getStoredSession();
    return stored && typeof stored.access_token === "string" && stored.access_token.trim()
      ? stored
      : null;
  });

  // Validate active JWT session against backend on mount and listen for auth changes/expiry
  useEffect(() => {
    let mounted = true;
    const verifyFn =
      typeof supabase.auth.getVerifiedSession === "function"
        ? () => supabase.auth.getVerifiedSession()
        : () => supabase.auth.getSession();

    verifyFn().then(({ data: { session: verifiedSession } }) => {
      if (!mounted) return;
      const valid = verifiedSession?.access_token ? verifiedSession : null;
      setSession(valid);
      if (valid) saveStoredSession(valid);
      else clearStoredSession();
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        const valid = nextSession?.access_token ? nextSession : null;
        setSession(valid);
        if (valid) saveStoredSession(valid);
        else clearStoredSession();
      },
    );

    const handleAuthExpired = () => {
      clearStoredSession();
      setSession(null);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);

    return () => {
      mounted = false;
      listener?.subscription.unsubscribe();
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    };
  }, []);

  // detect mobile device (including mobile in landscape mode)
  const [isMobile, setIsMobile] = useState(() => checkIsMobileDevice());

  useEffect(() => {
    function handleResize() {
      setIsMobile(checkIsMobileDevice());
    }
    handleResize();
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, []);

  // show global loading on navigation
  const { setLoading } = useLoading();
  const location = useLocation();
  const navigate = useNavigate();
  // const isAdminPath = location.pathname.startsWith("/admin");
  const isAdminLoginPath = location.pathname === "/admin";
  const currentRole = getSessionRole(session);
  const hasStaffAccess = hasAllowedRole(session, STAFF_ROLES);

  // No auto-logout: the attendance account stays logged in until the user
  // explicitly clicks the Logout button. This prevents camera stream loss.

  useEffect(() => {
    // show overlay immediately on navigation
    setLoading(true);
    // hide after a small delay — components that fetch data can still toggle this off
    const t = setTimeout(() => setLoading(false), 300);
    return () => clearTimeout(t);
  }, [location.pathname, setLoading]);

  useEffect(() => {
    const timer = modalTimerRef.current;

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        {isAdminLoginPath && !isMobile && (
          <div className="w-full bg-[#f9fafc] border-b border-[#eef2f6] px-6 lg:px-8 py-3.5 shadow-[0_4px_14px_rgba(0,0,0,0.03)] sticky top-0 z-[100]">
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-3.5">
                <img
                  src="/image/logosidebar.jpg"
                  alt="Multifactors Sales Attendance Logo"
                  className="h-[44px] object-contain"
                />
                <h1 className="text-black text-[1.35rem] lg:text-[1.45rem] font-bold m-0 p-0 tracking-[0.01em]">
                  Face Recognition Time and Attendance
                </h1>
              </div>
              
              <div className="flex items-center gap-3">
                {hasStaffAccess && currentRole === ADMIN_ROLE && !location.pathname.startsWith("/admin") && (
                  <button
                    type="button"
                    onClick={() => navigate("/admin/dashboard")}
                    className="py-2 px-[16px] rounded-full border border-[#237227] bg-[#237227] text-white cursor-pointer text-sm font-bold shadow-sm"
                  >
                    <span className="inline-flex items-center">
                      <FiLogIn className="mr-2 align-middle" />
                      Admin Dashboard
                    </span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <Routes>
          <Route
            path="/"
            element={<DefaultLanding session={session} />}
          />
          <Route
            path="/scan"
            element={<UserAttendanceScanner />}
          />
          <Route
            path="/staff-login"
            element={
              <div className="max-w-[900px] mx-auto">
                <div className="mt-6 py-10 px-7 rounded-[24px] bg-gradient-to-b from-[#0f172a] to-[#111827] text-[#e5e7eb] text-center border border-white/10 shadow-[0_24px_60px_rgba(15,23,42,0.25)]">
                  <div className="inline-flex items-center justify-center py-1.5 px-3 rounded-full bg-[rgba(35,114,39,0.16)] text-[#86efac] text-xs font-bold tracking-[0.4px] uppercase mb-[14px]">
                    Staff login
                  </div>
                  <h2 className="m-0 text-[26px] leading-[1.2] text-white">
                    Open the secretary account
                  </h2>
                  <p className="max-w-[560px] mx-auto mt-[14px] mb-6 text-[15px] leading-[1.7] text-[#cbd5e1]">
                    Use the popup login to sign in with the staff email and
                    password.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowStaffLogin(true)}
                    className="py-3 px-[22px] rounded-full border border-[#237227] bg-[#237227] text-white cursor-pointer text-sm font-bold shadow-[0_12px_30px_rgba(35,114,39,0.25)]"
                  >
                    Open Staff Login
                  </button>
                </div>
              </div>
            }
          />
          <Route
            path="/admin/register-person"
            element={
              <ProtectedRoute session={session} allowedRoles={[ADMIN_ROLE]}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <PersonRegistration />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/dashboard"
            element={
              <ProtectedRoute session={session} allowedRoles={STAFF_ROLES}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <Dashboard />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              currentRole === ADMIN_ROLE ? (
                <Navigate to={getLoginRedirectPath(session)} />
              ) : (
                <AdminLogin />
              )
            }
          />
          <Route
            path="/admin/settings"
            element={
              <ProtectedRoute session={session} allowedRoles={[ADMIN_ROLE]}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <AdminSettings />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/device-monitoring"
            element={
              <ProtectedRoute session={session} allowedRoles={[ADMIN_ROLE]}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <DeviceMonitoring />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/account-settings"
            element={
              <ProtectedRoute session={session} allowedRoles={STAFF_ROLES}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <AccountSettings />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/attendance"
            element={
              <ProtectedRoute session={session} allowedRoles={STAFF_ROLES}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <AttendanceTable />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/field-attendance"
            element={
              <ProtectedRoute session={session} allowedRoles={STAFF_ROLES}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <FieldAttendanceTable />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/department-rates"
            element={
              <ProtectedRoute session={session} allowedRoles={[ADMIN_ROLE]}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <DepartmentRates />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/persons"
            element={
              <ProtectedRoute session={session} allowedRoles={[ADMIN_ROLE]}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <PersonsTable />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/payroll"
            element={
              <ProtectedRoute session={session} allowedRoles={[ADMIN_ROLE]}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <PayrollPage />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/released-history"
            element={
              <ProtectedRoute session={session} allowedRoles={[ADMIN_ROLE]}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <ReleasedHistoryPayroll />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/ReleasedPayrollLogs"
            element={
              <ProtectedRoute session={session} allowedRoles={[ADMIN_ROLE]}>
                <div className="flex min-h-screen bg-white">
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div className={`flex-1 pt-4 pb-8 px-6 lg:px-8 bg-white ${isMobile ? "ml-0" : "ml-[295px]"}`}>
                    <ReleasedPayrollLogs />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
        </Routes>
        <StaffLoginModal
          open={showStaffLogin}
          onClose={() => setShowStaffLogin(false)}
          onStaffLoggedIn={() => setShowStaffLogin(false)}
        />
      </header>
    </div>
  );
}

export default App;