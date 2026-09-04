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

export async function fetchDahuaApi(endpoint, options = {}) {
  const configuredConnector =
    typeof process !== "undefined" &&
    process.env &&
    process.env.REACT_APP_DAHUA_CONNECTOR_URL
      ? String(process.env.REACT_APP_DAHUA_CONNECTOR_URL).trim()
      : "";
  const configuredBase =
    typeof process !== "undefined" &&
    process.env &&
    process.env.REACT_APP_BACKEND_URL
      ? String(process.env.REACT_APP_BACKEND_URL).trim()
      : "";

  // Use explicitly configured endpoints before local development fallbacks.
  const localConnectorUrls = ["http://localhost:4000", "http://127.0.0.1:4000"];
  const isDevelopment = typeof process !== "undefined" && process.env?.NODE_ENV === "development";
  const configuredUrls = [configuredConnector, configuredBase]
    .map((url) => url.replace(/\/$/, ""))
    .filter(Boolean);
  const fallbackUrls = isDevelopment ? localConnectorUrls : [];
  const baseUrls = [...new Set([...configuredUrls, ...fallbackUrls, ""])]
    .filter((base, index, urls) => urls.indexOf(base) === index);

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
          data.error ||
          data.message ||
          `Request failed with status ${res.status}`
        );
        httpError.isHttpError = true;
        httpError.status = res.status;
        throw httpError;
      }

      return data;
    } catch (err) {
      if (err && err.isHttpError) {
        throw err;
      }
      lastError = err;
    }
  }

  const errMsg = lastError?.message || "";
  if (
    errMsg.includes("Failed to fetch") ||
    errMsg.includes("NetworkError") ||
    errMsg.includes("ECONNREFUSED") ||
    errMsg.includes("Load failed")
  ) {
    throw new Error(
      "The Dahua connector could not be reached. Make sure `node server.js` is running on the computer connected to the Dahua device."
    );
  }

  throw lastError || new Error("Could not connect to backend server.");
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

export async function deleteDahuaAttendance(personId, deviceTime, dbId = null) {
  return fetchDahuaApi("/api/dahua/attendance", {
    method: "DELETE",
    body: JSON.stringify({ personId, deviceTime, dbId }),
  });
}

export async function deleteDahuaPerson(personId, hardDelete = false) {
  return fetchDahuaApi("/api/dahua/person", {
    method: "DELETE",
    body: JSON.stringify({ personId, hardDelete }),
  });
}

export async function getDeviceStatus() {
  return fetchDahuaApi("/api/device/status", {
    method: "GET",
  });
}
