import React, { useState, useEffect, useRef, useCallback } from "react";
import * as faceapi from "face-api.js";
import { ensureFaceModelsLoaded, buildDescriptors } from "../utils/buildFaceDescriptors";
import { averageDescriptors, normalizeDescriptor, toFloat32Array } from "../utils/faceUtils";
import { formatGpsCoords, isValidGpsCoords } from "../utils/gpsLocation";
import offlineQueue from "../utils/offlineQueue";
import { getApiBase, setActiveFaceToken } from "../utils/authSession";
import { Link } from "react-router-dom";
import {
  FiRefreshCw,
  FiCheckCircle,
  FiAlertTriangle,
  FiWifiOff,
  FiShield,
  FiUser,
  FiCamera,
  FiMapPin,
  FiClock,
  FiHome,
} from "react-icons/fi";

const playVoice = (text) => {
  try {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = 1.0;
      window.speechSynthesis.speak(utterance);
    }
  } catch (e) {}
};

function calcEuclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

const formatCompactLocation = (loc, status) => {
  if (isValidGpsCoords(loc)) {
    const [lat, lng] = loc.split(",").map((s) => s.trim());
    return formatGpsCoords(lat, lng, 4) || loc;
  }
  if (status === "denied") return "Allow GPS access";
  if (status === "error") return "Retrying GPS...";
  if (!loc) return "Auto-detecting GPS...";
  return loc;
};

export const NO_FACE_TIMEOUT_MS = 5 * 1000; // 5 seconds
const NO_FACE_CHECK_INTERVAL_MS = 250;

export default function FaceVerificationGate({
  onVerified,
  locationPoint,
  locationStatus,
  locationMessage,
  formattedTime,
  formattedDate,
}) {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [noFaceTimedOut, setNoFaceTimedOut] = useState(false);
  const [verificationStage, setVerificationStage] = useState("init"); // "init" | "ready" | "verifying" | "success" | "retry" | "locked"
  const [statusMessage, setStatusMessage] = useState("Initializing face recognition...");
  const [failCount, setFailCount] = useState(0);
  const [verifiedName, setVerifiedName] = useState("");
  const [faceDetected, setFaceDetected] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const animFrameRef = useRef(null);
  const descriptorBufferRef = useRef([]);
  const isVerifyingRef = useRef(false);
  const verifyCooldownRef = useRef(0);
  const buildingDescriptorsRef = useRef(false);
  const missedFramesRef = useRef(0);
  const lastFaceDetectedAtRef = useRef(Date.now());
  const hasAutoStartedRef = useRef(false);
  const isMountedRef = useRef(true);
  const cameraSessionIdRef = useRef(0);
  const modelsLoadedRef = useRef(modelsLoaded);
  modelsLoadedRef.current = modelsLoaded;
  const verificationStageRef = useRef(verificationStage);
  verificationStageRef.current = verificationStage;

  // 1. Online / Offline Listener
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // 2. Load face-api models and build missing descriptors from Dahua photos
  useEffect(() => {
    let mounted = true;
    async function init() {
      try {
        setStatusMessage("Loading facial recognition models...");
        await ensureFaceModelsLoaded();
        if (mounted) {
          setModelsLoaded(true);
          setVerificationStage("ready");
          setStatusMessage("Position your face within the frame");
        }

        // Cache active Dahua employees with face descriptors in IndexedDB for offline recognition
        if (typeof navigator !== "undefined" && navigator.onLine) {
          fetch(`${getApiBase()}/api/face/persons-offline`)
            .then((r) => r.json())
            .then((d) => {
              if (d && d.success && Array.isArray(d.persons) && d.persons.length > 0) {
                offlineQueue.savePersons(d.persons).catch(() => {});
                console.log(`[FaceGate] Cached ${d.persons.length} employees with descriptors for offline use.`);
              }
            })
            .catch(() => {});
        }

        // Proactively generate descriptors for Dahua persons with photos in the background
        if (!buildingDescriptorsRef.current) {
          buildingDescriptorsRef.current = true;
          buildDescriptors()
            .then((res) => {
              if (res && res.built > 0) {
                console.log(`[FaceGate] Built descriptors for ${res.built} Dahua user(s).`);
              }
            })
            .catch((err) => {
              console.warn("[FaceGate] Background descriptor build warning:", err);
            });
        }
      } catch (err) {
        if (mounted) {
          setCameraError("Could not load facial recognition models: " + err.message);
        }
      }
    }
    init();
    return () => {
      mounted = false;
    };
  }, []);

  const stopCamera = useCallback(() => {
    cameraSessionIdRef.current += 1;
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.onloadedmetadata = null;
      video.oncanplay = null;
      video.srcObject = null;
    }
  }, []);

  const redirectToReadyForVerification = useCallback(() => {
    stopCamera();
    isVerifyingRef.current = false;
    descriptorBufferRef.current = [];
    missedFramesRef.current = 0;
    verifyCooldownRef.current = 0;
    setFaceDetected(false);
    setFailCount(0);
    setCameraError("");
    setCameraActive(false);
    setNoFaceTimedOut(true);
    setVerificationStage("ready");
    setStatusMessage("Position your face within the frame");
  }, [stopCamera]);

  // 3. Start Front Camera (Works both Online & Offline)
  const startCamera = useCallback(async () => {
    if (!modelsLoadedRef.current || verificationStageRef.current === "locked") return;
    const sessionId = ++cameraSessionIdRef.current;

    try {
      setCameraError("");
      setNoFaceTimedOut(false);
      setStatusMessage("Starting front camera...");
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error(
          "Camera access is not supported on this browser or requires a secure HTTPS connection."
        );
      }

      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
      } catch (e1) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user" },
            audio: false,
          });
        } catch (e2) {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }
      }

      if (!isMountedRef.current || cameraSessionIdRef.current !== sessionId) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("playsinline", "true");
        video.setAttribute("muted", "true");

        let activated = false;
        const activate = () => {
          if (activated || !isMountedRef.current || cameraSessionIdRef.current !== sessionId) {
            return;
          }
          activated = true;
          video.onloadedmetadata = null;
          video.oncanplay = null;
          lastFaceDetectedAtRef.current = Date.now();
          setCameraActive(true);
          setStatusMessage("Position your face within the frame");
        };

        const tryPlay = async () => {
          if (activated || !isMountedRef.current || cameraSessionIdRef.current !== sessionId) {
            return;
          }
          try {
            await video.play();
            activate();
          } catch (playErr) {
            console.warn("video.play() rejection (gesture needed):", playErr);
          }
        };

        video.onloadedmetadata = () => {
          tryPlay();
        };
        video.oncanplay = () => {
          tryPlay();
        };

        await tryPlay();
      }
    } catch (err) {
      if (!isMountedRef.current || cameraSessionIdRef.current !== sessionId) {
        return;
      }
      console.warn("Front camera start failed:", err);
      let msg = err.message || String(err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        msg = "Camera permission was blocked. Tap the tune/lock icon in your browser address bar to allow Camera access, then tap Enable Camera.";
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        msg = "No front camera found on this device.";
      } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
        msg = "Camera is already in use by another app. Please close other camera apps and retry.";
      }
      setCameraError(msg);
      setCameraActive(false);
    }
  }, []);

  const handleManualStartCamera = useCallback(() => {
    setNoFaceTimedOut(false);
    setCameraError("");
    setFailCount(0);
    setFaceDetected(false);
    setVerificationStage("ready");
    descriptorBufferRef.current = [];
    missedFramesRef.current = 0;
    verifyCooldownRef.current = 0;
    isVerifyingRef.current = false;
    lastFaceDetectedAtRef.current = Date.now();
    startCamera();
  }, [startCamera]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    if (modelsLoaded && !hasAutoStartedRef.current && verificationStage !== "locked") {
      hasAutoStartedRef.current = true;
      startCamera();
    }
  }, [modelsLoaded, verificationStage, startCamera]);

  // 4. Verification call (Online Server or Client-Side Offline Matcher)
  const executeVerification = async (desc) => {
    if (isVerifyingRef.current) return;
    isVerifyingRef.current = true;
    setVerificationStage("verifying");
    setStatusMessage(isOnline ? "Matching face with Dahua records..." : "Matching face with offline records...");

    try {
      let data = null;

      // 1. Try server verification if device is online
      if (navigator.onLine) {
        try {
          const response = await fetch(`${getApiBase()}/api/face/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ descriptor: Array.from(desc) }),
          });
          if (response.ok) {
            data = await response.json();
          }
        } catch (netErr) {
          console.warn("[FaceGate] Online verification failed, falling back to local offline matcher:", netErr);
        }
      }

      // 2. Fallback to client-side offline face matcher using cached IndexedDB records
      if (!data || !data.matched) {
        if (!navigator.onLine || !data) {
          try {
            const cachedPersons = await offlineQueue.getPersons();
            if (Array.isArray(cachedPersons) && cachedPersons.length > 0) {
              let bestDist = Infinity;
              let secondBestDist = Infinity;
              let bestPerson = null;

              for (const p of cachedPersons) {
                if (!p.descriptor) continue;
                let descArr = p.descriptor;
                if (typeof descArr === "string") {
                  try { descArr = JSON.parse(descArr); } catch (e) {}
                }
                if (!Array.isArray(descArr) && !(descArr instanceof Float32Array)) continue;
                const dist = calcEuclideanDistance(desc, descArr);
                if (dist < bestDist) {
                  secondBestDist = bestDist;
                  bestDist = dist;
                  bestPerson = p;
                } else if (dist < secondBestDist) {
                  secondBestDist = dist;
                }
              }

              const FACE_THRESHOLD = 0.38;
              const MARGIN = 0.012;
              const isMatched = bestPerson && (
                (bestDist <= 0.32) ||
                (bestDist <= FACE_THRESHOLD && (secondBestDist - bestDist >= MARGIN))
              );

              if (isMatched) {
                data = {
                  matched: true,
                  person: {
                    id: String(bestPerson.id),
                    name: bestPerson.name,
                    department: bestPerson.department,
                  },
                  token: `offline_token_${bestPerson.id}_${Date.now()}`,
                  distance: Number(bestDist.toFixed(4)),
                  isOffline: true,
                };
              }
            }
          } catch (cacheErr) {
            console.warn("[FaceGate] Local offline matching error:", cacheErr);
          }
        }
      }

      if (data && data.matched && data.person && data.token) {
        setActiveFaceToken(!data.isOffline ? data.token : null);
        setVerifiedName(data.person.name);
        setVerificationStage("success");
        setFailCount(0);
        setStatusMessage(`Verified: ${data.person.name}${data.isOffline ? " (Offline)" : ""}`);
        playVoice(`Verified, welcome ${data.person.name}`);

        // Stop camera cleanly before unmounting
        stopCamera();

        setTimeout(() => {
          if (typeof onVerified === "function") {
            onVerified({
              person: data.person,
              token: data.token,
              isOffline: !!data.isOffline,
            });
          }
        }, 850);
      } else {
        // If server indicated missing descriptors, try building them once
        if (data && data.error && data.error.includes("No registered persons with face data")) {
          buildDescriptors().catch(() => {});
        }

        const nextFail = failCount + 1;
        setFailCount(nextFail);
        descriptorBufferRef.current = [];
        verifyCooldownRef.current = Date.now() + 1000; // 1.0s fast cooldown before next auto-attempt

        if (nextFail >= 6) {
          setActiveFaceToken(null);
          stopCamera();
          setCameraActive(false);
          setVerificationStage("locked");
          setStatusMessage("Verification failed. Please try again or check person records.");
          playVoice("Verification failed. Please try again, or check if your face is enrolled in person records.");
        } else {
          lastFaceDetectedAtRef.current = Date.now();
          setVerificationStage("retry");
          setStatusMessage(`Face not matched. Attempt ${nextFail} of 6. Align face clearly.`);
          isVerifyingRef.current = false;
        }
      }
    } catch (err) {
      console.error("[FaceVerificationGate] Verify error:", err);
      setStatusMessage("Connection error during verification. Retrying...");
      descriptorBufferRef.current = [];
      verifyCooldownRef.current = Date.now() + 1200;
      lastFaceDetectedAtRef.current = Date.now();
      setVerificationStage("retry");
      isVerifyingRef.current = false;
    }
  };

  // 5. Automatic Face Detection & Auto-Proceed Loop (No Blinking Required)
  useEffect(() => {
    if (!cameraActive || !modelsLoaded || verificationStage === "verifying" || verificationStage === "locked" || verificationStage === "success") {
      return;
    }

    let isRunning = true;
    const detectionOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.38 });

    const detectLoop = async () => {
      if (!isRunning || isVerifyingRef.current) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.paused || video.ended) {
        animFrameRef.current = requestAnimationFrame(detectLoop);
        return;
      }

      const now = Date.now();
      // Honor scan cooldown after an unrecognized face
      if (now < verifyCooldownRef.current) {
        animFrameRef.current = requestAnimationFrame(detectLoop);
        return;
      }

      try {
        const detection = await faceapi
          .detectSingleFace(video, detectionOptions)
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (detection && detection.descriptor) {
          const box = detection.detection?.box;
          // Ensure face is reasonably large (close enough to camera and centered)
          const isReasonableSize = box && box.width >= 70 && box.height >= 70;

          if (isReasonableSize) {
            lastFaceDetectedAtRef.current = Date.now();
            missedFramesRef.current = 0;
            setFaceDetected(true);

            const norm = normalizeDescriptor(toFloat32Array(detection.descriptor));
            if (norm) {
              const buf = descriptorBufferRef.current;
              buf.push(norm);
              if (buf.length > 2) buf.shift();

              // When we have 2 stable frames, automatically proceed with verification
              if (buf.length >= 2 && !isVerifyingRef.current) {
                const avg = averageDescriptors(buf) || norm;
                executeVerification(avg);
                return;
              }
            }

            if (verificationStage !== "verifying" && verificationStage !== "retry") {
              setVerificationStage("ready");
              setStatusMessage("Face detected — Verifying identity...");
            }
          } else {
            // Face too far away / small
            missedFramesRef.current += 1;
            if (missedFramesRef.current >= 3) {
              setFaceDetected(false);
              descriptorBufferRef.current = [];
              if (verificationStage !== "ready" && verificationStage !== "retry") {
                setVerificationStage("ready");
                setStatusMessage("Move closer to the camera");
              }
            }
          }
        } else {
          // No face detected
          missedFramesRef.current += 1;
          if (missedFramesRef.current >= 3) {
            setFaceDetected(false);
            descriptorBufferRef.current = [];
            if (verificationStage !== "ready" && verificationStage !== "retry") {
              setVerificationStage("ready");
              setStatusMessage("Position your face within the frame");
            }
          }
        }
      } catch (err) {
        // Silently continue loop
      }

      if (isRunning && !isVerifyingRef.current) {
        animFrameRef.current = requestAnimationFrame(detectLoop);
      }
    };

    animFrameRef.current = requestAnimationFrame(detectLoop);

    return () => {
      isRunning = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive, modelsLoaded, verificationStage]);

  // 6. Redirect to Ready for Verification page if no face is detected for 5 seconds
  useEffect(() => {
    if (
      !cameraActive ||
      !modelsLoaded ||
      verificationStage === "verifying" ||
      verificationStage === "locked" ||
      verificationStage === "success"
    ) {
      return;
    }

    const intervalId = setInterval(() => {
      if (isVerifyingRef.current) return;
      if (Date.now() - lastFaceDetectedAtRef.current >= NO_FACE_TIMEOUT_MS) {
        redirectToReadyForVerification();
      }
    }, NO_FACE_CHECK_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [cameraActive, modelsLoaded, verificationStage, redirectToReadyForVerification]);

  // Locked State UI (after 5 failures)
  if (verificationStage === "locked") {
    return (
      <div className="fixed inset-0 z-50 bg-black/95 backdrop-blur-md flex items-center justify-center p-6 text-center text-white font-sans">
        <div className="w-full max-w-sm bg-gray-900 border border-red-500/30 rounded-3xl p-6 shadow-2xl flex flex-col items-center">
          <div className="w-16 h-16 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center mb-4">
            <FiAlertTriangle className="w-8 h-8" />
          </div>
          <h3 className="text-xl font-bold text-white mb-1">Verification Failed</h3>
          <span className="text-xs font-semibold px-3 py-1 rounded-full bg-red-500/20 text-red-300 border border-red-500/30 mb-4">
            Face Not Found in Person Records
          </span>
          <p className="text-sm text-gray-300 mb-6 leading-relaxed">
            Your face was not matched with registered Dahua biometric records. Please try again, or check if your face photo is enrolled on the Dahua device.
          </p>
          <button
            type="button"
            onClick={() => {
              hasAutoStartedRef.current = false;
              setFailCount(0);
              setNoFaceTimedOut(false);
              setVerificationStage("ready");
              setFaceDetected(false);
              setStatusMessage("Position your face within the frame");
              isVerifyingRef.current = false;
              descriptorBufferRef.current = [];
              missedFramesRef.current = 0;
              lastFaceDetectedAtRef.current = Date.now();
            }}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#237227] hover:bg-[#1c5c20] text-white text-sm font-bold shadow-lg transition-all active:scale-95 cursor-pointer"
          >
            <FiRefreshCw className="w-4 h-4" /> Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 w-screen h-screen z-50 bg-black flex flex-col justify-between overflow-hidden select-none font-sans">
      {/* Background Full-Screen Camera Viewport */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover transform -scale-x-100"
      />

      {/* Top and Bottom Gradient Overlays for High-Contrast Readability */}
      <div className="absolute top-0 inset-x-0 h-36 bg-gradient-to-b from-black/85 via-black/40 to-transparent pointer-events-none z-10" />
      <div className="absolute bottom-0 inset-x-0 h-44 bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-none z-10" />

      {/* 1. FLOATING TOP HEADER */}
      <header className="relative z-20 px-3 pt-3 sm:px-4 sm:pt-4">
        <div className="w-full max-w-md mx-auto backdrop-blur-md bg-black/60 border border-white/15 rounded-2xl px-3.5 py-2 flex items-center justify-between text-white shadow-2xl gap-2">
          {/* Brand Logo & Verification Title */}
          <div className="flex items-center gap-2 min-w-0">
            <Link
              to="/"
              aria-label="Back to Portal"
              title="Back to Portal"
              className="shrink-0 w-7 h-7 rounded-full bg-white/15 hover:bg-white/30 text-white flex items-center justify-center transition-colors"
            >
              <FiHome className="text-xs" />
            </Link>
            <img
              src="/image/logosidebar.jpg"
              alt="Multifactors Sales Attendance"
              className="h-5 sm:h-6 w-auto max-w-[85px] sm:max-w-[100px] object-contain rounded shrink-0"
            />
            <div className="flex items-center gap-1 min-w-0">
              <FiShield className="text-emerald-400 text-xs shrink-0" />
              <span className="text-[11px] sm:text-xs font-bold text-white tracking-wide whitespace-nowrap truncate">
                <span className="hidden xs:inline">Identity </span>Verification
              </span>
            </div>
          </div>

          {/* Clock, GPS & Online/Offline Status Indicator */}
          <div className="flex flex-col items-end shrink-0 pl-1">
            <div className="flex items-center gap-1.5">
              {!isOnline && (
                <span className="flex items-center gap-1 text-[9px] text-amber-300 font-bold bg-amber-500/25 px-1.5 py-0.5 rounded-full border border-amber-500/40">
                  <FiWifiOff className="text-[9px]" /> Offline
                </span>
              )}
              {formattedTime && (
                <div className="flex items-center gap-1 font-semibold font-mono text-[11px] text-white/95">
                  <FiClock className="text-emerald-400 text-[11px] shrink-0" />
                  <span className="whitespace-nowrap">{formattedTime}</span>
                </div>
              )}
            </div>
            <div
              className={`flex items-center gap-1 text-[10px] font-mono mt-0.5 ${
                locationStatus === "ok" || isValidGpsCoords(locationPoint)
                  ? "text-emerald-300"
                  : locationStatus === "denied"
                  ? "text-red-300"
                  : "text-amber-300"
              }`}
              title={locationPoint || locationMessage || "Auto-detecting GPS"}
            >
              <FiMapPin
                className={`text-[10px] shrink-0 ${
                  locationStatus === "ok" || isValidGpsCoords(locationPoint)
                    ? "text-emerald-400"
                    : locationStatus === "denied"
                    ? "text-red-400"
                    : "text-amber-400 animate-pulse"
                }`}
              />
              <span className="truncate max-w-[105px] xs:max-w-[125px] sm:max-w-[150px] text-right">
                {formatCompactLocation(locationPoint, locationStatus)}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* 2. CENTERED BIOMETRIC OVAL GUIDE & PROMINENT STATUS BANNER */}
      <div className="relative z-20 flex-1 flex flex-col items-center justify-center px-4">
        {/* Prominent Floating Instruction / Status Banner (Above the Oval) */}
        <div className="mb-4 min-h-[44px] flex items-center justify-center">
          {verificationStage === "success" ? (
            <div className="px-5 py-2.5 rounded-full bg-emerald-600/95 backdrop-blur-md text-white font-extrabold text-sm sm:text-base shadow-2xl flex items-center gap-2 border border-emerald-300 animate-scaleIn">
              <FiCheckCircle className="w-5 h-5 text-emerald-200" />
              <span>Verified: Welcome, {verifiedName}!</span>
            </div>
          ) : verificationStage === "verifying" ? (
            <div className="px-5 py-2.5 rounded-full bg-black/75 backdrop-blur-md text-emerald-300 font-bold text-xs sm:text-sm shadow-2xl flex items-center gap-2 border border-emerald-500/40">
              <FiRefreshCw className="w-4 h-4 animate-spin text-emerald-400" />
              <span>Matching Dahua photo records...</span>
            </div>
          ) : verificationStage === "retry" ? (
            <div className="px-4 py-2 rounded-full bg-amber-500/90 backdrop-blur-md text-white font-bold text-xs shadow-xl flex items-center gap-2 border border-amber-300">
              <FiAlertTriangle className="w-4 h-4 text-amber-200" />
              <span>Face not recognized. Looking again...</span>
            </div>
          ) : faceDetected ? (
            <div className="px-5 py-2 rounded-full bg-black/75 backdrop-blur-md text-emerald-300 font-bold text-xs sm:text-sm shadow-xl flex items-center gap-2 border border-emerald-500/40 animate-scaleIn">
              <FiUser className="w-4 h-4 text-emerald-400 animate-pulse" />
              <span>Face detected — Verifying identity...</span>
            </div>
          ) : (
            <div className="px-5 py-2 rounded-full bg-black/60 backdrop-blur-md text-gray-200 font-medium text-xs sm:text-sm shadow-lg flex items-center gap-2 border border-white/10">
              <FiUser className="w-4 h-4 text-emerald-400/80" />
              <span>Position your face within the frame</span>
            </div>
          )}
        </div>

        {/* Biometric Oval Guide & Framing Container */}
        <div className="relative flex items-center justify-center">
          {/* Futuristic Corner Reticle Brackets framing the round face guide */}
          <div className="absolute -inset-3 sm:-inset-4 pointer-events-none transition-all duration-300">
            {/* Top-Left */}
            <div
              className={`absolute top-0 left-0 w-6 h-6 sm:w-8 sm:h-8 border-t-2 border-l-2 rounded-tl-xl transition-all duration-300 ${
                verificationStage === "success"
                  ? "border-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.9)] scale-105"
                  : verificationStage === "verifying" || faceDetected
                  ? "border-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]"
                  : verificationStage === "retry"
                  ? "border-amber-400"
                  : "border-white/30"
              }`}
            />
            {/* Top-Right */}
            <div
              className={`absolute top-0 right-0 w-6 h-6 sm:w-8 sm:h-8 border-t-2 border-r-2 rounded-tr-xl transition-all duration-300 ${
                verificationStage === "success"
                  ? "border-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.9)] scale-105"
                  : verificationStage === "verifying" || faceDetected
                  ? "border-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]"
                  : verificationStage === "retry"
                  ? "border-amber-400"
                  : "border-white/30"
              }`}
            />
            {/* Bottom-Left */}
            <div
              className={`absolute bottom-0 left-0 w-6 h-6 sm:w-8 sm:h-8 border-b-2 border-l-2 rounded-bl-xl transition-all duration-300 ${
                verificationStage === "success"
                  ? "border-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.9)] scale-105"
                  : verificationStage === "verifying" || faceDetected
                  ? "border-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]"
                  : verificationStage === "retry"
                  ? "border-amber-400"
                  : "border-white/30"
              }`}
            />
            {/* Bottom-Right */}
            <div
              className={`absolute bottom-0 right-0 w-6 h-6 sm:w-8 sm:h-8 border-b-2 border-r-2 rounded-br-xl transition-all duration-300 ${
                verificationStage === "success"
                  ? "border-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.9)] scale-105"
                  : verificationStage === "verifying" || faceDetected
                  ? "border-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]"
                  : verificationStage === "retry"
                  ? "border-amber-400"
                  : "border-white/30"
              }`}
            />
          </div>

          {/* Oval Biometric Guide Frame */}
          <div
            className={`relative w-[265px] h-[330px] xs:w-[275px] xs:h-[345px] sm:w-[295px] sm:h-[365px] max-w-[80vw] max-h-[50vh] rounded-[50%] border-2 transition-all duration-300 flex items-center justify-center overflow-hidden ${
              verificationStage === "success"
                ? "border-emerald-300 shadow-[0_0_45px_rgba(52,211,153,0.9)] bg-emerald-500/20 scale-105"
                : verificationStage === "verifying"
                ? "border-emerald-400 shadow-[0_0_35px_rgba(52,211,153,0.8)] bg-emerald-500/15"
                : verificationStage === "retry"
                ? "border-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.5)] bg-amber-500/10"
                : faceDetected
                ? "border-emerald-400 shadow-[0_0_30px_rgba(52,211,153,0.65)] bg-emerald-500/10"
                : "border-white/40 border-dashed"
            }`}
          >
            {/* Animated Laser Scanning Beam when face is detected */}
            {(faceDetected || verificationStage === "verifying") && verificationStage !== "success" && (
              <div className="absolute inset-x-3 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent shadow-[0_0_12px_rgba(52,211,153,1)] biometric-scanner-beam pointer-events-none" />
            )}

            {/* Success Checkmark Icon inside frame when verified */}
            {verificationStage === "success" ? (
              <div className="w-20 h-20 rounded-full bg-emerald-500/90 text-white flex items-center justify-center shadow-2xl animate-scaleIn">
                <FiCheckCircle className="w-12 h-12 text-white" />
              </div>
            ) : (
              /* Subtle Center Reticle Mark */
              <div
                className={`w-3 h-3 rounded-full border pointer-events-none transition-colors duration-300 ${
                  faceDetected || verificationStage === "verifying"
                    ? "border-emerald-400/60 bg-emerald-400/20"
                    : "border-white/20"
                }`}
              />
            )}
          </div>
        </div>

        {/* Attempt counter pill if retry happened */}
        {failCount > 0 && verificationStage !== "success" && (
          <span className="mt-3 text-xs font-semibold px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
            Attempt {failCount}/6
          </span>
        )}
      </div>

      {/* 3. CAMERA PERMISSION / START OVERLAY (Shown if camera is not live) */}
      {!cameraActive && (
        <div className="absolute inset-0 bg-black/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center text-gray-300 z-30">
          {cameraError ? (
            <div className="flex flex-col items-center max-w-xs">
              <div className="w-14 h-14 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center mb-3">
                <FiAlertTriangle className="w-7 h-7" />
              </div>
              <p className="text-sm font-bold text-amber-300 mb-1.5">Camera Permission Needed</p>
              <p className="text-xs text-gray-300 mb-5 leading-relaxed">{cameraError}</p>
              <button
                type="button"
                onClick={handleManualStartCamera}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#237227] hover:bg-[#1c5c20] text-white text-xs font-bold shadow-lg transition-all active:scale-95 cursor-pointer"
              >
                <FiCamera className="w-4 h-4" /> Enable Camera
              </button>
            </div>
          ) : !modelsLoaded ? (
            <div className="flex flex-col items-center">
              <FiRefreshCw className="w-10 h-10 animate-spin text-[#237227] mb-3" />
              <p className="text-sm text-gray-200 font-semibold">{statusMessage}</p>
              <p className="text-xs text-gray-500 mt-1">Preparing biometric models...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center max-w-xs">
              <div className="w-14 h-14 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mb-3">
                <FiCamera className="w-7 h-7 animate-pulse" />
              </div>
              <p className="text-sm font-bold text-white mb-1.5">Ready for Verification</p>
              <p className="text-xs text-gray-400 mb-5">
                {noFaceTimedOut
                  ? `No face detected for ${Math.round(NO_FACE_TIMEOUT_MS / 1000)} seconds. Tap below to activate your front camera and verify your identity.`
                  : "Tap below to activate your front camera and verify your identity."}
              </p>
              <button
                type="button"
                onClick={handleManualStartCamera}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#237227] hover:bg-[#1c5c20] text-white text-sm font-bold shadow-xl transition-all active:scale-95 cursor-pointer"
              >
                <FiCamera className="w-4 h-4" /> Tap to Start Camera
              </button>
            </div>
          )}
        </div>
      )}

      {/* 4. BOTTOM FOOTER INSTRUCTION */}
      <footer className="relative z-20 pb-6 px-4 flex flex-col items-center text-center">
        <p className="text-[11px] text-gray-400 font-medium">
          Dahua Biometric Authentication • Multifactors Sales Attendance
        </p>
      </footer>
    </div>
  );
}
