import React, { useState, useCallback, useRef, useEffect } from "react";

import Swal from "sweetalert2";
import RegistrationCamera from "../CameraAttendance/RegistrationCamera";
import PersonDetails from "./PersonDetails";
import { FiX } from "react-icons/fi";
import Icon from "../components/Icon";

// --- Voice sound assets (simple beep/notification) ---
const playVoice = (type = "info") => {
  const messages = {
    success: "Operation completed successfully",
    warning: "Warning. Please check your input",
    error: "Error occurred. Please try again",
    info: "Notification received",
  };

  try {
    // Stop any ongoing speech
    window.speechSynthesis.cancel();

    const speech = new SpeechSynthesisUtterance(
      messages[type] || messages.info
    );

    // 🌐 Language
    speech.lang = "en-US";

    // ⚙️ Voice settings
    speech.rate = 1; // speed (0.8–1.2 is natural)
    speech.pitch = 1; // tone (0–2)
    speech.volume = 1; // volume (0–1)

    // 🎤 Optional: Choose a better voice (if available)
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(
      (v) => v.lang === "en-US" && v.name.toLowerCase().includes("female")
    );
    if (preferredVoice) {
      speech.voice = preferredVoice;
    }

    window.speechSynthesis.speak(speech);
  } catch (err) {
    console.log("Voice error:", err);
  }
};

export default function PersonRegistration({ initialImageUrl = null }) {
  const [countdown, setCountdown] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [pendingScan, setPendingScan] = useState(null);
  const [cameraActive, setCameraActive] = useState(false);
  const modalTimerRef = useRef(null);

  // This handler will be called by CameraPlayer when a new face is detected (not in attendance DB)
  // Automatically trigger modal with scanPayload (including photoDataUrl) when a new face is detected
  const handleFaceScan = useCallback(
    (scanPayload) => {
      // Defensive: ignore if already showing modal, pending scan, or missing payload
      if (!scanPayload || showModal || pendingScan) return;
      // Accept both plain arrays and typed arrays (Float32Array)
      if (
        !scanPayload.descriptor ||
        !(
          Array.isArray(scanPayload.descriptor) ||
          (scanPayload.descriptor &&
            typeof scanPayload.descriptor.length === "number")
        ) ||
        scanPayload.descriptor.length === 0
      )
        return;
      if (!scanPayload.photoDataUrl) {
        playVoice("warning");
        Swal.fire({
          icon: "warning",
          title: "No Photo Captured",
          text: "Face scan did not include a photo. Please try again.",
          timer: 1800,
          showConfirmButton: false,
        });
        return;
      }
      // Show a 3-second countdown before opening the modal
      setCountdown(3);
      let seconds = 3;
      const interval = setInterval(() => {
        seconds -= 1;
        setCountdown(seconds);
        if (seconds <= 0) {
          clearInterval(interval);
          setCountdown(0);
          setPendingScan(scanPayload);
          if (modalTimerRef.current) clearTimeout(modalTimerRef.current);
          modalTimerRef.current = setTimeout(() => {
            setShowModal(true);
            modalTimerRef.current = null;
          }, 100); // minimal delay after countdown
        }
      }, 1000);
    },
    [showModal, pendingScan]
  );

  const closeModal = () => {
    setShowModal(false);
    setPendingScan(null);
    if (modalTimerRef.current) {
      clearTimeout(modalTimerRef.current);
      modalTimerRef.current = null;
    }
  };

  // If an initial static image URL is provided, open the registration modal
  useEffect(() => {
    if (initialImageUrl) {
      // create a minimal scanPayload with photo only
      const payload = { photoDataUrl: initialImageUrl, descriptor: null };
      setPendingScan(payload);
      setShowModal(true);
    }
    // only run on mount/when initialImageUrl changes
  }, [initialImageUrl]);

  // Ensure SweetAlert2 is displayed above this modal by increasing its z-index
  useEffect(() => {
    const styleId = "swal2-zindex-fix";
    if (document.getElementById(styleId)) return;
    const s = document.createElement("style");
    s.id = styleId;
    s.textContent = `
      .swal2-container, .swal2-backdrop, .swal2-popup {
        z-index: 100000 !important;
      }
    `;
    document.head.appendChild(s);
    return () => {
      const el = document.getElementById(styleId);
      if (el) el.remove();
    };
  }, []);

  // Prevent background page from scrolling while the Person Details modal is open
  useEffect(() => {
    if (!showModal) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [showModal]);

  return (
    <div className="mx-auto p-7 md:p-9 max-w-full bg-white min-h-screen text-gray-800 font-sans">
      {/* Header */}
      <div className="mb-8 flex flex-col items-center text-center gap-1.5">
        <h1 className="text-[2rem] md:text-4xl font-extrabold m-0 tracking-tight inline-block text-gray-800">
          Register Person Camera
        </h1>
        <div className="h-1 w-24 bg-[#237227] rounded-full mt-2" />
      </div>

      <div className="max-w-[600px] mx-auto p-6 bg-white rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.08)] border border-gray-100">
        {/* Countdown overlay */}
        {countdown > 0 && (
          <div className="fixed inset-0 bg-black/45 flex items-center justify-center z-[110000] backdrop-blur-sm">
            <div className="bg-white rounded-3xl py-12 px-16 text-5xl font-bold text-[#237227] shadow-2xl border-2 border-[#237227]">
              {countdown}
            </div>
          </div>
        )}

        {/* Camera Viewport */}
        <div className="mb-2 min-h-[380px] bg-slate-900 rounded-xl overflow-hidden relative flex items-center justify-center">
          {cameraActive ? (
            <RegistrationCamera
              onFaceScan={handleFaceScan}
              disabled={showModal || countdown > 0}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-300 p-4">
              <div className="mb-3 text-sm font-medium">
                Camera is currently off.
              </div>
              <button
                type="button"
                onClick={() => setCameraActive(true)}
                className="py-2 px-5 rounded-full border border-gray-600 bg-gray-800 hover:bg-gray-700 text-gray-200 cursor-pointer text-xs font-semibold transition-colors focus:outline-none"
              >
                Open Camera
              </button>
            </div>
          )}
        </div>

        {cameraActive && (
          <div className="mb-4 text-right">
            <button
              type="button"
              onClick={() => setCameraActive(false)}
              className="py-1.5 px-3 rounded-full border border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-600 cursor-pointer text-xs font-medium transition-colors focus:outline-none"
            >
              Close Camera
            </button>
          </div>
        )}

        {/* Registration Modal Overlay */}
        {showModal && (
          <div className="fixed inset-0 bg-black/50 z-[1000] flex items-center justify-center p-4 backdrop-blur-sm">
            <div className="relative bg-white rounded-2xl p-8 w-[600px] max-w-[95vw] h-[80vh] max-h-[80vh] shadow-2xl border border-gray-200 overflow-y-auto">
              <button
                onClick={closeModal}
                className="absolute top-3 right-4 bg-transparent border-none text-gray-500 hover:text-gray-800 text-2xl cursor-pointer leading-none p-1 focus:outline-none"
              >
                <Icon as={FiX} size={22} ariaLabel="Close" />
              </button>
              <PersonDetails
                scanPayload={pendingScan}
                onComplete={closeModal}
                hidePersonTable
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
