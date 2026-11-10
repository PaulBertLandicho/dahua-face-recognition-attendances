import React, { useState, useEffect } from "react";
import AdminLogin from "../AdminPage/AdminLogin";
import UserAttendanceScanner from "./UserAttendanceScanner";
import { checkIsMobileDevice } from "../utils/deviceUtils";

export default function DefaultLanding() {
  const [isMobile, setIsMobile] = useState(() => checkIsMobileDevice());

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(checkIsMobileDevice());
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, []);

  // On mobile device (in portrait or rotated landscape) -> show the camera scanner
  if (isMobile) {
    return <UserAttendanceScanner isMobile={true} />;
  }

  // On desktop screen -> only show the login page (no camera)
  return <AdminLogin />;
}
