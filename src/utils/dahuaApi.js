/**
 * Helper to communicate with Dahua backend endpoints safely.
 * Uses a dedicated backend host (REACT_APP_BACKEND_URL) or relative API paths.
 * prevents JSON parsing crashes on empty/HTML responses,
 * and provides clear user-friendly error messages.
 */

export function parseResponseJson(rawText, fallbackStatus = "unknown") {
  if (rawText == null || !String(rawText).trim()) {
    return {};
  }

  const text = String(rawText).trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      error: text.startsWith("<") || text.includes("<html")
        ? `Server returned an HTML response instead of JSON (status: ${fallbackStatus}).`
        : text || `Server returned an invalid JSON response (status: ${fallbackStatus}).`,
    };
  }
}

export async function readJsonResponse(res) {
  const text = await res.text();
  return parseResponseJson(text, String(res.status));
}

function getErrorMessage(error, fallback = "The backend request failed.") {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  if (error && typeof error.error === "string" && error.error.trim()) {
    return error.error;
  }
  if (error && typeof error === "object") {
    if (Object.keys(error).length === 0) return fallback;
    try {
      return JSON.stringify(error);
    } catch (serializationError) {
      return fallback;
    }
  }
  return fallback;
}

export async function fetchDahuaApi(endpoint, options = {}) {
  const configuredBase =
    typeof process !== "undefined" &&
    process.env &&
    process.env.REACT_APP_BACKEND_URL
      ? String(process.env.REACT_APP_BACKEND_URL).trim()
      : "";

  const backendBaseUrl =
    configuredBase.replace(/\/$/, "") ||
    "https://dahua-face-recognition-attendances.onrender.com";
  const baseUrls = [backendBaseUrl];

  let lastError = null;

  for (const base of baseUrls) {
    const fullUrl = `${base}${endpoint}`;
    try {
      const headers = {
        ...(options.headers || {}),
      };
      if (options.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }

      const res = await fetch(fullUrl, {
        ...options,
        headers,
        credentials: "omit",
      });

      const text = await res.text();
      const data = parseResponseJson(text, String(res.status));

      if (!res.ok) {
        const httpError = new Error(
          res.status === 431
            ? "Request was rejected (HTTP 431: Request Header Fields Too Large). Please clear site cookies for this app or open it in an incognito window, then retry."
            :
          getErrorMessage(data, `Request failed with status ${res.status}.`) ||
          `Request failed with status ${res.status}.`
        );
        httpError.isHttpError = true;
        httpError.status = res.status;
        throw httpError;
      }

      return data;
    } catch (err) {
      // HTTP errors should surface immediately; fallback is only for connection-level failures.
      if (err && err.isHttpError) {
        throw err;
      }
      lastError = err;
      // Continue to next candidate URL if connection failed
    }
  }

  const errMsg = getErrorMessage(lastError, "");
  if (
    errMsg.includes("Failed to fetch") ||
    errMsg.includes("NetworkError") ||
    errMsg.includes("ECONNREFUSED") ||
    errMsg.includes("Load failed")
  ) {
    throw new Error(
      "The backend server could not be reached. Start 'node server.js' locally, or configure REACT_APP_BACKEND_URL for the deployed app."
    );
  }

  throw new Error(getErrorMessage(lastError, "Could not connect to backend server."));
}

export async function syncDahuaUsers() {
  return fetchDahuaApi("/api/dahua/sync-users", {
    method: "POST",
  });
}

export async function syncDahuaAttendance(limit = 100) {
  return fetchDahuaApi("/api/dahua/sync-attendance", {
    method: "POST",
    body: JSON.stringify({ limit }),
  });
}

export async function deleteDahuaAttendance(personId, deviceTime) {
  return fetchDahuaApi("/api/dahua/attendance", {
    method: "DELETE",
    body: JSON.stringify({ personId, deviceTime }),
  });
}

export async function getDeviceStatus() {
  return fetchDahuaApi("/api/device/status", {
    method: "GET",
  });
}
