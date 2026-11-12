import React, { useState, useEffect, useRef, useCallback } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "../mysqlClient";
import { recordAttendanceForPerson } from "../AdminPage/attendanceUtils";
import FaceVerificationGate from "./FaceVerificationGate";
import offlineQueue from "../utils/offlineQueue";
import {
  FiCamera,
  FiRefreshCw,
  FiCheck,
  FiUserCheck,
  FiUsers,
  FiSearch,
  FiMapPin,
  FiClock,
  FiX,
  FiLogIn,
  FiLogOut,
  FiChevronDown,
  FiChevronUp,
  FiMaximize,
  FiMinimize,
  FiAlertCircle,
  FiFileText,
} from "react-icons/fi";
import { checkIsMobileDevice } from "../utils/deviceUtils";

const playVoice = (text) => {
  try {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      window.speechSynthesis.speak(utterance);
    }
  } catch (e) {}
};

export default function UserAttendanceScanner({ onSwitchToLogin, isMobile: propIsMobile }) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof propIsMobile === "boolean"
      ? propIsMobile
      : checkIsMobileDevice()
  );

  // Time & Date
  const [now, setNow] = useState(new Date());

  // Camera & Capture
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const streamRef = useRef(null);
  const cameraContainerRef = useRef(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [facingMode, setFacingMode] = useState("environment"); // default rear camera for store photo
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [descriptionNote, setDescriptionNote] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDevicePortrait, setIsDevicePortrait] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight > window.innerWidth : false
  );

  // Face Verification Gate state
  const [verifiedPerson, setVerifiedPerson] = useState(null);
  const [verificationToken, setVerificationToken] = useState(null);

  // Employees & Partner Group Dropdown
  const [employees, setEmployees] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadingEmployees, setLoadingEmployees] = useState(true);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Settings & Location
  const [settings, setSettings] = useState(null);
  const [locationPoint, setLocationPoint] = useState("");
  const [locationStatus, setLocationStatus] = useState("detecting");
  const [submitting, setSubmitting] = useState(false);

  // Custom Punch Modal State (Replaces default generic SweetAlert2)
  const [modalConfig, setModalConfig] = useState({
    isOpen: false,
    type: null, // "confirm" | "loading" | "success" | "warning" | "error"
    event: null, // "time-in" | "time-out"
    title: "",
    message: "",
    insertedList: [],
    blockedList: [],
    errorList: [],
  });
  const [pendingEvent, setPendingEvent] = useState(null);

  // Detect mobile device (including mobile in landscape)
  useEffect(() => {
    if (typeof propIsMobile === "boolean") {
      setIsMobile(propIsMobile);
      return;
    }
    const handleResize = () => setIsMobile(checkIsMobileDevice());
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, [propIsMobile]);

  // Digital clock interval
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, []);

  // Detect device orientation (portrait vs landscape)
  useEffect(() => {
    const handleOrientation = () => {
      if (typeof window !== "undefined") {
        const portrait = window.innerHeight > window.innerWidth;
        setIsDevicePortrait(portrait);
      }
    };
    handleOrientation();
    window.addEventListener("resize", handleOrientation);
    window.addEventListener("orientationchange", handleOrientation);
    return () => {
      window.removeEventListener("resize", handleOrientation);
      window.removeEventListener("orientationchange", handleOrientation);
    };
  }, []);

  // Listen to browser fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isCurrentlyFull = Boolean(
        document.fullscreenElement || document.webkitFullscreenElement
      );
      setIsFullscreen(isCurrentlyFull);
      if (!isCurrentlyFull) {
        if (typeof window !== "undefined" && window.screen?.orientation?.unlock) {
          try {
            window.screen.orientation.unlock();
          } catch (e) {}
        }
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, []);

  // Fetch employees and settings (Supports both Online & Offline IndexedDB fallback)
  useEffect(() => {
    async function fetchData() {
      try {
        setLoadingEmployees(true);
        let persons = null;
        let settings = null;

        if (typeof navigator !== "undefined" && navigator.onLine) {
          try {
            const { data: personsData } = await supabase
              .from("persons")
              .select("id, name, department")
              .eq("archived", 0)
              .order("name", { ascending: true });

            if (personsData && personsData.length > 0) {
              persons = personsData;
              offlineQueue.savePersons(personsData).catch(() => {});
            }

            const { data: settingsData } = await supabase
              .from("settings")
              .select("*")
              .single();

            if (settingsData) {
              settings = settingsData;
              offlineQueue.saveSettings(settingsData).catch(() => {});
            }
          } catch (netErr) {
            console.warn("[UserScanner] Online fetch failed, checking offline cache:", netErr);
          }
        }

        // If offline or network request returned empty, fall back to IndexedDB cache
        if (!persons || persons.length === 0) {
          const cachedPersons = await offlineQueue.getPersons();
          if (cachedPersons && cachedPersons.length > 0) {
            persons = cachedPersons;
          }
        }

        if (!settings) {
          const cachedSettings = await offlineQueue.getSettings();
          if (cachedSettings) {
            settings = cachedSettings;
          }
        }

        if (persons) setEmployees(persons);
        if (settings) setSettings(settings);
      } catch (err) {
        console.error("Error loading employees or settings:", err);
      } finally {
        setLoadingEmployees(false);
      }
    }
    fetchData();
  }, []);

  // Auto-sync offline attendance queue as soon as internet connection is restored
  useEffect(() => {
    const handleOnline = async () => {
      try {
        const queue = await offlineQueue.getAllQueue();
        if (queue && queue.length > 0) {
          console.log(`[OfflineQueue] Connection restored! Auto-syncing ${queue.length} attendance record(s)...`);
          await offlineQueue.syncQueue(supabase);
        }
      } catch (e) {
        console.warn("[OfflineQueue] Auto-sync error:", e);
      }
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  // Fetch GPS Coordinates
  const fetchLocation = useCallback(() => {
    if (typeof navigator !== "undefined" && "geolocation" in navigator) {
      setLocationStatus("detecting");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude.toFixed(6);
          const lng = pos.coords.longitude.toFixed(6);
          setLocationPoint(`${lat}, ${lng}`);
          setLocationStatus("ok");
        },
        (err) => {
          console.warn("Geolocation warning:", err.message);
          setLocationPoint("Location unavailable");
          setLocationStatus("error");
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    } else {
      setLocationPoint("Geolocation not supported");
      setLocationStatus("error");
    }
  }, []);

  useEffect(() => {
    fetchLocation();
  }, [fetchLocation]);

  // Handle verification from FaceVerificationGate
  const handleFaceVerified = useCallback(({ person, token }) => {
    setVerifiedPerson(person);
    setVerificationToken(token);
    setSelectedIds((prev) => {
      if (prev.includes(person.id)) return prev;
      return [person.id, ...prev];
    });
  }, []);

  // Camera stream handler with robust front/back camera switching & resolution handling
  const startCamera = useCallback(async () => {
    try {
      setCameraError("");
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      const isFront = facingMode === "user";
      let stream = null;

      // 1. Try to find the exact deviceId for the requested camera orientation
      let targetDeviceId = null;
      try {
        if (navigator.mediaDevices?.enumerateDevices) {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoDevices = devices.filter((d) => d.kind === "videoinput");
          if (videoDevices.length > 1) {
            const matched = videoDevices.find((d) =>
              isFront
                ? /front|user|selfie|face/i.test(d.label)
                : /back|rear|environment/i.test(d.label)
            );
            if (matched) {
              targetDeviceId = matched.deviceId;
            }
          }
        }
      } catch (e) {
        console.warn("enumerateDevices check error:", e);
      }

      // 2. Camera constraints: FRONT camera strictly targets user without 1280x720 distance bias
      if (isFront) {
        if (targetDeviceId) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: targetDeviceId } },
              audio: false,
            });
          } catch (e0) {}
        }
        if (!stream) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { exact: "user" } },
              audio: false,
            });
          } catch (e1) {}
        }
        if (!stream) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: "user" },
              audio: false,
            });
          } catch (e2) {}
        }
      } else {
        if (targetDeviceId) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: targetDeviceId } },
              audio: false,
            });
          } catch (e0) {}
        }
        if (!stream) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: "environment" } },
              audio: false,
            });
          } catch (e1) {}
        }
        if (!stream) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: "environment" },
              audio: false,
            });
          } catch (e2) {}
        }
      }

      // Final fallback to any video input
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play().catch(() => {});
          setCameraActive(true);
        };
      }
    } catch (err) {
      console.warn("Camera start failed:", err);
      setCameraError(
        "Camera stream not accessible. You can also upload a photo below."
      );
      setCameraActive(false);
    }
  }, [facingMode]);

  // Start camera ONLY when partner selection has at least 1 person and no photo is captured yet
  useEffect(() => {
    if (isMobile && selectedIds.length > 0 && !capturedPhoto) {
      startCamera();
    } else {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setCameraActive(false);
      }
    }

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [isMobile, selectedIds.length, capturedPhoto, startCamera]);

  // If accessed on desktop, guard and redirect to /admin
  if (!isMobile) {
    return <Navigate to="/admin" replace />;
  }

  // Toggle Fullscreen on Camera
  const toggleFullscreen = () => {
    const el = cameraContainerRef.current;
    if (!isFullscreen) {
      if (el) {
        if (el.requestFullscreen) {
          el.requestFullscreen().catch(() => {});
        } else if (el.webkitRequestFullscreen) {
          el.webkitRequestFullscreen();
        }
      }
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
      setIsFullscreen(false);
    }
  };

  // Snap photo from video feed (supports front & back camera in landscape & portrait)
  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    const MAX_DIM = 320;
    let w = video.videoWidth || 640;
    let h = video.videoHeight || 480;
    if (w > h) {
      if (w > MAX_DIM) {
        h = Math.round((h * MAX_DIM) / w);
        w = MAX_DIM;
      }
    } else {
      if (h > MAX_DIM) {
        w = Math.round((w * MAX_DIM) / h);
        h = MAX_DIM;
      }
    }

    const canvas = canvasRef.current || document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);

    if (facingMode === "user") {
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, -w / 2, -h / 2, w, h);
    ctx.restore();

    const dataUrl = canvas.toDataURL("image/jpeg", 0.65);
    setCapturedPhoto(dataUrl);

    // Stop camera stream while previewing
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      setCameraActive(false);
    }

    // Exit fullscreen after capturing photo if currently fullscreen
    if (isFullscreen) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
      setIsFullscreen(false);
    }
  };

  // Retake photo
  const retakePhoto = () => {
    setCapturedPhoto(null);
    startCamera();
  };

  // File input fallback
  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      setCapturedPhoto(event.target.result);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        setCameraActive(false);
      }
    };
    reader.readAsDataURL(file);
  };

  // Flip camera (environment <-> user)
  const toggleFacingMode = () => {
    setFacingMode((prev) => (prev === "environment" ? "user" : "environment"));
  };

  // Toggle employee selection
  const toggleSelectPerson = (id) => {
    if (verifiedPerson && id === verifiedPerson.id) return;
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((pId) => pId !== id) : [...prev, id]
    );
  };

  // Remove single selected person badge
  const removeSelectedPerson = (id) => {
    if (verifiedPerson && id === verifiedPerson.id) return;
    setSelectedIds((prev) => prev.filter((pId) => pId !== id));
  };

  // Select all filtered employees
  const handleSelectAllFiltered = () => {
    const filteredIds = filteredEmployees.map((e) => e.id);
    setSelectedIds((prev) => Array.from(new Set([...prev, ...filteredIds])));
  };

  // Clear all selections
  const handleClearAll = () => {
    if (verifiedPerson) {
      setSelectedIds([verifiedPerson.id]);
    } else {
      setSelectedIds([]);
    }
  };

  // Filtered employees by search
  const filteredEmployees = employees.filter((emp) =>
    (emp.name || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
    (emp.department || "").toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Selected employee objects
  const selectedEmployees = employees.filter((e) => selectedIds.includes(e.id));

  // Submit attendance for all selected partners (Opens custom confirmation modal)
  const handleSubmitAttendance = (forcedEvent) => {
    if (!capturedPhoto) {
      setModalConfig({
        isOpen: true,
        type: "warning",
        title: "Photo Required",
        message: "Please capture or upload a store proof photo before recording attendance.",
      });
      return;
    }

    if (selectedIds.length === 0) {
      setModalConfig({
        isOpen: true,
        type: "warning",
        title: "No Partner Selected",
        message: "Please select yourself and any partner group employees working at this site.",
      });
      return;
    }

    setPendingEvent(forcedEvent);
    setModalConfig({
      isOpen: true,
      type: "confirm",
      event: forcedEvent,
      title: `Confirm ${forcedEvent === "time-in" ? "Time In" : "Time Out"}?`,
    });
  };

  // Execute recording after user confirms in custom modal
  const handleExecuteAttendance = async () => {
    const forcedEvent = pendingEvent || modalConfig.event;
    if (!forcedEvent) return;

    setModalConfig({
      isOpen: true,
      type: "loading",
      event: forcedEvent,
      title: "Recording Attendance...",
      message: "Please wait while attendance proof is being submitted...",
    });
    setSubmitting(true);

    const results = [];
    for (const person of selectedEmployees) {
      try {
        const res = await recordAttendanceForPerson({
          supabase,
          person,
          settings,
          scanPayload: {
            photoDataUrl: capturedPhoto,
            point: locationPoint || null,
            notes: descriptionNote.trim() || null,
            forcedEvent,
            verification_token: verificationToken,
          },
          method: "field-site",
        });
        results.push({ person, res });
      } catch (err) {
        results.push({ person, error: err });
      }
    }

    setSubmitting(false);

    const insertedList = results.filter((r) => r.res && r.res.inserted);
    const blockedList = results.filter((r) => r.res && r.res.blocked);
    const errorList = results.filter((r) => r.error);

    if (insertedList.length > 0) {
      playVoice(
        `Attendance recorded successfully for ${insertedList.length} employee${
          insertedList.length > 1 ? "s" : ""
        }.`
      );

      setModalConfig({
        isOpen: true,
        type: "success",
        event: forcedEvent,
        title: "Attendance Recorded!",
        insertedList,
        blockedList,
        errorList,
      });
    } else {
      setModalConfig({
        isOpen: true,
        type: "warning",
        title: "Attendance Notice",
        message:
          blockedList.length > 0
            ? "Selected partner(s) have already recorded attendance for this shift."
            : "Could not record attendance. Please check network and retry.",
        blockedList,
        errorList,
      });
    }
  };

  // Close success modal & reset for next punch
  const handleCloseSuccessModal = () => {
    setModalConfig({
      isOpen: false,
      type: null,
      event: null,
      title: "",
      message: "",
      insertedList: [],
      blockedList: [],
      errorList: [],
    });
    setCapturedPhoto(null);
    setDescriptionNote("");
    setSelectedIds([]);
    setVerifiedPerson(null);
    setVerificationToken(null);
  };

  const formattedTime = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  const formattedDate = now.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  // If face is not verified yet, render full-screen FaceVerificationGate
  if (!verifiedPerson) {
    return (
      <FaceVerificationGate
        onVerified={handleFaceVerified}
        locationPoint={locationPoint}
        locationStatus={locationStatus}
        formattedTime={formattedTime}
        formattedDate={formattedDate}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-between font-sans">
      {/* NO Header in Mobile Responsive — completely removed per user request */}

      {/* Main Content Area */}
      <main
        className={`flex-1 w-full mx-auto px-3 pt-3 pb-6 transition-all ${
          !isDevicePortrait && !isFullscreen
            ? "max-w-5xl grid grid-cols-2 gap-3 items-start"
            : "max-w-lg flex flex-col gap-3"
        }`}
      >
        {/* Column 1 in Landscape (Left Panel) or Top in Portrait */}
        <div className="flex flex-col gap-3">
        {/* Minimal Site Info & Clock Strip */}
        <div className="w-full bg-white rounded-xl border border-gray-200 px-3 py-2 flex items-center justify-between text-xs shadow-xs">
          <div className="flex items-center gap-2">
            <img
              src="/image/logosidebar.jpg"
              alt="Multifactors Sales Attendance Logo"
              className="h-6 object-contain"
            />
            <span className="font-bold text-gray-900 text-xs">
              Field Site Records
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-gray-600 font-semibold text-[11px]">
            <FiClock className="text-[#237227]" />
            <span>{formattedTime}</span>
            <span className="text-gray-400 font-normal">({formattedDate})</span>
          </div>
        </div>

        {/* GPS Location badge */}
        <div className="flex items-center justify-between bg-gray-100 px-3 py-1.5 rounded-lg text-[11px] text-gray-600 border border-gray-200">
          <span className="flex items-center gap-1">
            <FiMapPin
              className={
                locationStatus === "ok" ? "text-emerald-600" : "text-amber-500"
              }
            />
            <span>{locationPoint || "Detecting GPS coordinates..."}</span>
          </span>
          <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">
            Field GPS Proof
          </span>
        </div>

        {/* Verified Identity Badge */}
        <div className="w-full bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#237227] animate-pulse"></span>
                <span className="text-gray-800 text-xs">
                  Verified as: <strong className="text-[#237227]">{verifiedPerson.name}</strong> ({verifiedPerson.department || "Field"})
                </span>
              </div>
              <span className="text-[10px] font-bold text-[#237227] bg-white border border-emerald-200 px-2 py-0.5 rounded-full">
                Unlocked
              </span>
            </div>

            {/* STEP 1: DROPDOWN MENU FOR PARTNER GROUP SELECTION */}
            <div
              ref={dropdownRef}
              className="bg-white rounded-2xl border border-gray-200 p-3 shadow-xs flex flex-col gap-2 relative z-30"
            >
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-900 uppercase tracking-wide flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-[#237227] text-white flex items-center justify-center text-[10px]">
                1
              </span>
              Select Partner Group
            </span>
            <span className="text-xs font-bold text-[#237227] bg-emerald-50 border border-emerald-100 px-2.5 py-0.5 rounded-full">
              {selectedIds.length} Selected
            </span>
          </div>

          <p className="text-[11px] text-gray-500 m-0">
            Select yourself and any partner group employees working at this site.
          </p>

          {/* Dropdown Menu Trigger Button */}
          <div
            onClick={() => setIsDropdownOpen((prev) => !prev)}
            className="w-full flex items-center justify-between bg-gray-50 hover:bg-gray-100 border border-gray-300 rounded-xl px-3.5 py-2.5 cursor-pointer transition-all shadow-xs"
          >
            <div className="flex items-center gap-2 truncate pr-2">
              <FiUsers className="text-[#237227] text-sm shrink-0" />
              <span className="text-xs text-gray-800 truncate">
                {selectedIds.length === 0
                  ? "Tap to select partner employees..."
                  : selectedEmployees.map((e) => e.name).join(", ")}
              </span>
            </div>
            <div className="text-gray-500 text-sm shrink-0">
              {isDropdownOpen ? <FiChevronUp /> : <FiChevronDown />}
            </div>
          </div>

          {/* Dropdown Menu Panel (Opens on click) */}
          {isDropdownOpen && (
            <div className="w-full bg-white border border-gray-200 rounded-xl shadow-lg mt-1 p-2.5 flex flex-col gap-2">
              {/* Search bar inside dropdown */}
              <div className="relative flex items-center bg-gray-50 rounded-lg px-2.5 py-1.5 border border-gray-200 focus-within:border-[#237227] focus-within:bg-white transition-all">
                <FiSearch className="text-gray-400 mr-2 text-xs" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search employee name..."
                  className="w-full bg-transparent border-none outline-none text-xs text-gray-900 placeholder-gray-400"
                  autoFocus
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="text-gray-400 hover:text-gray-600 text-xs"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Action buttons inside dropdown */}
              <div className="flex items-center justify-between px-1 text-[11px] text-gray-500">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleSelectAllFiltered}
                    className="text-[#237227] hover:underline font-semibold"
                  >
                    Select All
                  </button>
                  <span>•</span>
                  <button
                    type="button"
                    onClick={handleClearAll}
                    className="text-gray-500 hover:text-red-600"
                  >
                    Clear
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setIsDropdownOpen(false)}
                  className="bg-[#237227] text-white px-2.5 py-0.5 rounded font-semibold text-[11px] flex items-center gap-1"
                >
                  <FiCheck /> Done
                </button>
              </div>

              {/* Scrollable employee checklist */}
              <div className="border border-gray-100 rounded-lg max-h-48 overflow-y-auto divide-y divide-gray-100 bg-white">
                {loadingEmployees ? (
                  <div className="py-6 text-center text-xs text-gray-400">
                    Loading employees...
                  </div>
                ) : filteredEmployees.length === 0 ? (
                  <div className="py-6 text-center text-xs text-gray-400">
                    No matching employee found
                  </div>
                ) : (
                  filteredEmployees.map((emp) => {
                    const isSelected = selectedIds.includes(emp.id);
                    return (
                      <div
                        key={emp.id}
                        onClick={() => toggleSelectPerson(emp.id)}
                        className={`flex items-center justify-between px-3 py-2 cursor-pointer transition-colors ${
                          isSelected ? "bg-emerald-50/80 font-semibold" : "hover:bg-gray-50"
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${
                              isSelected
                                ? "bg-[#237227] border-[#237227] text-white"
                                : "border-gray-300 bg-white"
                            }`}
                          >
                            {isSelected && <FiCheck />}
                          </div>
                          <div className="flex flex-col">
                            <span className="text-xs text-gray-900 leading-tight">
                              {emp.name}
                            </span>
                            {emp.department && (
                              <span className="text-[10px] text-gray-400">
                                {emp.department}
                              </span>
                            )}
                          </div>
                        </div>
                        {isSelected && (
                          <span className={`text-[10px] font-bold ${
                            verifiedPerson && emp.id === verifiedPerson.id
                              ? "text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full"
                              : "text-[#237227]"
                          }`}>
                            {verifiedPerson && emp.id === verifiedPerson.id
                              ? "You · Verified"
                              : "Selected ✓"}
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Selected partners badge chips (Always visible when partners are selected) */}
          {selectedIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {selectedEmployees.map((emp) => (
                <span
                  key={emp.id}
                  className="inline-flex items-center gap-1 bg-emerald-50 border border-emerald-200 text-[#1b591f] px-2.5 py-1 rounded-full text-xs font-semibold shadow-xs"
                >
                  <FiUserCheck className="text-emerald-600" />
                  <span>{emp.name}</span>
                  <button
                    type="button"
                    onClick={() => removeSelectedPerson(emp.id)}
                    className="ml-1 text-gray-400 hover:text-red-500 font-bold focus:outline-none"
                    title="Remove"
                  >
                    <FiX />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* STEP 3: PUNCH ATTENDANCE ACTIONS (In Landscape mode on left panel) */}
        {!isDevicePortrait && !isFullscreen && selectedIds.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-3 shadow-xs flex flex-col gap-2">
            <span className="text-xs font-bold text-gray-900 uppercase tracking-wide flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-[#237227] text-white flex items-center justify-center text-[10px]">
                3
              </span>
              Record Punch ({selectedIds.length} Partner{selectedIds.length > 1 ? "s" : ""})
            </span>

            <div className="grid grid-cols-2 gap-2 mt-1">
              <button
                type="button"
                disabled={submitting || !capturedPhoto}
                onClick={() => handleSubmitAttendance("time-in")}
                className="flex items-center justify-center gap-2 py-3 px-3 rounded-xl bg-[#237227] hover:bg-[#1a541c] text-white font-bold text-sm shadow-md transition-all active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FiLogIn className="text-base" />
                <span>Time In</span>
              </button>

              <button
                type="button"
                disabled={submitting || !capturedPhoto}
                onClick={() => handleSubmitAttendance("time-out")}
                className="flex items-center justify-center gap-2 py-3 px-3 rounded-xl bg-[#1d4ed8] hover:bg-[#1e40af] text-white font-bold text-sm shadow-md transition-all active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FiLogOut className="text-base" />
                <span>Time Out</span>
              </button>
            </div>

            {!capturedPhoto && (
              <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg p-2 text-center m-0 border border-amber-200">
                Please capture the store image above to enable Time In / Out.
              </p>
            )}
          </div>
        )}
        </div>

        {/* Column 2 in Landscape (Right Panel) or Bottom in Portrait */}
        <div className="flex flex-col gap-3">
          {/* STEP 2: CAMERA RENDERS ONLY AFTER PARTNER SELECTION */}
        {selectedIds.length === 0 ? (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center text-amber-800 text-xs flex flex-col items-center gap-2">
            <span className="font-bold text-sm">Camera is hidden</span>
            <p className="m-0 text-amber-700">
              Please select at least 1 employee partner above to activate the store camera.
            </p>
          </div>
        ) : (
          /* Render Camera & Capture Controls once partners are selected */
          <div
            ref={cameraContainerRef}
            className={`transition-all animate-fadeIn ${
              isFullscreen
                ? "fixed inset-0 z-[9999] bg-black flex items-center justify-center overflow-hidden p-0 m-0"
                : "bg-white rounded-2xl border border-gray-200 p-3 shadow-xs flex flex-col gap-2.5"
            }`}
          >
            <div
              className={
                isFullscreen
                  ? "flex flex-col justify-between p-3.5 bg-black text-white relative w-full h-full"
                  : "flex flex-col gap-2.5 w-full"
              }
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-5 h-5 rounded-full bg-[#237227] text-white flex items-center justify-center text-[10px] font-bold">
                    2
                  </span>
                  <span
                    className={`text-xs font-bold uppercase tracking-wide ${
                      isFullscreen ? "text-white" : "text-gray-900"
                    }`}
                  >
                    Capture Store Proof
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  {/* Fullscreen Button */}
                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    className={`text-xs font-medium px-2.5 py-1 rounded-full flex items-center gap-1 ${
                      isFullscreen
                        ? "bg-white/20 text-white hover:bg-white/30"
                        : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                    title={isFullscreen ? "Exit Fullscreen" : "Fullscreen Camera"}
                  >
                    {isFullscreen ? (
                      <>
                        <FiMinimize className="text-[11px]" />
                        <span>Exit</span>
                      </>
                    ) : (
                      <>
                        <FiMaximize className="text-[11px]" />
                        <span>Full Screen</span>
                      </>
                    )}
                  </button>

                  {/* Switch Front/Back Camera */}
                  {!capturedPhoto && cameraActive && (
                    <button
                      type="button"
                      onClick={toggleFacingMode}
                      className={`text-xs font-medium px-2.5 py-1 rounded-full flex items-center gap-1 ${
                        isFullscreen
                          ? "bg-white/20 text-white hover:bg-white/30"
                          : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                      }`}
                      title="Switch Camera (Front/Back)"
                    >
                      <FiRefreshCw className="text-[11px]" />
                      <span>{facingMode === "environment" ? "Back" : "Front"}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Camera Viewport / Photo Preview */}
              <div
                className={`relative w-full bg-black rounded-xl overflow-hidden flex items-center justify-center border ${
                  isFullscreen
                    ? "border-white/10 flex-1 my-2"
                    : "border-gray-200 aspect-[4/3]"
                } shadow-inner transition-all`}
              >
                {capturedPhoto ? (
                  <img
                    src={capturedPhoto}
                    alt="Captured Store Proof"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <>
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      style={{
                        transform: facingMode === "user" ? "scaleX(-1)" : "none",
                        transformOrigin: "center center",
                      }}
                      className="w-full h-full object-cover"
                    />
                    <canvas ref={canvasRef} className="hidden" />

                    {/* Viewfinder overlay guide */}
                    <div className="absolute inset-4 border-2 border-dashed border-white/60 rounded-lg pointer-events-none flex items-center justify-center">
                      <span className="text-[11px] text-white/90 bg-black/50 px-2.5 py-1 rounded backdrop-blur-xs font-medium">
                        Aim camera at store or field site
                      </span>
                    </div>
                  </>
                )}

                {cameraError && !capturedPhoto && (
                  <div className="absolute inset-0 bg-gray-900/90 text-white p-4 flex flex-col items-center justify-center text-center text-xs gap-2">
                    <p>{cameraError}</p>
                    <button
                      type="button"
                      onClick={startCamera}
                      className="px-3 py-1.5 bg-[#237227] text-white font-semibold rounded-lg"
                    >
                      Retry Camera
                    </button>
                  </div>
                )}
              </div>

              {/* Capture / Retake Controls */}
              <div className="flex items-center gap-2">
                {capturedPhoto ? (
                  <div className="w-full flex flex-col gap-2.5">
                    <div className="w-full flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                      <span className="text-xs font-bold text-emerald-800 flex items-center gap-1.5">
                        <FiCheck className="text-emerald-600 text-sm" />
                        Store Image Ready
                      </span>
                      <button
                        type="button"
                        onClick={retakePhoto}
                        className="px-3 py-1 bg-white border border-gray-300 text-gray-700 hover:text-gray-900 text-xs font-semibold rounded-lg shadow-xs flex items-center gap-1 cursor-pointer transition-colors"
                      >
                        <FiRefreshCw className="text-[11px]" />
                        Retake
                      </button>
                    </div>

                    {/* Field Text Description / Store Note */}
                    <div className="w-full bg-white border border-gray-200 rounded-xl p-2.5 shadow-2xs">
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-[11px] font-bold text-gray-700 flex items-center gap-1.5">
                          <FiFileText className="text-[#237227]" />
                          Store Description / Note
                        </label>
                        <span className="text-[10px] text-gray-400 font-medium">Optional</span>
                      </div>
                      <textarea
                        value={descriptionNote}
                        onChange={(e) => setDescriptionNote(e.target.value)}
                        placeholder="Add store name, site visit details, or remarks..."
                        rows={2}
                        className="w-full p-2 text-xs bg-gray-50 border border-gray-200 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-[#237227] focus:bg-white resize-none transition-all"
                        maxLength={500}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="w-full flex gap-2">
                    <button
                      type="button"
                      onClick={capturePhoto}
                      disabled={!cameraActive}
                      className="flex-1 py-3 px-4 bg-[#237227] hover:bg-[#1b591f] text-white font-bold text-sm rounded-xl shadow-md flex items-center justify-center gap-2 active:scale-98 transition-all disabled:opacity-50"
                    >
                      <FiCamera className="text-lg" />
                      <span>Capture Store Image</span>
                    </button>

                    {/* File Upload Fallback */}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className={`px-3 py-2 text-xs font-semibold rounded-xl border ${
                        isFullscreen
                          ? "bg-white/20 text-white border-white/30"
                          : "bg-gray-100 text-gray-700 border-gray-200 hover:bg-gray-200"
                      }`}
                      title="Upload image file from device"
                    >
                      Upload
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: PUNCH ATTENDANCE ACTIONS (In Portrait mode below camera) */}
        {isDevicePortrait && !isFullscreen && selectedIds.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-3 shadow-xs flex flex-col gap-2">
            <span className="text-xs font-bold text-gray-900 uppercase tracking-wide flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-[#237227] text-white flex items-center justify-center text-[10px]">
                3
              </span>
              Record Punch ({selectedIds.length} Partner{selectedIds.length > 1 ? "s" : ""})
            </span>

            <div className="grid grid-cols-2 gap-2 mt-1">
              <button
                type="button"
                disabled={submitting || !capturedPhoto}
                onClick={() => handleSubmitAttendance("time-in")}
                className="flex items-center justify-center gap-2 py-3 px-3 rounded-xl bg-[#237227] hover:bg-[#1a541c] text-white font-bold text-sm shadow-md transition-all active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FiLogIn className="text-base" />
                <span>Time In</span>
              </button>

              <button
                type="button"
                disabled={submitting || !capturedPhoto}
                onClick={() => handleSubmitAttendance("time-out")}
                className="flex items-center justify-center gap-2 py-3 px-3 rounded-xl bg-[#1d4ed8] hover:bg-[#1e40af] text-white font-bold text-sm shadow-md transition-all active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FiLogOut className="text-base" />
                <span>Time Out</span>
              </button>
            </div>

            {!capturedPhoto && (
              <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg p-2 text-center m-0 border border-amber-200">
                Please capture the store image above to enable Time In / Out.
              </p>
            )}
          </div>
        )}
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full bg-white border-t border-gray-200 py-3 px-4 flex items-center justify-center text-[11px] text-gray-500">
        <span>© 2026 Multifactors Sales Attendance</span>
      </footer>

      {/* Custom Attendance Action Modal (Confirm, Loading, Success, Notice) */}
      {modalConfig.isOpen && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-fadeIn"
          onClick={() => {
            if (modalConfig.type !== "loading") {
              setModalConfig((prev) => ({ ...prev, isOpen: false }));
            }
          }}
        >
          <div
            className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden transform transition-all animate-scaleIn flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 1. CONFIRMATION MODAL */}
            {modalConfig.type === "confirm" && (
              <div className="p-6 flex flex-col gap-4 text-center">
                <h3 className="text-xl font-bold text-gray-800 m-0">
                  Confirm {modalConfig.event === "time-in" ? "Time In" : "Time Out"}?
                </h3>

                <div className="text-left text-sm text-gray-700 bg-gray-50 p-4 rounded-xl border border-gray-100 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-gray-600">Event:</span>
                    <span
                      className={`font-bold ${
                        modalConfig.event === "time-in"
                          ? "text-emerald-700"
                          : "text-blue-700"
                      }`}
                    >
                      {modalConfig.event === "time-in" ? "Time In" : "Time Out"}
                    </span>
                  </div>

                  <p className="text-xs text-gray-500 m-0 pt-2 border-t border-gray-200/60 leading-relaxed">
                    Store photo and GPS will be recorded as attendance proof.
                  </p>

                  {descriptionNote.trim() && (
                    <div className="flex items-start gap-1.5 pt-2 border-t border-gray-200/60 text-xs text-left">
                      <FiFileText className="text-[#237227] mt-0.5 shrink-0" />
                      <div className="flex flex-col">
                        <span className="font-semibold text-gray-500 text-[11px]">Note:</span>
                        <span className="text-gray-800 italic break-words">{descriptionNote.trim()}</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="grid grid-cols-2 gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={handleExecuteAttendance}
                    className="py-3 px-4 text-white font-bold text-sm rounded-xl shadow-md active:scale-98 transition-all cursor-pointer bg-[#237227] hover:bg-[#1a541c]"
                  >
                    Record {modalConfig.event === "time-in" ? "Time In" : "Time Out"}
                  </button>

                  <button
                    type="button"
                    onClick={() => setModalConfig((prev) => ({ ...prev, isOpen: false }))}
                    className="py-3 px-4 rounded-xl border border-gray-300 bg-white text-gray-700 font-bold text-sm hover:bg-gray-100 active:scale-98 transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* 2. LOADING MODAL */}
            {modalConfig.type === "loading" && (
              <div className="p-8 flex flex-col items-center justify-center text-center gap-4">
                <h3 className="text-xl font-bold text-gray-800 m-0">
                  Recording Attendance...
                </h3>
                <p className="text-sm text-gray-500 m-0">
                  Please wait while attendance proof is being submitted...
                </p>
                <div className="w-10 h-10 rounded-full border-4 border-gray-200 border-t-[#237227] animate-spin mt-2"></div>
              </div>
            )}

            {/* 3. SUCCESS MODAL */}
            {modalConfig.type === "success" && (
              <div className="p-6 flex flex-col items-center text-center gap-4">
                {/* Clean circular check icon */}
                <div className="w-16 h-16 rounded-full border-4 border-emerald-400 bg-emerald-50 text-emerald-600 flex items-center justify-center text-3xl">
                  <FiCheck className="stroke-[3]" />
                </div>

                <h3 className="text-xl font-bold text-gray-800 m-0">
                  Attendance Recorded!
                </h3>

                <div className="w-full text-left font-sans text-xs sm:text-sm bg-gray-50 p-4 rounded-xl border border-gray-100 flex flex-col gap-2">
                  <div className="text-[#237227] font-bold text-xs sm:text-sm">
                    ✓ Successfully recorded {modalConfig.event === "time-in" ? "Time In" : "Time Out"} for:
                  </div>
                  <ul className="list-disc pl-5 m-0 text-gray-800 space-y-1 text-xs sm:text-sm">
                    {modalConfig.insertedList?.map((item) => (
                      <li key={item.person.id}>
                        <strong>{item.person.name}</strong>{" "}
                        <span className="text-gray-500">
                          ({item.res?.status || "Recorded"})
                        </span>
                      </li>
                    ))}
                  </ul>

                  {modalConfig.blockedList?.length > 0 && (
                    <div className="mt-1 pt-2 border-t border-amber-200/60">
                      <div className="text-amber-700 font-semibold text-xs mb-1">
                        ⚠ Already recorded or duplicate:
                      </div>
                      <ul className="list-disc pl-5 m-0 text-gray-600 text-xs">
                        {modalConfig.blockedList.map((item) => (
                          <li key={item.person.id}>{item.person.name} (Duplicate scan ignored)</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {descriptionNote.trim() && (
                    <div className="mt-1 pt-2 border-t border-gray-200/60 flex items-start gap-1.5 text-xs text-gray-700 italic">
                      <FiFileText className="text-[#237227] mt-0.5 shrink-0" />
                      <span>
                        <strong className="text-gray-900 not-italic font-semibold">Note:</strong> "{descriptionNote.trim()}"
                      </span>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleCloseSuccessModal}
                  className="w-24 py-2.5 bg-[#237227] hover:bg-[#1a541c] text-white font-bold text-sm rounded-lg shadow-sm active:scale-98 transition-all cursor-pointer"
                >
                  OK
                </button>
              </div>
            )}

            {/* 4. WARNING / NOTICE / ERROR MODAL */}
            {(modalConfig.type === "warning" || modalConfig.type === "error") && (
              <div className="p-6 flex flex-col items-center text-center gap-3">
                <div
                  className={`w-14 h-14 rounded-full flex items-center justify-center text-2xl shadow-sm ${
                    modalConfig.type === "error"
                      ? "bg-red-50 text-red-600 border border-red-200"
                      : "bg-amber-50 text-amber-600 border border-amber-200"
                  }`}
                >
                  <FiAlertCircle />
                </div>
                <h3 className="text-base font-bold text-gray-800 m-0">
                  {modalConfig.title || "Notice"}
                </h3>
                <p className="text-xs text-gray-600 m-0 max-w-[280px]">
                  {modalConfig.message}
                </p>
                <button
                  type="button"
                  onClick={() => setModalConfig((prev) => ({ ...prev, isOpen: false }))}
                  className="w-24 py-2 mt-2 bg-[#237227] hover:bg-[#1a541c] text-white font-bold text-xs rounded-lg shadow-sm active:scale-98 transition-all cursor-pointer"
                >
                  OK
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
