// Utility helpers for face descriptor handling
export function toFloat32Array(desc) {
  if (!desc) return null;
  // If already Float32Array
  if (desc instanceof Float32Array) return desc;
  // If plain array of numbers
  if (Array.isArray(desc)) return new Float32Array(desc);
  // If it's an object with buffer (e.g., typed array serialized), try Array.from
  try {
    if (desc.buffer && typeof desc.length === "number")
      return new Float32Array(Array.from(desc));
  } catch (e) {
    // fallthrough
  }
  // Last resort: try to JSON-parse if it's a string
  if (typeof desc === "string") {
    try {
      const parsed = JSON.parse(desc);
      if (Array.isArray(parsed)) return new Float32Array(parsed);
    } catch (e) {}
  }
  return null;
}

export function normalizeDescriptor(arr) {
  if (!arr) return null;
  const f32 = toFloat32Array(arr);
  if (!f32) return null;
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  const norm = Math.sqrt(sum) || 1.0;
  const out = new Float32Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = f32[i] / norm;
  return out;
}

export function euclideanDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function averageDescriptors(list) {
  if (!list || !list.length) return null;
  const mats = list.map(toFloat32Array).filter(Boolean);
  if (!mats.length) return null;
  const len = mats[0].length;
  for (const m of mats) {
    if (m.length !== len) return null;
  }
  const sum = new Float32Array(len);
  for (const m of mats) {
    for (let i = 0; i < len; i++) sum[i] += m[i];
  }
  const avg = new Float32Array(len);
  const n = mats.length;
  for (let i = 0; i < len; i++) avg[i] = sum[i] / n;
  return normalizeDescriptor(avg);
}

/**
 * Computes standard Eye Aspect Ratio (EAR) given 6 landmark points.
 * @param {Array<{x: number, y: number}>} p - 6 points around an eye
 * @returns {number} EAR value (typically 0.25 - 0.35 when open, < 0.20 when closed)
 */
export function eyeAspectRatio(p) {
  if (!p || p.length < 6) return 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const v1 = dist(p[1], p[5]);
  const v2 = dist(p[2], p[4]);
  const h = dist(p[0], p[3]);
  if (h <= 0) return 0;
  return (v1 + v2) / (2.0 * h);
}

/**
 * Creates an adaptive stateful blink detector for anti-spoofing liveness checks.
 * Learns the user's open-eye baseline EAR dynamically and detects a relative drop + reopen,
 * or absolute threshold drop.
 *
 * @param {Object} [config]
 * @param {number} [config.windowMs=4000]
 * @returns {{ update: (ear: number, now?: number) => boolean, reset: () => void, getState: () => string, getBaseline: () => number }}
 */
export function createBlinkDetector({
  windowMs = 4000,
} = {}) {
  let state = "WAIT_OPEN"; // "WAIT_OPEN" -> "READY_TO_BLINK" -> "CONFIRM_REOPEN" -> "BLINK_CONFIRMED"
  let baselineEar = 0;
  let closeTime = 0;

  return {
    update(ear, now = Date.now()) {
      if (state === "BLINK_CONFIRMED") return true;
      if (!ear || ear <= 0) return false;

      // Initialize or smooth baseline open-eye EAR
      if (baselineEar === 0) {
        baselineEar = Math.max(0.20, Math.min(0.38, ear));
      } else if (ear > baselineEar * 0.85) {
        // Smoothly track open EAR
        baselineEar = Math.max(baselineEar * 0.98, Math.min(0.38, ear));
      }

      // Close threshold is 22% below baseline, or absolute <= 0.20
      const dynamicCloseThreshold = Math.min(0.20, baselineEar * 0.78);
      // Reopen threshold is 86% of baseline, or absolute >= 0.20
      const dynamicOpenThreshold = Math.max(0.20, baselineEar * 0.86);

      if (state === "WAIT_OPEN") {
        if (ear >= dynamicOpenThreshold) {
          state = "READY_TO_BLINK";
        }
      } else if (state === "READY_TO_BLINK") {
        if (ear <= dynamicCloseThreshold) {
          state = "CONFIRM_REOPEN";
          closeTime = now;
        }
      } else if (state === "CONFIRM_REOPEN") {
        if (now - closeTime > 2500) {
          // Eye closed too long (>2.5s), reset to open wait
          state = "WAIT_OPEN";
          closeTime = 0;
        } else if (ear >= dynamicOpenThreshold) {
          state = "BLINK_CONFIRMED";
          return true;
        }
      }

      return state === "BLINK_CONFIRMED";
    },
    reset() {
      state = "WAIT_OPEN";
      baselineEar = 0;
      closeTime = 0;
    },
    getState() {
      return state;
    },
    getBaseline() {
      return baselineEar;
    },
  };
}
