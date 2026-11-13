import {
  isValidGpsCoords,
  formatGpsCoords,
  shouldAcceptGpsFix,
  createAutoGpsTracker,
} from "./gpsLocation";

describe("gpsLocation utilities", () => {
  const originalGeolocation = navigator.geolocation;
  const originalPermissions = navigator.permissions;
  const originalIsSecureContext = window.isSecureContext;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: originalGeolocation,
    });
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: originalPermissions,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: originalIsSecureContext,
    });
    jest.clearAllMocks();
  });

  test("validates and formats valid coordinates while rejecting non-coordinate strings", () => {
    expect(isValidGpsCoords("14.599500, 120.984200")).toBe(true);
    expect(isValidGpsCoords("Location unavailable")).toBe(false);
    expect(isValidGpsCoords("95.0, 120.0")).toBe(false);
    expect(isValidGpsCoords("")).toBe(false);

    expect(formatGpsCoords(14.59951234, 120.98425678)).toBe(
      "14.599512, 120.984257"
    );
    expect(formatGpsCoords(null, 120.98)).toBeNull();
    expect(formatGpsCoords("invalid", 120.98)).toBeNull();
  });

  test("shouldAcceptGpsFix keeps accurate fix over sudden coarse bounce until stale", () => {
    const now = 100000;
    const tightFix = {
      coords: "14.599500, 120.984200",
      accuracy: 10,
      timestamp: now,
    };
    const coarseBounce = {
      coords: "14.601000, 120.990000",
      accuracy: 1500,
      timestamp: now + 5000,
    };
    const refinedFix = {
      coords: "14.599520, 120.984210",
      accuracy: 8,
      timestamp: now + 5000,
    };
    const staleReplacement = {
      coords: "14.602000, 120.991000",
      accuracy: 250,
      timestamp: now + 50000,
    };

    expect(shouldAcceptGpsFix(tightFix, coarseBounce, 45000)).toBe(false);
    expect(shouldAcceptGpsFix(tightFix, refinedFix, 45000)).toBe(true);
    expect(shouldAcceptGpsFix(tightFix, staleReplacement, 45000)).toBe(true);
  });

  test("auto-falls back on high-accuracy timeout, retries when GPS turns ON, and cleans up on stop", async () => {
    let watchSuccessCb = null;
    const clearWatch = jest.fn();
    let getCurrentCallCount = 0;

    const getCurrentPosition = jest.fn((success, error, opts) => {
      getCurrentCallCount += 1;
      // First high-accuracy call times out -> fallback low-accuracy also unavailable
      if (getCurrentCallCount <= 2) {
        error({ code: opts.enableHighAccuracy ? 3 : 2, message: "GPS off" });
        return;
      }
      // Once GPS turns ON in later auto-retry cycle, succeed with real coordinates
      success({
        coords: {
          latitude: 14.599512,
          longitude: 120.984211,
          accuracy: 12,
        },
        timestamp: Date.now(),
      });
    });

    const watchPosition = jest.fn((success) => {
      watchSuccessCb = success;
      return 77;
    });

    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition, watchPosition, clearWatch },
    });

    const updates = [];
    const tracker = createAutoGpsTracker({
      retryIntervalMs: 3000,
      onChange: (state) => updates.push(state),
    });

    tracker.start();

    // Initially tried high accuracy, fell back to low accuracy, then entered error/retry state
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(updates[0].status).toBe("detecting");
    expect(updates[updates.length - 1].status).toBe("error");
    expect(updates[updates.length - 1].coords).toBe("");
    expect(watchPosition).toHaveBeenCalledTimes(1);

    // Advance past retry interval -> tracker clears stale watch, re-arms watch, and acquires GPS
    jest.advanceTimersByTime(3000);
    expect(clearWatch).toHaveBeenCalledWith(77);
    expect(watchPosition).toHaveBeenCalledTimes(2);
    expect(updates[updates.length - 1]).toEqual({
      status: "ok",
      coords: "14.599512, 120.984211",
      accuracy: 12,
      message: "Auto GPS active",
    });

    // Live watch update improves precision automatically
    watchSuccessCb({
      coords: {
        latitude: 14.5996,
        longitude: 120.9843,
        accuracy: 6,
      },
      timestamp: Date.now() + 2000,
    });
    expect(updates[updates.length - 1].coords).toBe("14.599600, 120.984300");

    const snap = await tracker.getFreshSnapshot({ maxAgeMs: 30000 });
    expect(snap).toBe("14.599600, 120.984300");

    tracker.stop();
    expect(clearWatch).toHaveBeenCalled();
  });

  test("auto-starts GPS recovery when permission changes from denied to granted", async () => {
    const permObj = { state: "denied", onchange: null };
    const query = jest.fn(() => Promise.resolve(permObj));
    const getCurrentPosition = jest.fn((success) => {
      if (permObj.state === "granted") {
        success({
          coords: {
            latitude: 8.4734,
            longitude: 124.6377,
            accuracy: 9,
          },
          timestamp: Date.now(),
        });
      }
    });
    const watchPosition = jest.fn(() => 91);
    const clearWatch = jest.fn();

    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition, watchPosition, clearWatch },
    });

    const updates = [];
    const tracker = createAutoGpsTracker({
      onChange: (state) => updates.push(state),
    });

    tracker.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(updates[updates.length - 1].status).toBe("denied");

    // Simulate user enabling Location permission in browser settings
    permObj.state = "granted";
    permObj.onchange();

    const last = updates[updates.length - 1];
    expect(last.status).toBe("ok");
    expect(last.coords).toBe("8.473400, 124.637700");

    tracker.stop();
  });
});
