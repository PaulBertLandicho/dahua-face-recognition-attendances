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
import { supabase } from "./supabaseClient";

import CameraPlayer from "./CameraAttendance/CameraPlayer";
import AdminLogin from "./AdminPage/AdminLogin";
import { FiLogIn, FiLogOut } from "react-icons/fi";
import { FiCamera } from "react-icons/fi";
import Dashboard from "./AdminPage/Dashboard";
import ReleasedHistoryPayroll from "./AdminPage/ReleasedHistoryPayroll";
import ReleasedPayrollLogs from "./AdminPage/ReleasedPayrollLogs";
import AdminSettings from "./AdminPage/AdminSettings";
import AttendanceTable from "./AdminPage/AttendanceTable";
import AdminSidebar from "./AdminPage/AdminSidebar";
import DepartmentRates from "./AdminPage/DepartmentRates";
import PersonsTable from "./AdminPage/PersonsTable";
import StaffLoginModal from "./AdminPage/StaffLoginModal";
import {
  ADMIN_ROLE,
  SECRETARY_ROLE,
  STAFF_ROLES,
  getLoginRedirectPath,
  getSessionRole,
  hasAllowedRole,
} from "./utils/authRoles";

function App() {
  const modalTimerRef = useRef(null);
  const [showStaffLogin, setShowStaffLogin] = useState(false);
  const [session, setSession] = useState(() => {
    // Try to get session from localStorage if available
    const stored = localStorage.getItem("sb-session");
    return stored ? JSON.parse(stored) : null;
  });

  // Check for active session on mount and listen for changes
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) localStorage.setItem("sb-session", JSON.stringify(session));
      else localStorage.removeItem("sb-session");
    });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
        if (session)
          localStorage.setItem("sb-session", JSON.stringify(session));
        else localStorage.removeItem("sb-session");
      },
    );
    return () => listener?.subscription.unsubscribe();
  }, []);

  // detect mobile viewport to conditionally hide the header
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= 600 : false,
  );

  useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 600);
    }
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // show global loading on navigation
  const { setLoading } = useLoading();
  const location = useLocation();
  const navigate = useNavigate();
  // const isAdminPath = location.pathname.startsWith("/admin");
  const isCameraPath = location.pathname === "/" || location.pathname === "";
  const isAdminLoginPath = location.pathname === "/admin";
  const currentRole = getSessionRole(session);
  const hasStaffAccess = hasAllowedRole(session, STAFF_ROLES);

  // No auto-logout: the attendance account stays logged in until the user
  // explicitly clicks the Logout button. This prevents camera stream loss.

  const ProtectedRoute = ({ allowedRoles = STAFF_ROLES, children }) =>
    hasAllowedRole(session, allowedRoles) ? (
      children
    ) : (
      <Navigate to="/admin" replace />
    );

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

  // Removed unused: handleFaceScan, closeModal

  // Manual logout handler for attendance account
  const handleAttendanceLogout = async () => {
    await supabase.auth.signOut();
    localStorage.removeItem("sb-session");
    setSession(null);
  };

  return (
    <div className="App">
      <header className="App-header">
        {(isCameraPath || isAdminLoginPath) && !isMobile && (
          <div style={styles.headerContainer}>
            <div style={styles.headerBar}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  position: "absolute",
                  left: 5,
                }}
              >
                <img
                  src="/image/logosidebar.jpg"
                  alt="Multifactors Sales Logo"
                  style={{
                    height: 45,
                    objectFit: "contain",
                    paddingLeft: 10,
                  }}
                />
                <h1
                  style={{
                    ...styles.headerTitle,
                    margin: 0,
                    padding: 0,
                  }}
                >
                  Face Recognition Time and Attendance
                </h1>
              </div>
              {hasStaffAccess && (
                <div style={styles.headerActions}>
                  {currentRole === ADMIN_ROLE && !location.pathname.startsWith("/admin") && (
                    <button
                      type="button"
                      onClick={() => navigate("/admin/dashboard")}
                      style={styles.adminButton}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center" }}>
                        <FiLogIn style={{ marginRight: 8, verticalAlign: "middle" }} />
                        Admin Dashboard
                      </span>
                    </button>
                  )}
                  {(currentRole === ADMIN_ROLE || currentRole === SECRETARY_ROLE) && location.pathname.startsWith("/admin") && (
                    <button
                      type="button"
                      onClick={() => navigate("/")}
                      style={styles.adminButton}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center" }}>
                        <FiCamera style={{ marginRight: 8, verticalAlign: "middle" }} />
                        Attendance Camera
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        <Routes>
          <Route
            path="/"
            element={
              hasStaffAccess ? (
                <div style={{ maxWidth: 900, margin: "0 auto" }}>
                  <CameraPlayer />
                  <div style={{ marginTop: 12, textAlign: "right" }}>
                    <button
                      type="button"
                      onClick={handleAttendanceLogout}
                      style={{
                        padding: "8px 16px",
                        borderRadius: 999,
                        border: "1px solid #dc2626",
                        background: "#dc2626",
                        color: "#ffffff",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <FiLogOut style={{ fontSize: 14 }} />
                      Logout Attendance
                    </button>
                  </div>
                </div>
              ) : (
                <AdminLogin />
              )
            }
          />
          <Route
            path="/staff-login"
            element={
              <div style={{ maxWidth: 900, margin: "0 auto" }}>
                <div style={styles.staffGateCard}>
                  <div style={styles.staffGatePill}>Staff login</div>
                  <h2 style={styles.staffGateTitle}>
                    Open the secretary account
                  </h2>
                  <p style={styles.staffGateText}>
                    Use the popup login to sign in with the staff email and
                    password.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowStaffLogin(true)}
                    style={styles.staffGateButton}
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
              <ProtectedRoute allowedRoles={[ADMIN_ROLE]}>
                <div style={styles.adminLayout}>
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div
                    style={{
                      ...styles.adminContent,
                      marginLeft: isMobile ? 0 : styles.adminContent.marginLeft,
                    }}
                  >
                    <PersonRegistration />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/dashboard"
            element={
              <ProtectedRoute allowedRoles={STAFF_ROLES}>
                <div style={styles.adminLayout}>
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div
                    style={{
                      ...styles.adminContent,
                      marginLeft: isMobile ? 0 : styles.adminContent.marginLeft,
                    }}
                  >
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
              <ProtectedRoute allowedRoles={[ADMIN_ROLE]}>
                <div style={styles.adminLayout}>
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div
                    style={{
                      ...styles.adminContent,
                      marginLeft: isMobile ? 0 : styles.adminContent.marginLeft,
                    }}
                  >
                    <AdminSettings />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/attendance"
            element={
              <ProtectedRoute allowedRoles={STAFF_ROLES}>
                <div style={styles.adminLayout}>
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div
                    style={{
                      ...styles.adminContent,
                      marginLeft: isMobile ? 0 : styles.adminContent.marginLeft,
                    }}
                  >
                    <AttendanceTable />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/department-rates"
            element={
              <ProtectedRoute allowedRoles={[ADMIN_ROLE]}>
                <div style={styles.adminLayout}>
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div
                    style={{
                      ...styles.adminContent,
                      marginLeft: isMobile ? 0 : styles.adminContent.marginLeft,
                    }}
                  >
                    <DepartmentRates />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/persons"
            element={
              <ProtectedRoute allowedRoles={[ADMIN_ROLE]}>
                <div style={styles.adminLayout}>
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div
                    style={{
                      ...styles.adminContent,
                      marginLeft: isMobile ? 0 : styles.adminContent.marginLeft,
                    }}
                  >
                    <PersonsTable />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/payroll"
            element={
              <ProtectedRoute allowedRoles={[ADMIN_ROLE]}>
                <div style={styles.adminLayout}>
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div
                    style={{
                      ...styles.adminContent,
                      marginLeft: isMobile ? 0 : styles.adminContent.marginLeft,
                    }}
                  >
                    <PayrollPage />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/released-history"
            element={
              <ProtectedRoute allowedRoles={[ADMIN_ROLE]}>
                <div style={styles.adminLayout}>
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div
                    style={{
                      ...styles.adminContent,
                      marginLeft: isMobile ? 0 : styles.adminContent.marginLeft,
                    }}
                  >
                    <ReleasedHistoryPayroll />
                  </div>
                </div>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/ReleasedPayrollLogs"
            element={
              <ProtectedRoute allowedRoles={[ADMIN_ROLE]}>
                <div style={styles.adminLayout}>
                  <AdminSidebar
                    role={currentRole}
                    onLogout={async () => {
                      await supabase.auth.signOut();
                      localStorage.removeItem("sb-session");
                      window.location.href = "/admin";
                    }}
                  />
                  <div
                    style={{
                      ...styles.adminContent,
                      marginLeft: isMobile ? 0 : styles.adminContent.marginLeft,
                    }}
                  >
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

// Light theme styles with green accent
const styles = {
  headerTitle: {
    color: "#000000",
    fontSize: "1.45rem",
    fontWeight: "bold",
    margin: 0,
    letterSpacing: "0.01em",
  },
  headerSubtitle: {
    color: "#6b7280",
    fontSize: "1.10rem",
    fontWeight: "bold",
  },
  modalOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    width: "100vw",
    height: "100vh",
    background: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    backdropFilter: "blur(4px)",
  },
  modalContent: {
    background: "#ffffff",
    padding: "32px",
    borderRadius: "28px",
    minWidth: "340px",
    maxWidth: "500px",
    width: "90%",
    boxShadow: "0 20px 40px rgba(0, 0, 0, 0.2)",
    border: "1px solid #e5e7eb",
    position: "relative",
  },
  modalClose: {
    position: "absolute",
    top: "12px",
    right: "16px",
    background: "transparent",
    border: "none",
    color: "#6b7280",
    fontSize: "1.8rem",
    cursor: "pointer",
    lineHeight: 1,
    transition: "color 0.2s",
  },
  adminLayout: {
    display: "flex",
    minHeight: "100vh",
    background: "#ffffff",
  },
  adminContent: {
    marginLeft: "280px", // matches sidebar width
    flex: 1,
    padding: "40px",
    background: "#ffffff",
  },
  logoIcon: {
    marginTop: 20,
    borderRadius: 999,
    background: "#ffffff",
  },
  headerBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    maxWidth: 900,
    margin: "0 auto",
    padding: "8px 0",
  },
  adminButton: {
    padding: "8px 14px",
    borderRadius: 999,
    border: "1px solid #237227",
    background: "#237227",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 700,
    position: "absolute",
    right: 16,
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 10,
  },
  staffButton: {
    padding: "8px 14px",
    borderRadius: 999,
    border: "1px solid #0f172a",
    background: "#0f172a",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 700,
    position: "relative",
    zIndex: 10,
  },
  headerContainer: {
    width: "100%",
    background: "#f9fafc",
    borderBottom: "1px solid #eef2f6",
    padding: "30px 0",
    boxShadow: "0 6px 18px rgba(0,0,0,0.03)",
    position: "sticky",
    top: 0,
    zIndex: 100,
  },
  staffGateCard: {
    marginTop: 24,
    padding: "40px 28px",
    borderRadius: 24,
    background: "linear-gradient(180deg, #0f172a 0%, #111827 100%)",
    color: "#e5e7eb",
    textAlign: "center",
    border: "1px solid rgba(255,255,255,0.08)",
    boxShadow: "0 24px 60px rgba(15,23,42,0.25)",
  },
  staffGatePill: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "6px 12px",
    borderRadius: 999,
    background: "rgba(35,114,39,0.16)",
    color: "#86efac",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 14,
  },
  staffGateTitle: {
    margin: 0,
    fontSize: 26,
    lineHeight: 1.2,
    color: "#ffffff",
  },
  staffGateText: {
    maxWidth: 560,
    margin: "14px auto 24px",
    fontSize: 15,
    lineHeight: 1.7,
    color: "#cbd5e1",
  },
  staffGateButton: {
    padding: "12px 22px",
    borderRadius: 999,
    border: "1px solid #237227",
    background: "#237227",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 700,
    boxShadow: "0 12px 30px rgba(35,114,39,0.25)",
  },
};

export default App;
