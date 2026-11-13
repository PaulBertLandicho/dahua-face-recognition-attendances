import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useLoading } from "../LoadingContext";
import { supabase } from "../mysqlClient";
import * as XLSX from "xlsx";
import Swal from "sweetalert2";
import { formatAttendanceDateTime } from "../utils/attendanceTime";
import { getStoredSession } from "../utils/authSession";
import {
  FiSearch,
  FiDownload,
  FiRefreshCw,
  FiX,
  FiMapPin,
  FiExternalLink,
  FiCamera,
  FiClock,
  FiEye,
  FiGrid,
  FiList,
  FiCheckCircle,
  FiAlertTriangle,
  FiUsers,
  FiUserCheck,
  FiRotateCw,
  FiFileText,
} from "react-icons/fi";

const OFFLINE_UNVERIFIED_TAG = "[OFFLINE-UNVERIFIED - Pending Review]";

function isOfflineUnverifiedNote(notes) {
  return typeof notes === "string" && notes.includes(OFFLINE_UNVERIFIED_TAG);
}

function formatOfflineReviewedNote(notes, reviewerName = "Staff") {
  const remaining = String(notes || "")
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part && !/^\[offline-unverified/i.test(part));
  const reviewedTag = `[OFFLINE-REVIEWED by ${reviewerName}]`;
  return remaining.length > 0 ? `${reviewedTag} | ${remaining.join(" | ")}` : reviewedTag;
}

// Formatter matching GPS Camera timestamp overlay (e.g. 10.30.2026 06:09 PM)
function formatOverlayDateTime(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12;
  const strHours = String(hours).padStart(2, "0");
  return `${month}.${day}.${year} ${strHours}:${minutes} ${ampm}`;
}

// Formatter for overlay coordinates (e.g. 8.47340, 124.63770)
function formatOverlayCoords(point) {
  if (!point || !point.includes(",")) return point || "No GPS Coordinates";
  const parts = point.split(",").map((s) => s.trim());
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (isNaN(lat) || isNaN(lng)) return point;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

// Helper to rotate an image to permanent orientation via HTML5 canvas
function rotateImageBase64(imageSrc, degrees) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const angle = (degrees * Math.PI) / 180;
        const is90or270 = degrees % 180 !== 0;

        canvas.width = is90or270 ? img.height : img.width;
        canvas.height = is90or270 ? img.width : img.height;

        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(angle);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);

        const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        resolve(dataUrl);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = (err) => reject(err);
    img.src = imageSrc;
  });
}

// Global in-memory cache for reverse-geocoded addresses to avoid duplicate network requests
const geocodeCache = new Map();

// Helper hook to resolve coordinates into structured site location info
function useSiteLocation(coords) {
  const [locationInfo, setLocationInfo] = useState(() => {
    if (!coords || !coords.includes(",")) {
      return {
        shortName: "Field Site Location",
        landmark: "FIELD SITE LOCATION",
        fullAddress: "",
      };
    }
    const trimmed = coords.trim();
    return (
      geocodeCache.get(trimmed) || {
        shortName: "Detecting site location...",
        landmark: "FIELD SITE LOCATION",
        fullAddress: "",
      }
    );
  });

  useEffect(() => {
    if (!coords || !coords.includes(",")) {
      setLocationInfo({
        shortName: "Field Site Location",
        landmark: "FIELD SITE LOCATION",
        fullAddress: "",
      });
      return;
    }

    const trimmed = coords.trim();
    if (geocodeCache.has(trimmed)) {
      setLocationInfo(geocodeCache.get(trimmed));
      return;
    }

    const [lat, lng] = trimmed.split(",").map((s) => s.trim());
    if (!lat || !lng || isNaN(Number(lat)) || isNaN(Number(lng))) {
      setLocationInfo({
        shortName: "Field Site Location",
        landmark: "FIELD SITE LOCATION",
        fullAddress: "",
      });
      return;
    }

    let isMounted = true;
    const fetchLocationName = async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=16&addressdetails=1`;
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            "Accept-Language": "en",
          },
        });

        if (res.ok) {
          const data = await res.json();
          const addr = data?.address || {};
          const landmarkPart =
            addr.amenity ||
            addr.shop ||
            addr.building ||
            addr.school ||
            addr.hospital ||
            addr.office ||
            addr.commercial ||
            addr.retail ||
            addr.road ||
            addr.neighbourhood ||
            addr.suburb;

          const parts = [
            landmarkPart,
            addr.city || addr.town || addr.municipality || addr.village,
            addr.province || addr.state,
          ].filter(Boolean);

          const shortName = parts.length
            ? [...new Set(parts)].join(", ")
            : data?.display_name
            ? data.display_name.split(",").slice(0, 3).join(",")
            : `Site (${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)})`;

          const landmark = (landmarkPart || shortName || "FIELD SITE LOCATION").toUpperCase();
          const fullAddress = data?.display_name || shortName;

          const result = { shortName, landmark, fullAddress };
          geocodeCache.set(trimmed, result);
          if (isMounted) setLocationInfo(result);
        } else {
          const fallback = `Site (${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)})`;
          const result = { shortName: fallback, landmark: fallback.toUpperCase(), fullAddress: fallback };
          geocodeCache.set(trimmed, result);
          if (isMounted) setLocationInfo(result);
        }
      } catch (err) {
        const fallback = `Site (${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)})`;
        const result = { shortName: fallback, landmark: fallback.toUpperCase(), fullAddress: fallback };
        geocodeCache.set(trimmed, result);
        if (isMounted) setLocationInfo(result);
      }
    };

    fetchLocationName();

    return () => {
      isMounted = false;
    };
  }, [coords]);

  return locationInfo;
}

// Field Attendance Card Component (Renders 1 card per punch: single employee or group)
function FieldAttendanceCard({ card, index, openPhotoModal, persons, onMarkReviewed }) {
  const isGroup = card.members && card.members.length > 1;
  const isTimeIn = card.event === "time-in";
  const photoSrc = card.photo;
  const siteLocationInfo = useSiteLocation(card.point);
  const siteLocationName = siteLocationInfo?.shortName || "Detecting site location...";

  // Extract separate lat and long
  let lat = "";
  let lng = "";
  if (card.point && card.point.includes(",")) {
    const parts = card.point.split(",").map((s) => s.trim());
    lat = parts[0] || "";
    lng = parts[1] || "";
  }

  const mapsUrl = card.point
    ? `https://www.google.com/maps?q=${encodeURIComponent(card.point)}`
    : null;

  // Enrich members with persons data (avatar, name, department)
  const memberDetails = (card.members || []).map((m) => {
    const p = persons.find((x) => String(x.id) === String(m.person_id)) || {};
    return {
      ...m,
      name: m.name || p.name || `Employee #${m.person_id}`,
      department: m.department || p.department || "General",
      registration_photo: p.registration_photo || null,
    };
  });

  const unverifiedMembers = (card.members || []).filter((m) => isOfflineUnverifiedNote(m.notes));
  const isOfflineUnverified = unverifiedMembers.length > 0 || isOfflineUnverifiedNote(card.notes);

  const memberNames = memberDetails.map((m) => m.name).join(", ");
  const uniqueDepts = Array.from(new Set(memberDetails.map((m) => m.department))).join(", ");
  const displayTitle = `${memberNames} — ${isTimeIn ? "Time In" : "Time Out"} Store Proof`;

  return (
    <div className="bg-white rounded-2xl border border-gray-200/90 shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col justify-between group">
      <div>
        {/* Cover Image Container (16:10 aspect ratio) */}
        <div
          className="relative aspect-[16/10] overflow-hidden bg-gray-950 cursor-pointer"
          onClick={() =>
            openPhotoModal(photoSrc, displayTitle, card, siteLocationInfo, memberDetails)
          }
        >
          {photoSrc ? (
            <img
              src={photoSrc}
              alt="Store proof"
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-gray-500">
              <FiCamera className="text-3xl mb-1 text-gray-400" />
              <span className="text-xs">No Store Image</span>
            </div>
          )}

          {/* Top Left Overlay: Event Badge (TIME IN / TIME OUT) */}
          <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5">
            {isTimeIn ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-wider bg-emerald-500 text-white shadow-md">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                TIME IN
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-wider bg-blue-600 text-white shadow-md">
                <span className="w-2 h-2 rounded-full bg-white"></span>
                TIME OUT
              </span>
            )}
          </div>

          {/* Top Right Overlay: Sequence & Group Badge */}
          <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5">
            {isGroup && (
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#237227]/90 text-white backdrop-blur-md shadow-sm">
                <FiUsers className="text-[10px]" />
                <span>Group ({card.members.length})</span>
              </span>
            )}
            <span className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-black/60 text-white backdrop-blur-md shadow-sm font-mono">
              #{index + 1}
            </span>
          </div>
        </div>

        {/* Card Body */}
        <div className="p-4 flex flex-col gap-3">
          {/* Employee Header (Avatar + Name + Site Location Name) */}
          <div className="flex items-start gap-3">
            {isGroup ? (
              /* Overlapping Avatars for Group */
              <div className="flex -space-x-2.5 overflow-hidden flex-shrink-0 pt-0.5">
                {memberDetails.slice(0, 4).map((m, mIdx) =>
                  m.registration_photo ? (
                    <img
                      key={m.id || mIdx}
                      src={m.registration_photo}
                      alt={m.name}
                      title={m.name}
                      className="inline-block w-10 h-10 rounded-full object-cover ring-2 ring-white shadow-sm"
                    />
                  ) : (
                    <div
                      key={m.id || mIdx}
                      title={m.name}
                      className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[#e8f5e9] text-[#237227] font-bold text-xs ring-2 ring-white shadow-sm"
                    >
                      {m.name.charAt(0)}
                    </div>
                  )
                )}
                {memberDetails.length > 4 && (
                  <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-gray-200 text-gray-700 font-bold text-xs ring-2 ring-white shadow-sm">
                    +{memberDetails.length - 4}
                  </div>
                )}
              </div>
            ) : (
              /* Single Avatar for Individual */
              memberDetails[0]?.registration_photo ? (
                <img
                  src={memberDetails[0].registration_photo}
                  alt={memberDetails[0].name}
                  className="w-10 h-10 rounded-full object-cover border border-gray-200 shadow-sm flex-shrink-0"
                />
              ) : (
                <div className="w-10 h-10 rounded-full bg-[#e8f5e9] text-[#237227] font-bold flex items-center justify-center text-sm shadow-sm flex-shrink-0">
                  {(memberDetails[0]?.name || "E").charAt(0)}
                </div>
              )
            )}

            <div className="min-w-0 flex-1">
              <div className="font-bold text-gray-900 text-sm leading-tight flex items-center gap-1">
                <span className="truncate" title={memberNames}>
                  {memberNames}
                </span>
                {isOfflineUnverified ? (
                  <FiAlertTriangle
                    className="text-amber-500 text-xs flex-shrink-0"
                    title="Offline Unverified — Pending Review"
                  />
                ) : (
                  <FiCheckCircle
                    className="text-emerald-600 text-xs flex-shrink-0"
                    title={isGroup ? "Verified Group Attendance" : "Verified Attendance"}
                  />
                )}
              </div>

              {/* Site Location Name with Pin */}
              <div className="text-xs text-gray-500 flex items-center gap-1 mt-1 font-medium">
                <FiMapPin className="text-[#237227] text-xs flex-shrink-0" />
                <span className="truncate" title={siteLocationName}>
                  {siteLocationName}
                </span>
              </div>
            </div>
          </div>

          {isOfflineUnverified && (
            <div className="flex items-center justify-between gap-2 text-xs bg-amber-50 px-2.5 py-1.5 rounded-lg border border-amber-200">
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-800">
                <FiAlertTriangle className="text-amber-600 shrink-0" />
                Offline Unverified (Pending Review)
              </span>
              {typeof onMarkReviewed === "function" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMarkReviewed(
                      unverifiedMembers.length > 0 ? unverifiedMembers : [card],
                      memberNames
                    );
                  }}
                  className="px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-bold border-none cursor-pointer transition-colors shrink-0"
                >
                  Mark Reviewed
                </button>
              )}
            </div>
          )}

          {/* Group Partner Chips */}
          {isGroup && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {memberDetails.map((m) => (
                <span
                  key={m.id || m.person_id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-gray-100 text-gray-800 border border-gray-200"
                >
                  <FiUserCheck className="text-[10px] text-[#237227]" />
                  <span>{m.name}</span>
                </span>
              ))}
            </div>
          )}

          {/* Detailed Labels & Metadata */}
          <div className="space-y-2 pt-1 border-t border-gray-100">
            {/* Date & Time */}
            <div className="flex items-center justify-between text-xs bg-gray-50 px-2.5 py-1.5 rounded-lg border border-gray-100">
              <span className="text-gray-500 font-semibold flex items-center gap-1">
                <FiClock className="text-gray-400 text-xs" /> Date & Time:
              </span>
              <span className="font-semibold text-gray-800 text-[11px]">
                {card.device_time
                  ? formatAttendanceDateTime(card.device_time)
                  : "N/A"}
              </span>
            </div>

            {/* Coordinates: Longitude & Latitude */}
            <div className="flex flex-col gap-1 text-xs bg-gray-50 px-2.5 py-1.5 rounded-lg border border-gray-100">
              <div className="flex items-center justify-between">
                <span className="text-gray-500 font-semibold text-[11px]">
                  Coordinates:
                </span>
                <span className="text-[10px] text-gray-400 font-mono">WGS84</span>
              </div>
              <div className="flex items-center justify-between font-mono text-[11px] text-gray-700">
                <span>
                  <strong className="text-gray-900 font-sans">Lat:</strong>{" "}
                  {lat ? Number(lat).toFixed(6) : "N/A"}
                </span>
                <span>
                  <strong className="text-gray-900 font-sans">Long:</strong>{" "}
                  {lng ? Number(lng).toFixed(6) : "N/A"}
                </span>
              </div>
            </div>

            {/* Description / Store Note */}
            {card.notes && (
              <div
                className={`flex items-start gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border ${
                  isOfflineUnverified
                    ? "bg-amber-50/60 border-amber-100"
                    : "bg-emerald-50/60 border-emerald-100"
                }`}
              >
                <FiFileText
                  className={`${
                    isOfflineUnverified ? "text-amber-700" : "text-emerald-700"
                  } text-xs mt-0.5 shrink-0`}
                />
                <span className="text-[11px] text-gray-700 italic break-words line-clamp-2">
                  <strong
                    className={`${
                      isOfflineUnverified ? "text-amber-900" : "text-emerald-900"
                    } not-italic font-semibold`}
                  >
                    Note:
                  </strong>{" "}
                  {card.notes}
                </span>
              </div>
            )}

            {/* Department & Method */}
            <div className="flex items-center justify-between text-xs pt-0.5">
              <span
                className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold bg-gray-100 text-gray-700 truncate max-w-[170px]"
                title={uniqueDepts}
              >
                {uniqueDepts || "General"}
              </span>
              <span className="text-gray-400 text-[11px]">
                {isGroup
                  ? `field-site (${card.members.length} partners)`
                  : (card.method || "field-site")}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Card Footer Actions */}
      <div className="p-3 px-4 bg-[#fafbfa] border-t border-gray-100 flex items-center justify-between gap-2">
        {mapsUrl ? (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 transition-colors"
          >
            <FiMapPin className="text-xs" />
            <span>Google Maps</span>
            <FiExternalLink className="text-[10px]" />
          </a>
        ) : (
          <span className="text-xs text-gray-400 italic">No GPS</span>
        )}

        <button
          type="button"
          onClick={() =>
            openPhotoModal(photoSrc, displayTitle, card, siteLocationInfo, memberDetails)
          }
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-[#237227] bg-[#f0f7f0] hover:bg-[#e0efe0] border border-[#c3e3c3] cursor-pointer transition-colors"
        >
          <FiEye className="text-xs" />
          <span>View Proof</span>
        </button>
      </div>
    </div>
  );
}

// High-Resolution Fullscreen Photo Overlay Lightbox Modal
function PhotoOverlayModal({ photoModal, onClose, onUpdatePhoto }) {
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const [skipTransition, setSkipTransition] = useState(false);
  const [currentSrc, setCurrentSrc] = useState(photoModal.src);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [imgError, setImgError] = useState(false);
  const imageViewportRef = useRef(null);
  const imgRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const resolvedLocation = useSiteLocation(photoModal.record?.point);

  useEffect(() => {
    setCurrentSrc(photoModal.src);
    setRotation(0);
    setZoom(1);
    setImgError(false);
    setNaturalSize({ width: 0, height: 0 });
  }, [photoModal.src]);

  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      setNaturalSize({
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    }
  }, [currentSrc]);

  // Measure available fullscreen viewport area so small images scale up cleanly
  useEffect(() => {
    const el = imageViewportRef.current;
    if (!el) return;

    const updateViewport = () => {
      setViewportSize({
        width: el.clientWidth,
        height: el.clientHeight,
      });
    };

    updateViewport();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateViewport);
      observer.observe(el);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  // Lock page scroll and allow Escape to close fullscreen viewer
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        onCloseRef.current?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Mouse wheel scroll to zoom in & zoom out
  useEffect(() => {
    const el = imageViewportRef.current;
    if (!el) return;

    const handleWheel = (e) => {
      e.preventDefault();
      setZoom((prevZoom) => {
        // e.deltaY < 0 is scroll up (zoom in), e.deltaY > 0 is scroll down (zoom out)
        const step = 0.2;
        let nextZoom = e.deltaY < 0 ? prevZoom + step : prevZoom - step;
        if (nextZoom < 1) nextZoom = 1;
        if (nextZoom > 4) nextZoom = 4;
        return Number(nextZoom.toFixed(2));
      });
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const landmark =
    resolvedLocation?.landmark ||
    photoModal.locationInfo?.landmark ||
    (photoModal.locationName ? photoModal.locationName.toUpperCase() : "FIELD SITE LOCATION");
  const fullAddress =
    resolvedLocation?.fullAddress ||
    photoModal.locationInfo?.fullAddress ||
    photoModal.locationName ||
    "";
  const formattedDateTime = formatOverlayDateTime(photoModal.record?.device_time);
  const formattedCoords = formatOverlayCoords(photoModal.record?.point);
  const isTimeIn = photoModal.record?.event === "time-in";
  const mapsUrl = photoModal.record?.point
    ? `https://www.google.com/maps?q=${encodeURIComponent(photoModal.record.point)}`
    : null;

  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const isRotated90 = normalizedRotation % 180 !== 0;
  const effW = isRotated90 ? naturalSize.height : naturalSize.width;
  const effH = isRotated90 ? naturalSize.width : naturalSize.height;

  let frameW = null;
  let frameH = null;
  if (
    viewportSize.width > 0 &&
    viewportSize.height > 0 &&
    effW > 0 &&
    effH > 0
  ) {
    const fitScale = Math.min(
      viewportSize.width / effW,
      viewportSize.height / effH
    );
    const baseW = Math.max(1, Math.round(effW * fitScale));
    const baseH = Math.max(1, Math.round(effH * fitScale));
    frameW = Math.max(1, Math.round(baseW * zoom));
    frameH = Math.max(1, Math.round(baseH * zoom));
  }

  const imgW = frameW && frameH ? (isRotated90 ? frameH : frameW) : null;
  const imgH = frameW && frameH ? (isRotated90 ? frameW : frameH) : null;

  // Handle Save Rotated Photo Position (Keeps photo completely steady with zero visual jumps)
  const handleSavePosition = async () => {
    if (normalizedRotation === 0) return;
    try {
      setSaving(true);
      const rotatedBase64 = await rotateImageBase64(currentSrc, normalizedRotation);

      // Preload image into memory so it renders instantly without flicker
      const preImg = new Image();
      preImg.src = rotatedBase64;
      if (preImg.decode) {
        await preImg.decode().catch(() => {});
      }

      // Determine target database IDs (all member IDs if group, or single record ID)
      const targetIds =
        photoModal.memberDetails && photoModal.memberDetails.length > 0
          ? photoModal.memberDetails.map((m) => m.id).filter(Boolean)
          : [photoModal.record?.id].filter(Boolean);

      if (onUpdatePhoto) {
        await onUpdatePhoto(rotatedBase64, targetIds);
      }

      // Freeze transform transition so the image stays rock-steady without spinning back
      setSkipTransition(true);
      if (preImg.naturalWidth && preImg.naturalHeight) {
        setNaturalSize({
          width: preImg.naturalWidth,
          height: preImg.naturalHeight,
        });
      }
      setCurrentSrc(rotatedBase64);
      setRotation(0);

      // Restore transition for future manual user rotates
      requestAnimationFrame(() => {
        setTimeout(() => setSkipTransition(false), 60);
      });
    } catch (err) {
      console.error("Error saving rotated position:", err);
      Swal.fire({
        icon: "error",
        title: "Save Failed",
        text: err.message || "Could not save rotated image.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[10000] w-screen h-screen bg-black flex flex-col overflow-hidden"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full h-full flex flex-col bg-neutral-950 overflow-hidden"
      >
        {/* Fullscreen Top Bar */}
        <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-2.5 sm:py-3 bg-white border-b border-gray-200 shrink-0 z-30">
          <div className="flex items-center gap-2.5 min-w-0 pr-2">
            <h3 className="font-bold text-gray-900 text-sm sm:text-base m-0 truncate">
              {photoModal.title || "Store Image Proof"}
            </h3>
            <span
              className={`text-[10px] font-extrabold uppercase px-2.5 py-0.5 rounded-full flex-shrink-0 ${
                isTimeIn
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-blue-50 text-blue-700 border border-blue-200"
              }`}
            >
              {isTimeIn ? "Time In" : "Time Out"}
            </span>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Zoom Controls */}
            <div className="hidden sm:inline-flex items-center rounded-xl bg-gray-100 border border-gray-200 overflow-hidden">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(1, Number((z - 0.25).toFixed(2))))}
                disabled={zoom <= 1}
                title="Zoom out"
                className="px-2 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer bg-transparent border-none"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                title="Reset zoom to 100%"
                className="px-2 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-200 cursor-pointer bg-transparent border-none min-w-[46px]"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2))))}
                disabled={zoom >= 4}
                title="Zoom in"
                className="px-2 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer bg-transparent border-none"
              >
                +
              </button>
            </div>

            {zoom > 1 && (
              <button
                type="button"
                onClick={() => setZoom(1)}
                title="Reset zoom to 100%"
                className="sm:hidden px-2.5 py-1.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-bold transition-colors cursor-pointer border border-gray-200 flex items-center gap-1"
              >
                <span>{Math.round(zoom * 100)}%</span>
                <span className="text-[10px] text-gray-400 font-normal">Reset</span>
              </button>
            )}

            {/* Rotate Button (No degree text) */}
            <button
              type="button"
              onClick={() => setRotation((r) => r + 90)}
              title="Rotate image 90° clockwise"
              className="px-3 py-1.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer border border-gray-200"
            >
              <FiRotateCw className="text-xs" />
              <span>Rotate</span>
            </button>

            {/* Save Button (Appears when rotated) */}
            {normalizedRotation !== 0 && (
              <button
                type="button"
                onClick={handleSavePosition}
                disabled={saving}
                title="Save rotated image permanently"
                className="px-4 py-1.5 rounded-xl bg-[#237227] hover:bg-[#1a541c] text-white text-xs font-bold transition-all cursor-pointer shadow-sm active:scale-[0.98] disabled:opacity-50 border-none"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            )}

            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-bold flex items-center gap-1.5 transition-colors border border-blue-200"
              >
                <FiMapPin className="text-xs" />
                <span className="hidden sm:inline">Google Maps</span>
                <FiExternalLink className="text-[10px]" />
              </a>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-600 flex items-center justify-center text-lg font-bold transition-colors cursor-pointer border border-gray-200"
            >
              ×
            </button>
          </div>
        </div>

        {/* Fullscreen Image Viewport with Mouse Wheel Zoom */}
        <div
          ref={imageViewportRef}
          onClick={(e) => {
            if (e.target === imageViewportRef.current && zoom === 1) {
              onClose();
            }
          }}
          className="relative flex-1 w-full min-h-0 bg-neutral-950 flex overflow-auto select-none"
          title="Scroll mouse wheel over photo to zoom in/out, double click to reset zoom"
        >
          {imgError || !currentSrc ? (
            <div className="m-auto flex flex-col items-center justify-center text-gray-400 gap-2 p-6">
              <FiCamera className="text-4xl text-gray-500" />
              <span className="text-sm font-medium">Unable to load store proof image</span>
            </div>
          ) : (
            <div
              style={
                frameW && frameH
                  ? { width: `${frameW}px`, height: `${frameH}px` }
                  : { width: "100%", height: "100%" }
              }
              className="relative m-auto shrink-0 overflow-hidden bg-black shadow-2xl"
            >
              {/* The Captured Store Photo scaled to fill the fullscreen viewport */}
              <img
                ref={imgRef}
                src={currentSrc}
                alt="Store proof with overlay"
                onLoad={(e) => {
                  const { naturalWidth, naturalHeight } = e.currentTarget;
                  if (naturalWidth && naturalHeight) {
                    setNaturalSize({
                      width: naturalWidth,
                      height: naturalHeight,
                    });
                  }
                }}
                onError={() => setImgError(true)}
                onDoubleClick={() => setZoom((z) => (z > 1 ? 1 : 2))}
                draggable={false}
                style={
                  imgW && imgH
                    ? {
                        position: "absolute",
                        top: "50%",
                        left: "50%",
                        width: `${imgW}px`,
                        height: `${imgH}px`,
                        maxWidth: "none",
                        maxHeight: "none",
                        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                        transformOrigin: "center center",
                        transition: skipTransition ? "none" : "transform 0.2s ease-out",
                        cursor: zoom > 1 ? "zoom-out" : "zoom-in",
                      }
                    : {
                        width: "100%",
                        height: "100%",
                        transform: `rotate(${rotation}deg) scale(${zoom})`,
                        transformOrigin: "center center",
                        transition: skipTransition ? "none" : "transform 0.2s ease-out",
                        cursor: zoom > 1 ? "zoom-out" : "zoom-in",
                      }
                }
                className={
                  imgW && imgH
                    ? "block select-none"
                    : "w-full h-full object-contain block select-none"
                }
              />

              {/* TOP OVERLAYS: Event Badge, Group Count & Watermark (flex layout prevents overlap) */}
              <div className="absolute top-3 inset-x-3 z-20 pointer-events-none flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-wider text-white shadow-lg backdrop-blur-sm ${
                      isTimeIn
                        ? "bg-emerald-600/90 border border-emerald-400/30"
                        : "bg-blue-600/90 border border-blue-400/30"
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                    {isTimeIn ? "TIME IN" : "TIME OUT"}
                  </span>

                  {photoModal.memberDetails && photoModal.memberDetails.length > 1 && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-black/60 backdrop-blur-sm text-white border border-white/20 shadow-md">
                      <FiUsers className="text-[10px] text-emerald-400" />
                      <span>Group ({photoModal.memberDetails.length})</span>
                    </span>
                  )}
                </div>

                <div className="bg-black/60 backdrop-blur-sm text-white px-2.5 py-1 rounded-md border border-white/15 flex items-center gap-1.5 shadow-md text-[10px] font-sans whitespace-nowrap">
                  <span className="w-2 h-2 rounded-full bg-[#237227] ring-2 ring-white/60 shrink-0"></span>
                  <span className="font-bold tracking-wide">Multifactors Sales Attendance</span>
                  <span className="text-gray-400">|</span>
                  <span className="text-gray-300">Field GPS Proof</span>
                </div>
              </div>

              {/* BOTTOM-LEFT OVERLAY: Compact Details Box */}
              <div className="absolute bottom-3 left-3 sm:bottom-4 sm:left-4 z-20 max-w-[calc(100%-1.5rem)] sm:max-w-sm bg-black/60 backdrop-blur-sm text-white p-2.5 sm:p-3.5 rounded-xl border border-white/20 shadow-2xl flex flex-col gap-0.5 text-left pointer-events-none">
                {/* Logo */}
                <div className="mb-0.5 flex items-center">
                  <img
                    src="/image/logo/multifactors_overlay_logo.png"
                    alt="Multifactors Sales Attendance"
                    className="h-5 sm:h-6 object-contain bg-white/95 px-2 py-0.5 rounded shadow-sm"
                  />
                </div>

                {/* Company Name */}
                <div className="text-[11px] font-bold text-gray-300 tracking-wider">
                  Multifactors Sales
                </div>

                {/* Site Location Name in Bold Uppercase */}
                <div className="text-xs sm:text-sm font-black text-white tracking-wider uppercase leading-tight font-sans drop-shadow-sm">
                  {landmark}
                </div>

                {/* Formatted Date & Time (MM.DD.YYYY hh:mm A) */}
                <div className="text-[11px] sm:text-xs font-mono text-gray-200 tracking-wide">
                  {formattedDateTime}
                </div>

                {/* GPS Coordinates (Lat, Long) */}
                {photoModal.record?.point && (
                  <div className="text-[11px] sm:text-xs font-mono text-emerald-400 font-bold tracking-wide">
                    {formattedCoords}
                  </div>
                )}

                {/* Detailed Address */}
                {fullAddress && (
                  <div className="text-[10px] sm:text-[11px] text-gray-300 font-sans leading-snug line-clamp-2 max-w-sm">
                    {fullAddress}
                  </div>
                )}

                {/* Offline Unverified Warning & Note */}
                {isOfflineUnverifiedNote(photoModal.record?.notes) && (
                  <div className="inline-flex items-center gap-1.5 text-[10px] sm:text-[11px] font-bold text-amber-200 bg-amber-950/70 border border-amber-400/50 rounded-md px-2 py-0.5 mt-0.5">
                    <FiAlertTriangle className="text-amber-300 shrink-0 text-xs" />
                    <span>Offline Unverified — Pending Review</span>
                  </div>
                )}

                {/* Description / Store Note */}
                {photoModal.record?.notes && (
                  <div className="text-[10px] sm:text-[11px] text-emerald-200 font-sans italic leading-snug line-clamp-2 max-w-sm pt-1 mt-0.5 border-t border-white/10 flex items-start gap-1">
                    <FiFileText className="text-emerald-400 mt-0.5 shrink-0 text-xs" />
                    <span>
                      <strong className="text-white not-italic font-semibold">Note:</strong> {photoModal.record.notes}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Fullscreen Bottom: Partner Chips (if group punch) */}
        {photoModal.memberDetails && photoModal.memberDetails.length > 1 && (
          <div className="px-4 sm:px-6 py-2.5 bg-white border-t border-gray-200 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0 z-30">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-gray-600 font-bold flex items-center gap-1">
                <FiUsers className="text-[#237227]" /> Group Partners ({photoModal.memberDetails.length}):
              </span>
              {photoModal.memberDetails.map((m) => (
                <span
                  key={m.id || m.person_id}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-gray-50 text-gray-800 border border-gray-200 shadow-sm"
                >
                  <FiUserCheck className="text-emerald-600 text-xs" />
                  <span>{m.name}</span>
                  <span className="text-gray-400 text-[10px]">({m.department})</span>
                </span>
              ))}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="py-1.5 px-4 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-bold transition-colors cursor-pointer border border-gray-200 ml-auto"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function FieldAttendanceTable() {
  const [records, setRecords] = useState([]);
  const [persons, setPersons] = useState([]);
  const [search, setSearch] = useState("");
  const [eventFilter, setEventFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [sortOrder, setSortOrder] = useState("desc");
  const [viewMode, setViewMode] = useState("cards"); // 'cards' (default) or 'table'
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 12; // 12 cards fits in a 4-column responsive grid
  const [refreshing, setRefreshing] = useState(false);
  const [photoModal, setPhotoModal] = useState({
    visible: false,
    src: "",
    title: "",
    record: null,
    locationName: "",
    memberDetails: [],
  });

  const { setLoading } = useLoading();

  const fetchData = useCallback(async (isManualRefresh = false) => {
    try {
      if (isManualRefresh) setRefreshing(true);
      else setLoading(true);

      let { data: attData, error: attErr } = await supabase
        .from("attendance")
        .select("id, person_id, name, department, event, method, point, device_time, status, photo, archived, notes")
        .order("device_time", { ascending: false });

      if (attErr && String(attErr?.message || "").includes("notes")) {
        const fallback = await supabase
          .from("attendance")
          .select("id, person_id, name, department, event, method, point, device_time, status, photo, archived")
          .order("device_time", { ascending: false });
        attData = fallback.data;
        attErr = fallback.error;
      }

      if (attErr) throw attErr;

      // Filter: Strictly ONLY render records with captured store image proofs (photo)
      // Exclude terminal biometric "face" scans
      const validRecords = (attData || []).filter((row) => {
        const isFaceMethod = String(row.method || "").toLowerCase() === "face";
        const hasStorePhoto = Boolean(row.photo);
        return row.person_id && !row.archived && hasStorePhoto && !isFaceMethod;
      });

      setRecords(validRecords);

      const { data: personsData, error: personsErr } = await supabase
        .from("persons")
        .select("id, name, department, registration_photo");

      if (personsErr) throw personsErr;
      setPersons(personsData || []);

      if (isManualRefresh) {
        Swal.fire({
          toast: true,
          position: "top-end",
          icon: "success",
          title: "Field site attendance records updated",
          showConfirmButton: false,
          timer: 2000,
          timerProgressBar: true,
          iconColor: "#237227",
        });
      }
    } catch (err) {
      console.error("Error fetching field attendance:", err);
      Swal.fire({
        toast: true,
        position: "top-end",
        icon: "error",
        title: err.message || "Failed to load field attendance",
        showConfirmButton: false,
        timer: 3000,
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [setLoading]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    setCurrentPage(1);
  }, [search, eventFilter, departmentFilter, selectedDate, sortOrder, viewMode]);

  // Filtered records
  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();

    return records.filter((row) => {
      const isFaceMethod = String(row.method || "").toLowerCase() === "face";
      if (!row.photo || isFaceMethod) return false;

      const person = persons.find((p) => String(p.id) === String(row.person_id)) || {};
      const empName = (row.name || person.name || "").toLowerCase();
      const empId = String(row.person_id || "").toLowerCase();
      const dept = (row.department || person.department || "").toLowerCase();

      if (q && !empName.includes(q) && !empId.includes(q) && !dept.includes(q)) {
        return false;
      }

      if (eventFilter && row.event !== eventFilter) return false;
      if (departmentFilter && (row.department || person.department) !== departmentFilter) return false;
      if (selectedDate && row.device_time) {
        const rowDate = new Date(row.device_time).toISOString().slice(0, 10);
        if (rowDate !== selectedDate) return false;
      }

      return true;
    });
  }, [records, persons, search, eventFilter, departmentFilter, selectedDate]);

  const sortedRecords = useMemo(() => {
    return [...filteredRecords].sort((a, b) => {
      const timeA = a.device_time ? new Date(a.device_time).getTime() : 0;
      const timeB = b.device_time ? new Date(b.device_time).getTime() : 0;
      return sortOrder === "asc" ? timeA - timeB : timeB - timeA;
    });
  }, [filteredRecords, sortOrder]);

  // Group all valid records by shared store proof punch for the Cards View
  // Rule: If a group punched together, only 1 card will render!
  const allCardGroups = useMemo(() => {
    const groups = [];

    for (const row of records) {
      if (!row.photo) continue;
      const rowTime = row.device_time ? new Date(row.device_time).getTime() : 0;

      // Match punch group by:
      // 1. Same store photo proof + same event + within 5 minutes
      // (Do NOT strictly compare point string because micro GPS drift causes slight decimal differences e.g. 8.224548 vs 8.224540)
      const matched = groups.find((grp) => {
        if (grp.photo !== row.photo) return false;
        if (grp.event !== row.event) return false;
        const grpTime = grp.device_time ? new Date(grp.device_time).getTime() : 0;
        return Math.abs(grpTime - rowTime) <= 300000; // 5 minute window
      });

      if (matched) {
        const alreadyHasPerson = matched.members.some(
          (m) => String(m.person_id) === String(row.person_id)
        );
        if (!alreadyHasPerson) {
          matched.members.push(row);
        }
        // If the first record didn't have GPS point, use row's GPS point
        if (!matched.point && row.point) {
          matched.point = row.point;
        }
        if (!matched.notes && (row.notes || row.remarks)) {
          matched.notes = row.notes || row.remarks;
        }
      } else {
        groups.push({
          id: row.id,
          photo: row.photo,
          event: row.event,
          device_time: row.device_time,
          point: row.point,
          notes: row.notes || row.remarks || null,
          method: row.method || "field-site",
          members: [row],
        });
      }
    }

    return groups;
  }, [records]);

  // Filter punch cards
  const filteredCardGroups = useMemo(() => {
    const q = search.trim().toLowerCase();

    return allCardGroups.filter((card) => {
      // 1. Search query: checks if ANY member's name, ID, or department matches
      if (q) {
        const matchesMember = card.members.some((m) => {
          const person = persons.find((p) => String(p.id) === String(m.person_id)) || {};
          const empName = (m.name || person.name || "").toLowerCase();
          const empId = String(m.person_id || "").toLowerCase();
          const dept = (m.department || person.department || "").toLowerCase();
          return empName.includes(q) || empId.includes(q) || dept.includes(q);
        });
        if (!matchesMember) return false;
      }

      // 2. Event filter
      if (eventFilter && card.event !== eventFilter) return false;

      // 3. Department filter: checks if ANY member belongs to the filtered department
      if (departmentFilter) {
        const matchesDept = card.members.some((m) => {
          const person = persons.find((p) => String(p.id) === String(m.person_id)) || {};
          return (m.department || person.department) === departmentFilter;
        });
        if (!matchesDept) return false;
      }

      // 4. Date filter
      if (selectedDate && card.device_time) {
        const rowDate = new Date(card.device_time).toISOString().slice(0, 10);
        if (rowDate !== selectedDate) return false;
      }

      return true;
    });
  }, [allCardGroups, persons, search, eventFilter, departmentFilter, selectedDate]);

  // Sort punch cards
  const sortedCardGroups = useMemo(() => {
    return [...filteredCardGroups].sort((a, b) => {
      const timeA = a.device_time ? new Date(a.device_time).getTime() : 0;
      const timeB = b.device_time ? new Date(b.device_time).getTime() : 0;
      return sortOrder === "asc" ? timeA - timeB : timeB - timeA;
    });
  }, [filteredCardGroups, sortOrder]);

  // Pagination (Cards view paginates punch cards, Table view paginates individual rows)
  const totalItems = viewMode === "cards" ? sortedCardGroups.length : sortedRecords.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));

  const currentCards = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return sortedCardGroups.slice(start, start + itemsPerPage);
  }, [sortedCardGroups, currentPage, itemsPerPage]);

  const currentRecords = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return sortedRecords.slice(start, start + itemsPerPage);
  }, [sortedRecords, currentPage, itemsPerPage]);

  // Export to Excel
  const handleExportExcel = () => {
    if (!sortedRecords.length) {
      Swal.fire({
        icon: "info",
        title: "No Data",
        text: "There are no captured store image records to export.",
      });
      return;
    }

    const exportRows = sortedRecords.map((row) => {
      const person = persons.find((p) => String(p.id) === String(row.person_id)) || {};
      let lat = "";
      let lng = "";
      if (row.point && row.point.includes(",")) {
        const parts = row.point.split(",").map((s) => s.trim());
        lat = parts[0] || "";
        lng = parts[1] || "";
      }

      const cachedLocation =
        geocodeCache.get(String(row.point || "").trim()) || "Field Site";

      return {
        "Person ID": row.person_id || "N/A",
        "Employee Name": row.name || person.name || "N/A",
        "Department": row.department || person.department || "N/A",
        "Event": (row.event || "").toUpperCase(),
        "Date & Time": row.device_time
          ? formatAttendanceDateTime(row.device_time)
          : "N/A",
        "Site Location Name": cachedLocation,
        "Latitude": lat || "N/A",
        "Longitude": lng || "N/A",
        "GPS Coordinates": row.point || "No GPS Data",
        "Google Maps Link": row.point
          ? `https://www.google.com/maps?q=${encodeURIComponent(row.point)}`
          : "N/A",
        "Method": row.method || "field-site",
        "Status": row.status || "N/A",
        "Store Image Proof": row.photo ? "Captured" : "None",
        "Store Note / Description": row.notes || "None",
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Field Site Records");
    const dateStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `field_site_records_${dateStr}.xlsx`);
  };

  const openPhotoModal = (
    src,
    title,
    record,
    locationData = null,
    memberDetails = []
  ) => {
    const locName =
      typeof locationData === "string"
        ? locationData
        : locationData?.shortName || "";
    setPhotoModal({
      visible: true,
      src,
      title,
      record,
      locationName: locName,
      locationInfo: typeof locationData === "object" ? locationData : null,
      memberDetails:
        memberDetails && memberDetails.length > 0 ? memberDetails : [],
    });
  };

  const closePhotoModal = () => {
    setPhotoModal({
      visible: false,
      src: "",
      title: "",
      record: null,
      locationName: "",
      locationInfo: null,
      memberDetails: [],
    });
  };

  const handleUpdatePhoto = async (newPhotoDataUrl, targetIds) => {
    if (!targetIds || targetIds.length === 0) return;

    const { error } = await supabase
      .from("attendance")
      .update({ photo: newPhotoDataUrl })
      .in("id", targetIds);

    if (error) {
      console.error("Failed to update photo in database:", error);
      Swal.fire({
        icon: "error",
        title: "Save Failed",
        text: error.message || "Failed to save rotated image to database.",
      });
      throw error;
    }

    // Update local records state so cards and tables instantly reflect the rotated image
    setRecords((prev) =>
      prev.map((r) =>
        targetIds.includes(r.id) ? { ...r, photo: newPhotoDataUrl } : r
      )
    );

    // Update photoModal state
    setPhotoModal((prev) => ({
      ...prev,
      src: newPhotoDataUrl,
      record: prev.record ? { ...prev.record, photo: newPhotoDataUrl } : null,
    }));

    Swal.fire({
      toast: true,
      position: "top-end",
      icon: "success",
      title: "Image position saved successfully",
      showConfirmButton: false,
      timer: 2500,
      timerProgressBar: true,
      iconColor: "#237227",
    });
  };

  const handleMarkReviewed = async (targetRows, labelName = "selected employee") => {
    const rows = (Array.isArray(targetRows) ? targetRows : [targetRows]).filter(
      (r) => r && r.id && isOfflineUnverifiedNote(r.notes)
    );
    if (rows.length === 0) return;

    const confirmRes = await Swal.fire({
      icon: "question",
      title: "Mark Offline Attendance as Reviewed?",
      text: `Confirm review for ${labelName} (${rows.length} record${rows.length > 1 ? "s" : ""}).`,
      showCancelButton: true,
      confirmButtonColor: "#237227",
      confirmButtonText: "Yes, Mark Reviewed",
      customClass: { popup: "!rounded-2xl font-sans" },
    });
    if (!confirmRes.isConfirmed) return;

    const session = getStoredSession();
    const reviewerName = session?.user?.name || session?.user?.email || "Staff";

    try {
      const updatedMap = new Map();
      await Promise.all(
        rows.map(async (row) => {
          const nextNotes = formatOfflineReviewedNote(row.notes, reviewerName);
          const { error } = await supabase
            .from("attendance")
            .update({ notes: nextNotes })
            .eq("id", row.id);
          if (error) throw error;
          updatedMap.set(row.id, nextNotes);
        })
      );

      setRecords((prev) =>
        prev.map((r) => (updatedMap.has(r.id) ? { ...r, notes: updatedMap.get(r.id) } : r))
      );

      setPhotoModal((prev) => {
        if (!prev.record) return prev;
        const nextModalNotes = updatedMap.get(prev.record.id);
        return nextModalNotes !== undefined
          ? { ...prev, record: { ...prev.record, notes: nextModalNotes } }
          : prev;
      });

      Swal.fire({
        toast: true,
        position: "top-end",
        icon: "success",
        title: "Offline attendance marked as reviewed",
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
        iconColor: "#237227",
      });
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Review Failed",
        text: err.message || "Could not update review status.",
        customClass: { popup: "!rounded-2xl font-sans" },
      });
    }
  };

  const departmentsList = useMemo(() => {
    return Array.from(
      new Set(
        [
          ...persons.map((p) => p.department),
          ...records.map((r) => r.department),
        ].filter(Boolean)
      )
    ).sort();
  }, [persons, records]);

  return (
    <div className="w-full font-sans">
      {/* Header */}
      <div className="mb-6 flex flex-col items-start gap-1">
        <h1 className="text-[2.2rem] lg:text-[2.5rem] font-extrabold m-0 tracking-[-0.02em]">
          <span className="text-[#2c382d]">Field Site </span>
          <span className="text-[#237227]">Records</span>
        </h1>
        <p className="text-gray-500 text-sm m-0">
          Auditing field visits with captured store image proofs, GPS map locations, and punch timestamps. Terminal face scans remain in Attendance Records.
        </p>
      </div>

      {/* Filter and Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6 py-3 px-4 bg-white rounded-xl shadow-[0_1px_4px_rgba(0,0,0,0.04)] border border-[#edf2ee]">
        {/* Left Filters */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Search */}
          <div className="relative">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm" />
            <input
              type="text"
              placeholder="Search name, ID, department..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="py-2 pr-3 pl-9 text-[0.85rem] rounded-md border border-[#dce3dd] bg-white text-[#2c382d] min-w-[210px] outline-none focus:border-[#237227] transition-colors"
            />
          </div>

          {/* Event Filter */}
          <select
            value={eventFilter}
            onChange={(e) => setEventFilter(e.target.value)}
            className="py-2 px-3 text-[0.85rem] rounded-md border border-[#dce3dd] bg-white text-[#2c382d] cursor-pointer min-w-[120px] outline-none focus:border-[#237227]"
          >
            <option value="">All Events</option>
            <option value="time-in">Time In</option>
            <option value="time-out">Time Out</option>
          </select>

          {/* Department Filter */}
          <select
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            className="py-2 px-3 text-[0.85rem] rounded-md border border-[#dce3dd] bg-white text-[#2c382d] cursor-pointer min-w-[130px] outline-none focus:border-[#237227]"
          >
            <option value="">All Departments</option>
            {departmentsList.map((dept) => (
              <option key={dept} value={dept}>
                {dept}
              </option>
            ))}
          </select>

          {/* Date Filter */}
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="py-2 px-3 text-[0.85rem] rounded-md border border-[#dce3dd] bg-white text-[#2c382d] cursor-pointer outline-none focus:border-[#237227]"
            />
            {selectedDate && (
              <button
                onClick={() => setSelectedDate("")}
                className="py-1.5 px-2 rounded-md bg-[#f6f8f6] text-[#2c382d] text-xs font-semibold hover:bg-gray-200 transition-colors cursor-pointer border-none"
                title="Clear date filter"
              >
                <FiX />
              </button>
            )}
          </div>

          {/* Sort Order */}
          <button
            aria-label="Toggle sort order"
            onClick={() => setSortOrder((s) => (s === "asc" ? "desc" : "asc"))}
            className="py-2 px-3 rounded-md bg-[#237227] text-white text-[0.82rem] font-semibold cursor-pointer outline-none hover:bg-[#1b5e20] transition-colors border-none"
          >
            {sortOrder === "asc" ? "Time: Oldest" : "Time: Newest"}
          </button>
        </div>

        {/* Right Actions & View Switcher */}
        <div className="flex items-center gap-2.5">
          {/* View Mode Switcher: Cards vs Table */}
          <div className="inline-flex items-center bg-gray-100 p-0.5 rounded-lg border border-gray-200">
            <button
              type="button"
              onClick={() => setViewMode("cards")}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-bold cursor-pointer transition-colors border-none ${
                viewMode === "cards"
                  ? "bg-white text-[#237227] shadow-sm"
                  : "text-gray-600 hover:text-gray-900 bg-transparent"
              }`}
            >
              <FiGrid className="text-sm" />
              <span>Cards</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("table")}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-bold cursor-pointer transition-colors border-none ${
                viewMode === "table"
                  ? "bg-white text-[#237227] shadow-sm"
                  : "text-gray-600 hover:text-gray-900 bg-transparent"
              }`}
            >
              <FiList className="text-sm" />
              <span>Table</span>
            </button>
          </div>

          {/* Counter Badge */}
          <div className="inline-flex items-center py-[6px] px-3 rounded-md bg-[#f4f8f4] border border-[#237227]/30 text-[#237227] text-[0.85rem] font-bold whitespace-nowrap">
            {viewMode === "cards"
              ? `${sortedCardGroups.length} ${
                  sortedCardGroups.length === 1 ? "card" : "cards"
                }${
                  sortedRecords.length > sortedCardGroups.length
                    ? ` (${sortedRecords.length} records)`
                    : ""
                }`
              : `${sortedRecords.length} ${
                  sortedRecords.length === 1 ? "record" : "records"
                }`}
          </div>

          <button
            onClick={handleExportExcel}
            className="inline-flex items-center gap-1.5 py-2 px-3.5 rounded-md text-[0.85rem] font-semibold cursor-pointer whitespace-nowrap bg-[#237227] text-white shadow-sm hover:bg-[#1a5a1d] transition-colors border-none"
          >
            <FiDownload /> Export Excel
          </button>

          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 py-2 px-3.5 rounded-md text-[0.85rem] font-semibold cursor-pointer whitespace-nowrap bg-white text-[#237227] border border-[#237227] hover:bg-[#f4f8f4] transition-colors disabled:opacity-60"
          >
            <FiRefreshCw className={refreshing ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* Main Content Area: Cards View or Table View */}
      {viewMode === "cards" ? (
        <div>
          {currentCards.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200/90 p-16 text-center text-gray-500 shadow-sm">
              <FiCamera className="mx-auto text-4xl text-gray-300 mb-3" />
              <p className="font-bold text-base mb-1 text-gray-800">
                No Captured Store Image Attendance Found
              </p>
              <p className="text-sm text-gray-400 max-w-md mx-auto">
                Field site punches with captured store image proofs will appear here as visual cards.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {currentCards.map((card, idx) => {
                const globalIndex = (currentPage - 1) * itemsPerPage + idx;
                return (
                  <FieldAttendanceCard
                    key={card.id || `card-${idx}`}
                    card={card}
                    index={globalIndex}
                    openPhotoModal={openPhotoModal}
                    persons={persons}
                    onMarkReviewed={handleMarkReviewed}
                  />
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* Alternative Table View */
        <div className="rounded-2xl overflow-hidden shadow-[0_2px_14px_rgba(44,56,45,0.06)] bg-white border border-[#edf2ee] min-h-[520px] flex flex-col justify-between">
          <div className="overflow-x-auto flex-1">
            <table className="w-full border-collapse text-[0.875rem] min-w-[1100px]">
              <thead>
                <tr className="border-b border-[#edf2ee] bg-[#fafbfa]">
                  <th className="py-3.5 px-4 text-left font-bold text-gray-700 text-xs uppercase tracking-wider">
                    Store Photo Proof
                  </th>
                  <th className="py-3.5 px-4 text-left font-bold text-gray-700 text-xs uppercase tracking-wider">
                    Employee
                  </th>
                  <th className="py-3.5 px-4 text-left font-bold text-gray-700 text-xs uppercase tracking-wider">
                    Department
                  </th>
                  <th className="py-3.5 px-4 text-left font-bold text-gray-700 text-xs uppercase tracking-wider">
                    Event
                  </th>
                  <th className="py-3.5 px-4 text-left font-bold text-gray-700 text-xs uppercase tracking-wider">
                    Date & Time
                  </th>
                  <th className="py-3.5 px-4 text-left font-bold text-gray-700 text-xs uppercase tracking-wider">
                    Coordinates & Location
                  </th>
                  <th className="py-3.5 px-4 text-left font-bold text-gray-700 text-xs uppercase tracking-wider">
                    Method
                  </th>
                  <th className="py-3.5 px-4 text-center font-bold text-gray-700 text-xs uppercase tracking-wider">
                    Audit Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {currentRecords.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-20 text-gray-500">
                      <FiCamera className="mx-auto text-4xl text-gray-300 mb-3" />
                      <p className="font-bold text-base mb-1 text-gray-800">
                        No Captured Store Image Attendance Found
                      </p>
                      <p className="text-sm text-gray-400 max-w-md mx-auto">
                        Field site punches with captured store image proofs will appear here.
                      </p>
                    </td>
                  </tr>
                ) : (
                  currentRecords.map((row) => {
                    const person = persons.find((p) => String(p.id) === String(row.person_id)) || {};
                    const empName = row.name || person.name || "Unknown";
                    const dept = row.department || person.department || "General";
                    const photoSrc = row.photo;
                    const isTimeIn = row.event === "time-in";
                    const rowUnverified = isOfflineUnverifiedNote(row.notes);
                    const mapsUrl = row.point
                      ? `https://www.google.com/maps?q=${encodeURIComponent(row.point)}`
                      : null;

                    const title = `${empName} — ${isTimeIn ? "Time In" : "Time Out"} Store Proof`;

                    return (
                      <tr
                        key={row.id}
                        className="border-b border-[#f1f5f1] hover:bg-[#fcfdfc] transition-colors"
                      >
                        <td className="py-3 px-4 align-middle">
                          {photoSrc ? (
                            <div className="relative group inline-block">
                              <img
                                src={photoSrc}
                                alt="Store proof"
                                onClick={() => openPhotoModal(photoSrc, title, row)}
                                className="w-14 h-14 object-cover rounded-xl border border-gray-200 shadow-sm cursor-pointer hover:ring-2 hover:ring-[#237227] transition-all"
                              />
                              <span className="absolute -bottom-1 -right-1 bg-[#237227] text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full shadow">
                                Store
                              </span>
                            </div>
                          ) : (
                            <div className="w-14 h-14 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 border border-gray-200">
                              <FiCamera className="text-xl" />
                            </div>
                          )}
                        </td>

                        <td className="py-3 px-4 align-middle">
                          <div className="font-bold text-gray-900 leading-tight flex items-center gap-1.5">
                            <span>{empName}</span>
                            {rowUnverified && (
                              <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200"
                                title="Synced from offline queue without verified session"
                              >
                                <FiAlertTriangle className="text-amber-600 text-[10px]" />
                                Offline Unverified
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 font-mono mt-0.5">
                            ID: {row.person_id}
                          </div>
                        </td>

                        <td className="py-3 px-4 align-middle">
                          <span className="inline-block px-2.5 py-1 rounded-md text-xs font-semibold bg-gray-100 text-gray-700">
                            {dept}
                          </span>
                        </td>

                        <td className="py-3 px-4 align-middle">
                          {isTimeIn ? (
                            <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-[#e8f5e9] text-[#237227] border border-[#a5d6a7]">
                              <span className="w-2 h-2 rounded-full bg-[#237227] animate-pulse"></span>
                              TIME IN
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-[#e3f2fd] text-[#1565c0] border border-[#90caf9]">
                              <span className="w-2 h-2 rounded-full bg-[#1565c0]"></span>
                              TIME OUT
                            </span>
                          )}
                        </td>

                        <td className="py-3 px-4 align-middle">
                          <div className="flex items-center gap-1.5 text-gray-800 font-medium text-xs">
                            <FiClock className="text-gray-400" />
                            {row.device_time
                              ? formatAttendanceDateTime(row.device_time)
                              : "N/A"}
                          </div>
                        </td>

                        <td className="py-3 px-4 align-middle">
                          {row.point ? (
                            <div className="flex flex-col items-start gap-1">
                              <span
                                className="font-mono text-xs text-gray-600 bg-gray-50 px-2 py-0.5 rounded border border-gray-200 max-w-[200px] truncate"
                                title={row.point}
                              >
                                📍 {row.point}
                              </span>
                              <a
                                href={mapsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-md border border-blue-200 transition-colors"
                              >
                                <FiMapPin className="text-blue-600" />
                                Open in Google Maps
                                <FiExternalLink className="text-[10px]" />
                              </a>
                              {row.notes && (
                                <span
                                  className={`text-[11px] text-gray-700 italic rounded px-2 py-0.5 line-clamp-2 max-w-[220px] border ${
                                    rowUnverified
                                      ? "bg-amber-50/70 border-amber-200"
                                      : "bg-emerald-50/70 border-emerald-100"
                                  }`}
                                  title={row.notes}
                                >
                                  <strong
                                    className={`${
                                      rowUnverified ? "text-amber-900" : "text-emerald-900"
                                    } not-italic`}
                                  >
                                    Note:
                                  </strong>{" "}
                                  {row.notes}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-gray-400 text-xs italic">
                              No GPS Coordinates
                            </span>
                          )}
                        </td>

                        <td className="py-3 px-4 align-middle">
                          <span className="inline-block px-2.5 py-1 rounded text-xs font-semibold bg-gray-50 border border-gray-200 text-gray-700">
                            {row.method || "field-site"}
                          </span>
                        </td>

                        <td className="py-3 px-4 align-middle text-center">
                          <div className="inline-flex flex-col items-center gap-1.5">
                            {photoSrc && (
                              <button
                                type="button"
                                onClick={() => openPhotoModal(photoSrc, title, row)}
                                className="inline-flex items-center gap-1 py-1.5 px-3 rounded-lg bg-[#f0f7f0] hover:bg-[#e0efe0] text-[#237227] text-xs font-bold border border-[#c3e3c3] cursor-pointer transition-colors"
                              >
                                <FiEye /> View Store Image
                              </button>
                            )}
                            {rowUnverified && (
                              <button
                                type="button"
                                onClick={() => handleMarkReviewed([row], empName)}
                                className="inline-flex items-center gap-1 py-1 px-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold border-none cursor-pointer transition-colors"
                              >
                                <FiCheckCircle /> Mark Reviewed
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination Footer (only rendered if multiple pages exist) */}
      {totalPages > 1 && (
        <div className="mt-6 p-4 bg-white rounded-xl border border-gray-200/90 shadow-sm flex items-center justify-end">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="py-1.5 px-3 rounded-md bg-white border border-[#dce3dd] text-xs font-semibold text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 cursor-pointer"
            >
              Prev
            </button>
            <span className="px-2 text-xs font-semibold text-gray-600">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="py-1.5 px-3 rounded-md bg-white border border-[#dce3dd] text-xs font-semibold text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 cursor-pointer"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* High-Resolution Photo Lightbox Modal with Details Overlay */}
      {photoModal.visible && (
        <PhotoOverlayModal
          photoModal={photoModal}
          onClose={closePhotoModal}
          onUpdatePhoto={handleUpdatePhoto}
        />
      )}
    </div>
  );
}
