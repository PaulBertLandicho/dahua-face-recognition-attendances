import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";

// ✅ Icons
import { FiLogOut, FiUsers, FiHome, FiMenu } from "react-icons/fi";
import {
  MdOutlineAccessTime,
  MdSettings,
  MdPayments,
  MdPersonAddAlt1,
  MdBusiness,
  MdHistory,
} from "react-icons/md";

// ✅ Navigation Items with Icons
const navItems = [
  { label: "Dashboard", path: "/admin/dashboard", icon: <FiHome /> },
  {
    label: "Attendance Records",
    path: "/admin/attendance",
    icon: <MdOutlineAccessTime />,
  },
  {
    label: "Work Hours Settings",
    path: "/admin/settings",
    icon: <MdSettings />,
  },
  { label: "View Payroll", path: "/admin/payroll", icon: <MdPayments /> },
  { label: "Persons", path: "/admin/persons", icon: <FiUsers /> },
  // {
  //   label: "Register Person",
  //   path: "/admin/register-person",
  //   icon: <MdPersonAddAlt1 />,
  // },
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

export default function AdminSidebar({ onLogout }) {
  const navigate = useNavigate();
  const location = useLocation();

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
          "admin-sidebar flex flex-col fixed left-0 top-0 min-h-screen bg-white border-r border-gray-200 pt-5 font-sans",
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
        `}</style>

        {/* Logo */}
        <div className="flex items-center gap-3 px-6 pb-5 mb-6 border-b border-[#9E9E9E]">
          <img
            src={process.env.PUBLIC_URL + "/image/logosidebar.jpg"}
            alt="Multifactors Sales Logo"
            className="w-42 h-auto"
          />
        </div>

        {/* Navigation */}
        <nav className="flex flex-col gap-2 px-4">
          {navItems.map((item) => {
            const isActive = location.pathname.startsWith(item.path);

            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={[
                  "flex items-center gap-3.5 rounded-lg px-5 py-3.5 text-base font-medium cursor-pointer transition-colors text-left w-full border-none outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 shadow-none",
                  isActive
                    ? "bg-[#237227] text-white shadow-none"
                    : "bg-transparent hover:!bg-transparent text-gray-600 hover:text-gray-600",
                ].join(" ")}
              >
                {/* ✅ ICON */}
                <span className="text-[1.4rem] min-w-6 flex items-center">
                  {item.icon}
                </span>

                {/* TEXT */}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Logout */}
        <button
          onClick={onLogout}
          className="flex items-center justify-center gap-3 bg-[#666666] hover:bg-[#666666] text-white border-none rounded-[14px] mx-4 mb-16 py-4 text-[1.1rem] font-semibold cursor-pointer transition-all duration-200 outline-none focus:outline-none shadow-none hover:shadow-none"
        >
          <FiLogOut className="text-[1.4rem]" />
          <span>Logout</span>
        </button>

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
