import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";

// ✅ Icons
import {
  FiLogOut,
  FiUsers,
  FiHome,
  FiMenu,
  FiCpu,
  FiLock,
  FiChevronDown,
  FiChevronRight,
  FiSliders,
} from "react-icons/fi";
import {
  MdOutlineAccessTime,
  MdSettings,
  MdPayments,
  MdPersonAddAlt1,
  MdBusiness,
  MdHistory,
} from "react-icons/md";

// ✅ Main Navigation Items
const mainNavItems = [
  { label: "Dashboard", path: "/admin/dashboard", icon: <FiHome /> },
  {
    label: "Attendance Records",
    path: "/admin/attendance",
    icon: <MdOutlineAccessTime />,
  },
  { label: "View Payroll", path: "/admin/payroll", icon: <MdPayments /> },
  { label: "Persons", path: "/admin/persons", icon: <FiUsers /> },
  {
    label: "Department rates",
    path: "/admin/department-rates",
    icon: <MdBusiness />,
  },
  {
    label: "Payroll Released Activity Logs",
    path: "/admin/ReleasedPayrollLogs",
    icon: <MdPersonAddAlt1 />,
  },
  {
    label: "Released History Payrolls",
    path: "/admin/released-history",
    icon: <MdHistory />,
  },
];

// ✅ System Settings Sub-Items
const systemSettingsItems = [
  {
    label: "Dahua Device & Sync",
    path: "/admin/device-monitoring",
    icon: <FiCpu />,
  },
  {
    label: "Account Settings",
    path: "/admin/account-settings",
    icon: <FiLock />,
  },
  {
    label: "Work Hours Settings",
    path: "/admin/settings",
    icon: <MdSettings />,
  },
];

export default function AdminSidebar({ onLogout, role }) {
  const navigate = useNavigate();
  const location = useLocation();

  const isSettingsActive = systemSettingsItems.some((item) =>
    location.pathname.startsWith(item.path)
  );

  const [isSystemSettingsOpen, setIsSystemSettingsOpen] = useState(true);

  // Keep settings open if currently inside one of its subpages
  useEffect(() => {
    if (isSettingsActive) {
      setIsSystemSettingsOpen(true);
    }
  }, [isSettingsActive]);

  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= 760 : false
  );

  useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 760);
      if (window.innerWidth > 760) setIsMobileOpen(false);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // close drawer on navigation
  useEffect(() => setIsMobileOpen(false), [location.pathname]);

  return (
    <>
      {/* Mobile Top Bar */}
      {isMobile && (
        <div className="fixed top-3 left-3 right-3 h-14 flex items-center gap-3 z-[120]">
          <button
            aria-label="Open menu"
            onClick={() => setIsMobileOpen(true)}
            className="w-11 h-11 rounded-[10px] bg-[#237227] text-white flex items-center justify-center cursor-pointer text-xl border-none"
          >
            <FiMenu />
          </button>
          <div className="text-base font-bold text-gray-800">Multifactors Sales</div>
        </div>
      )}

      {/* Sidebar */}
      <div
        className={[
          "admin-sidebar flex flex-col fixed left-0 top-0 h-screen max-h-screen bg-white border-r border-gray-200 pt-5 font-sans overflow-hidden",
          isMobile
            ? isMobileOpen
              ? "w-[260px] z-[120] shadow-md"
              : "hidden"
            : "w-[295px] z-[100] shadow-md",
        ].join(" ")}
      >
        <style>{`
          .admin-sidebar button,
          .admin-sidebar button:focus,
          .admin-sidebar button:focus-visible,
          .admin-sidebar button:hover,
          .admin-sidebar button:active {
            transform: none !important;
            outline: none !important;
            box-shadow: none !important;
            -webkit-tap-highlight-color: transparent !important;
          }
          .custom-sidebar-scroll::-webkit-scrollbar {
            width: 4px;
          }
          .custom-sidebar-scroll::-webkit-scrollbar-thumb {
            background-color: #e5e7eb;
            border-radius: 4px;
          }
        `}</style>

        {/* Logo */}
        <div className="flex items-center gap-3 px-6 pb-4 mb-3 border-b border-[#9E9E9E] flex-shrink-0">
          <img
            src={process.env.PUBLIC_URL + "/image/logosidebar.jpg"}
            alt="Multifactors Sales Logo"
            className="w-42 h-auto"
          />
        </div>

        {/* Scrollable Navigation */}
        <div className="flex-1 overflow-y-auto px-4 custom-sidebar-scroll pb-4 space-y-1">
          {/* Main Nav Items */}
          <nav className="flex flex-col gap-1.5">
            {mainNavItems.map((item) => {
              const isActive = location.pathname.startsWith(item.path);

              return (
                <button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className={[
                    "flex items-center gap-3.5 rounded-lg px-4 py-3 text-[15px] font-medium cursor-pointer transition-colors text-left w-full border-none outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 shadow-none",
                    isActive
                      ? "bg-[#237227] text-white shadow-none"
                      : "bg-transparent hover:!bg-gray-50 text-gray-700 hover:text-gray-900",
                  ].join(" ")}
                >
                  <span className="text-[1.3rem] min-w-5 flex items-center">
                    {item.icon}
                  </span>
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* System Settings Section */}
          <div className="pt-3 mt-3 border-t border-gray-100">
            <button
              type="button"
              onClick={() => setIsSystemSettingsOpen(!isSystemSettingsOpen)}
              className="flex items-center justify-between w-full px-3 py-2 text-xs font-bold uppercase tracking-wider text-gray-600 hover:text-gray-900 bg-transparent border-none cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <FiSliders className="text-sm text-[#237227]" />
                System Settings
              </span>
              {isSystemSettingsOpen ? (
                <FiChevronDown className="text-sm" />
              ) : (
                <FiChevronRight className="text-sm" />
              )}
            </button>

            {isSystemSettingsOpen && (
              <div className="flex flex-col gap-1 mt-1 pl-2">
                {systemSettingsItems.map((item) => {
                  const isActive = location.pathname.startsWith(item.path);

                  return (
                    <button
                      key={item.path}
                      onClick={() => navigate(item.path)}
                      className={[
                        "flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium cursor-pointer transition-colors text-left w-full border-none outline-none focus:outline-none focus:ring-0 shadow-none",
                        isActive
                          ? "bg-[#237227] text-white shadow-none font-semibold"
                          : "bg-transparent hover:!bg-gray-50 text-gray-600 hover:text-gray-900",
                      ].join(" ")}
                    >
                      <span className="text-[1.15rem] min-w-5 flex items-center">
                        {item.icon}
                      </span>
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Logout */}
        <div className="p-4 border-t border-gray-100 flex-shrink-0 bg-white">
          <button
            onClick={onLogout}
            className="flex items-center justify-center gap-3 bg-[#666666] hover:bg-red-600 text-white border-none rounded-xl w-full py-3 text-base font-semibold cursor-pointer transition-all duration-200 outline-none focus:outline-none shadow-none hover:shadow-none"
          >
            <FiLogOut className="text-[1.2rem]" />
            <span>Logout</span>
          </button>
        </div>

        {/* Mobile Backdrop */}
        {isMobile && isMobileOpen && (
          <div
            role="button"
            aria-label="Close menu"
            onClick={() => setIsMobileOpen(false)}
            className="fixed inset-0 bg-black/[0.36] z-[119]"
          />
        )}
      </div>
    </>
  );
}
