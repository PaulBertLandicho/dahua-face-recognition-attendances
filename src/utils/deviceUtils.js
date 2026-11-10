/**
 * Utility to reliably detect if the client is on a mobile device or small screen,
 * even when the mobile device is rotated horizontally into landscape mode
 * (where window.innerWidth can exceed 768px).
 */
export function checkIsMobileDevice() {
  if (typeof window === "undefined") return false;

  // 1. Mobile/tablet user-agent pattern check
  const ua = navigator.userAgent || "";
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    ua
  );
  if (isMobileUA) return true;

  // 2. Touch-capable device with mobile screen dimensions (either dimension <= 768px)
  const isTouch = (navigator.maxTouchPoints || 0) > 0;
  const minDimension = Math.min(window.innerWidth, window.innerHeight);
  if (isTouch && minDimension <= 768) return true;

  // 3. Pointer coarse (mobile touch screens)
  const isCoarse =
    window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (isCoarse && minDimension <= 768) return true;

  // 4. Fallback for desktop devtools mobile emulation or narrow browser windows
  return window.innerWidth <= 768;
}
