const DEFAULT_COORD_PRECISION = 6;
const DEFAULT_STALE_MS = 45 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 4 * 1000;

export function isValidGpsCoords(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function formatGpsCoords(
  latitude,
  longitude,
  precision = DEFAULT_COORD_PRECISION
) {
  if (
    latitude === null ||
    latitude === undefined ||
    longitude === null ||
    longitude === undefined ||
    latitude === "" ||
    longitude === ""
  ) {
    return null;
  }

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }

  return `${lat.toFixed(precision)}, ${lng.toFixed(precision)}`;
}

export function shouldAcceptGpsFix(
  currentFix,
  nextFix,
  staleMs = DEFAULT_STALE_MS
) {
  if (!nextFix || !isValidGpsCoords(nextFix.coords)) return false;
  if (!currentFix || !isValidGpsCoords(currentFix.coords)) return true;

  const prevTs = Number(currentFix.timestamp || 0);
  const nextTs = Number(nextFix.timestamp || Date.now());
  if (nextTs - prevTs >= staleMs) return true;

  if (nextFix.accuracy == null || currentFix.accuracy == null) return true;
  return nextFix.accuracy <= Math.max(50, currentFix.accuracy * 1.25);
}

export function classifyGeolocationError(err) {
  const code = err?.code;
  if (code === 1) {
    return {
      status: "denied",
      message:
        "Location permission blocked. Allow Location access in browser settings.",
      retryable: false,
    };
  }
  if (code === 2) {
    return {
      status: "error",
      message:
        "Device GPS is off or unavailable — turn on Location (auto-detecting)...",
      retryable: true,
    };
  }
  if (code === 3) {
    return {
      status: "error",
      message: "Waiting for GPS signal (auto-retrying)...",
      retryable: true,
    };
  }
  return {
    status: "error",
    message: err?.message || "Unable to detect GPS coordinates (auto-retrying)...",
    retryable: true,
  };
}

export function createAutoGpsTracker({
  onChange,
  highAccuracyTimeoutMs = 10000,
  lowAccuracyTimeoutMs = 12000,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  staleMs = DEFAULT_STALE_MS,
} = {}) {
  let disposed = false;
  let currentFix = null;
  let watchId = null;
  let retryTimer = null;
  let fallbackInFlight = false;
  let permissionStatus = null;
  let started = false;

  const emit = (state) => {
    if (disposed || typeof onChange !== "function") return;
    onChange(state);
  };

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const clearWatch = () => {
    if (
      watchId !== null &&
      typeof navigator !== "undefined" &&
      navigator.geolocation?.clearWatch
    ) {
      try {
        navigator.geolocation.clearWatch(watchId);
      } catch (e) {}
    }
    watchId = null;
  };

  const getEnvironmentError = () => {
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      return {
        status: "error",
        message: "Auto GPS requires a secure HTTPS connection or localhost.",
      };
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      return {
        status: "error",
        message: "Geolocation is not supported on this device.",
      };
    }
    return null;
  };

  const applyPosition = (pos) => {
    if (disposed) return null;
    const coords = formatGpsCoords(pos?.coords?.latitude, pos?.coords?.longitude);
    if (!coords) return null;

    const rawAcc = pos?.coords?.accuracy;
    const accuracy =
      typeof rawAcc === "number" && Number.isFinite(rawAcc) && rawAcc >= 0
        ? Math.round(rawAcc)
        : null;

    const nextFix = {
      coords,
      accuracy,
      timestamp:
        typeof pos?.timestamp === "number" && Number.isFinite(pos.timestamp)
          ? pos.timestamp
          : Date.now(),
    };

    clearRetry();

    if (shouldAcceptGpsFix(currentFix, nextFix, staleMs)) {
      currentFix = nextFix;
      emit({
        status: "ok",
        coords: nextFix.coords,
        accuracy: nextFix.accuracy,
        message: "Auto GPS active",
      });
    }

    return currentFix;
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed) return;
      clearWatch();
      requestFix({ silent: true });
      ensureWatch();
    }, retryIntervalMs);
  };

  const handleError = (err, { allowFallback = false } = {}) => {
    if (disposed) return;
    const info = classifyGeolocationError(err);

    if (info.retryable && fallbackInFlight) {
      return;
    }

    if (allowFallback && info.retryable && !fallbackInFlight) {
      fallbackInFlight = true;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          fallbackInFlight = false;
          applyPosition(pos);
        },
        (fallbackErr) => {
          fallbackInFlight = false;
          handleError(fallbackErr, { allowFallback: false });
        },
        {
          enableHighAccuracy: false,
          timeout: lowAccuracyTimeoutMs,
          maximumAge: 60000,
        }
      );
      return;
    }

    if (info.status === "denied") {
      clearWatch();
      clearRetry();
      currentFix = null;
      emit({
        status: "denied",
        coords: "",
        accuracy: null,
        message: info.message,
      });
      return;
    }

    if (!currentFix) {
      emit({
        status: info.status,
        coords: "",
        accuracy: null,
        message: info.message,
      });
    }

    if (info.retryable) {
      scheduleRetry();
    }
  };

  const requestFix = ({ silent = false } = {}) => {
    if (disposed) return;
    const envError = getEnvironmentError();
    if (envError) {
      emit({
        status: envError.status,
        coords: "",
        accuracy: null,
        message: envError.message,
      });
      return;
    }

    if (!silent && !currentFix) {
      emit({
        status: "detecting",
        coords: "",
        accuracy: null,
        message: "Auto-detecting GPS coordinates...",
      });
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => applyPosition(pos),
      (err) => handleError(err, { allowFallback: true }),
      {
        enableHighAccuracy: true,
        timeout: highAccuracyTimeoutMs,
        maximumAge: 10000,
      }
    );
  };

  const ensureWatch = () => {
    if (disposed || watchId !== null) return;
    const envError = getEnvironmentError();
    if (envError || typeof navigator.geolocation.watchPosition !== "function") {
      return;
    }

    watchId = navigator.geolocation.watchPosition(
      (pos) => applyPosition(pos),
      (err) => handleError(err, { allowFallback: true }),
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: Math.max(15000, highAccuracyTimeoutMs),
      }
    );
  };

  const refresh = ({ forceDetecting = false } = {}) => {
    if (disposed) return;
    clearRetry();
    clearWatch();
    if (forceDetecting && !currentFix) {
      emit({
        status: "detecting",
        coords: "",
        accuracy: null,
        message: "Auto-detecting GPS coordinates...",
      });
    }
    requestFix({ silent: !forceDetecting });
    ensureWatch();
  };

  const handleResumeEvent = () => {
    if (disposed) return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const isStale =
      !currentFix || Date.now() - Number(currentFix.timestamp || 0) >= staleMs;
    if (isStale) {
      refresh({ forceDetecting: false });
    }
  };

  const start = () => {
    if (disposed || started) return;
    started = true;

    const envError = getEnvironmentError();
    if (envError) {
      emit({
        status: envError.status,
        coords: "",
        accuracy: null,
        message: envError.message,
      });
      return;
    }

    requestFix({ silent: false });
    ensureWatch();

    if (typeof navigator !== "undefined" && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "geolocation" })
        .then((perm) => {
          if (disposed) return;
          permissionStatus = perm;
          if (perm.state === "denied") {
            clearWatch();
            clearRetry();
            currentFix = null;
            emit({
              status: "denied",
              coords: "",
              accuracy: null,
              message:
                "Location permission blocked. Allow Location access in browser settings.",
            });
          }
          perm.onchange = () => {
            if (disposed) return;
            if (perm.state === "denied") {
              clearWatch();
              clearRetry();
              currentFix = null;
              emit({
                status: "denied",
                coords: "",
                accuracy: null,
                message:
                  "Location permission blocked. Allow Location access in browser settings.",
              });
            } else {
              refresh({ forceDetecting: true });
            }
          };
        })
        .catch(() => {});
    }

    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleResumeEvent);
      window.addEventListener("online", handleResumeEvent);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleResumeEvent);
    }
  };

  const getFreshSnapshot = async ({
    maxAgeMs = 30000,
    timeoutMs = 3500,
  } = {}) => {
    if (
      currentFix &&
      isValidGpsCoords(currentFix.coords) &&
      Date.now() - Number(currentFix.timestamp || 0) <= maxAgeMs
    ) {
      return currentFix.coords;
    }

    const envError = getEnvironmentError();
    if (envError) {
      return currentFix?.coords || null;
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = (coords) => {
        if (settled) return;
        settled = true;
        clearTimeout(guardTimer);
        resolve(coords || currentFix?.coords || null);
      };

      const guardTimer = setTimeout(() => {
        done(currentFix?.coords || null);
      }, timeoutMs);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const updated = applyPosition(pos);
          done(updated?.coords || null);
        },
        () => {
          done(currentFix?.coords || null);
        },
        {
          enableHighAccuracy: false,
          maximumAge: 60000,
          timeout: Math.max(500, timeoutMs - 100),
        }
      );
    });
  };

  const stop = () => {
    if (disposed) return;
    disposed = true;
    clearWatch();
    clearRetry();
    if (permissionStatus) {
      permissionStatus.onchange = null;
      permissionStatus = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", handleResumeEvent);
      window.removeEventListener("online", handleResumeEvent);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleResumeEvent);
    }
  };

  return {
    start,
    stop,
    refresh,
    getCurrentCoords: () => currentFix?.coords || null,
    getFreshSnapshot,
  };
}
