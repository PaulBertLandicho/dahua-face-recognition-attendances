import React, { useEffect, useRef, useState } from "react";
import * as faceapi from "face-api.js/build/commonjs/index.js";
import Swal from "sweetalert2";

// RegistrationCamera: For registration only, supports Dahua stream or local webcam
import { supabase, SUPABASE_CONFIGURED } from "../mysqlClient";
import {
  toFloat32Array,
  normalizeDescriptor,
  euclideanDistance,
  averageDescriptors,
} from "../utils/faceUtils";

export default function RegistrationCamera({ onFaceScan, disabled }) {
  const [persons, setPersons] = useState([]);
  const isSwalOpen = () =>
    typeof Swal?.isVisible === "function" && Swal.isVisible();

  // Load persons with descriptors from Supabase
  useEffect(() => {
    async function loadPersons() {
      if (!SUPABASE_CONFIGURED || !supabase) {
        console.warn(
          "Supabase not configured; skipping person load in RegistrationCamera.",
        );
        return;
      }
      try {
        const { data, error } = await supabase
          .from("persons")
          .select("id, name, descriptor, registration_photo");
        if (error) {
          console.error("Error loading persons for registration:", error);
          Swal.fire({
            icon: "error",
            title: "Data Load Failed",
            text: "Could not load persons from the database. Check Supabase configuration and network.",
          });
          return;
        }
        if (data) {
          setPersons(
            data.map((p) => ({
              ...p,
              descriptor: p.descriptor
                ? Array.isArray(p.descriptor) && Array.isArray(p.descriptor[0])
                  ? averageDescriptors(p.descriptor)
                  : normalizeDescriptor(toFloat32Array(p.descriptor))
                : null,
            })),
          );
        }
      } catch (err) {
        console.error("Exception loading persons:", err);
        Swal.fire({
          icon: "error",
          title: "Data Load Error",
          text: "Unexpected error while loading persons.",
        });
      }
    }
    loadPersons();
  }, []);
  // If REACT_APP_WS_URL is not set, skip WebSocket and go straight to local webcam.
  const wsUrl = (process.env.REACT_APP_WS_URL || "").trim() || null;
  const imgRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const [useLocalCamera, setUseLocalCamera] = useState(false);
  // Removed unused frameReady state to fix ESLint warning
  const wsRef = useRef(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const animationFrameRef = useRef();
  const lastDetectRef = useRef(0);
  const descBufferRef = useRef([]);
  const BUFFER_SIZE = 5; // number of frames to stabilize descriptor
  const STABILITY_THRESHOLD = 0.08; // max distance from avg allowed across buffer
  // Tighter thresholds to reduce false-positive duplicate detection
  const FACE_MATCH_THRESHOLD = 0.28; // require smaller distance to consider a match
  const MATCH_MARGIN = 0.12; // require a clearer gap to the second-best
  // Cooldown to avoid firing onFaceScan repeatedly in quick succession
  const scanCooldownRef = useRef(0);
  const SCAN_COOLDOWN_MS = 1500; // milliseconds

  // Load face-api.js models
  useEffect(() => {
    async function loadModels() {
      const LOCAL_URL = "/models";
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(LOCAL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(LOCAL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(LOCAL_URL),
      ]);
      setModelsLoaded(true);
    }
    loadModels();
  }, []);

  // Handle manual 2x2-style photo upload for registration
  async function handleImageUpload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    // Allow selecting the same file again later
    event.target.value = "";

    if (!modelsLoaded) {
      Swal.fire({
        icon: "info",
        title: "Please wait",
        text: "Face recognition models are still loading. Try again in a moment.",
      });
      return;
    }

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result;
        if (typeof dataUrl !== "string") {
          Swal.fire({
            icon: "error",
            title: "Upload Failed",
            text: "Could not read the selected image file.",
          });
          return;
        }

        const img = new Image();
        img.onload = async () => {
          try {
            const detection = await faceapi
              .detectSingleFace(
                img,
                new faceapi.TinyFaceDetectorOptions({
                  inputSize: 320,
                  scoreThreshold: 0.5,
                }),
              )
              .withFaceLandmarks()
              .withFaceDescriptor();

            if (!detection || !detection.descriptor) {
              Swal.fire({
                icon: "warning",
                title: "No Face Detected",
                text: "No clear single face was detected in the uploaded photo. Please use a clear 2x2-style image with the face centered.",
              });
              return;
            }

            // Normalize descriptor and run the same duplicate check used for live camera
            const newDesc = normalizeDescriptor(
              toFloat32Array(detection.descriptor),
            );
            const UPLOAD_FACE_MATCH = 0.3;
            const UPLOAD_MARGIN = 0.08;

            const candidates = persons
              .filter((p) => p.descriptor)
              .map((p) => ({
                p,
                dist: euclideanDistance(newDesc, p.descriptor),
              }))
              .sort((a, b) => a.dist - b.dist);

            const best = candidates.length ? candidates[0] : null;
            const second = candidates.length > 1 ? candidates[1] : null;
            const margin = second ? second.dist - best.dist : Infinity;

            let isConfidentDuplicate = false;
            if (best && best.p && best.p.registration_photo) {
              if (second) {
                isConfidentDuplicate =
                  best.dist < UPLOAD_FACE_MATCH && margin >= UPLOAD_MARGIN;
              } else {
                // no second candidate, require a very strong match
                isConfidentDuplicate = best.dist < UPLOAD_FACE_MATCH * 0.8;
              }
            }

            if (isConfidentDuplicate) {
              const res = await Swal.fire({
                icon: "info",
                title: "Possible Duplicate",
                html: `This face is similar to <strong>${
                  best.p.name || "a person"
                }</strong> (ID: ${
                  best.p.id
                }) with distance <strong>${best.dist.toFixed(
                  3,
                )}</strong>.<br/>Registering a new person may create a duplicate.`,
                showCancelButton: true,
                confirmButtonText: "Register Anyway",
                cancelButtonText: "Cancel",
                focusCancel: true,
              });

              if (!res.isConfirmed) {
                return;
              }
            }

            if (typeof onFaceScan === "function") {
              const now = Date.now();
              if (now - scanCooldownRef.current >= SCAN_COOLDOWN_MS) {
                scanCooldownRef.current = now;
                if (!isSwalOpen())
                  onFaceScan({ descriptor: newDesc, photoDataUrl: dataUrl });
                else
                  console.log("Swal visible — skipping onFaceScan from upload");
              } else {
                console.log(
                  "RegistrationCamera: suppressed upload scan due to cooldown",
                );
              }
            }
          } catch (err) {
            console.error("Error processing uploaded image:", err);
            Swal.fire({
              icon: "error",
              title: "Processing Error",
              text: "There was a problem analyzing the uploaded photo. Please try a clearer image.",
            });
          }
        };
        img.onerror = () => {
          Swal.fire({
            icon: "error",
            title: "Invalid Image",
            text: "The selected file is not a valid image.",
          });
        };
        img.src = dataUrl;
      };
      reader.onerror = () => {
        Swal.fire({
          icon: "error",
          title: "Read Error",
          text: "Could not read the selected file.",
        });
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error("Upload handler error:", err);
      Swal.fire({
        icon: "error",
        title: "Upload Error",
        text: "Unexpected error while handling the uploaded image.",
      });
    }
  }

  // Setup Dahua stream via WebSocket or fallback to webcam
  useEffect(() => {
    let disposed = false;

    // If no WebSocket URL configured, immediately use local webcam.
    if (!wsUrl) {
      setUseLocalCamera(true);
      return () => {
        disposed = true;
        if (wsRef.current) wsRef.current.close();
      };
    }

    setUseLocalCamera(false);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const ws = new window.WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => {};
    ws.onerror = () => {
      if (!disposed) {
        setUseLocalCamera(true);
      }
    };
    ws.onclose = () => {
      if (!disposed) {
        setUseLocalCamera(true);
      }
    };
    ws.onmessage = (event) => {
      if (!disposed && imgRef.current) {
        imgRef.current.src = event.data;
      }
    };
    return () => {
      disposed = true;
      if (wsRef.current) wsRef.current.close();
    };
  }, [wsUrl]);

  // Fallback: Use local webcam if Dahua stream fails
  useEffect(() => {
    if (!useLocalCamera) return;
    let stream = null;
    const initialVideoRef = videoRef.current;
    async function startLocalCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (initialVideoRef) {
          initialVideoRef.srcObject = stream;
          initialVideoRef.onloadedmetadata = () => {
            initialVideoRef.play();
          };
        }
      } catch (err) {
        Swal.fire({
          icon: "error",
          title: "Camera Not Found",
          text: "No camera device was found or access was denied. Please connect a camera and allow browser access.",
        });
      }
    }
    startLocalCamera();
    return () => {
      if (initialVideoRef) initialVideoRef.srcObject = null;
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }, [useLocalCamera]);

  // Face detection loop
  useEffect(() => {
    if (!modelsLoaded || disabled) return;
    let isMounted = true;
    async function detect() {
      if (!isMounted) return;
      const source = useLocalCamera ? videoRef.current : imgRef.current;
      if (!source) {
        animationFrameRef.current = requestAnimationFrame(detect);
        return;
      }
      // Ensure valid frame
      const isVideo = useLocalCamera;
      if (
        (!isVideo && (!source.complete || source.naturalWidth === 0)) ||
        (isVideo && source.readyState !== 4)
      ) {
        animationFrameRef.current = requestAnimationFrame(detect);
        return;
      }
      // Detect face
      const detection = await faceapi
        .detectSingleFace(
          source,
          new faceapi.TinyFaceDetectorOptions({
            inputSize: 320,
            scoreThreshold: 0.5,
          }),
        )
        .withFaceLandmarks()
        .withFaceDescriptor();
      // Draw mesh — validate detection and box before drawing to avoid face-api errors
      const canvas = canvasRef.current;
      if (canvas && source) {
        // Match canvas pixel size to source to avoid scaling issues
        const srcWidth = isVideo ? source.videoWidth : source.naturalWidth;
        const srcHeight = isVideo ? source.videoHeight : source.naturalHeight;
        if (srcWidth && srcHeight) {
          canvas.width = srcWidth;
          canvas.height = srcHeight;
        }

        // Throttle detection drawing to reduce jitter and CPU (100ms)
        const now = Date.now();
        const MIN_MS = 100;
        if (now - lastDetectRef.current < MIN_MS) {
          animationFrameRef.current = requestAnimationFrame(detect);
          return;
        }
        lastDetectRef.current = now;

        const box = detection?.detection?.box;
        const boxValid =
          box &&
          [box.x, box.y, box.width, box.height].every(
            (v) => typeof v === "number" && !isNaN(v),
          );

        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (detection && boxValid) {
          try {
            // Resize detection coordinates to the canvas/display size
            const displaySize = { width: canvas.width, height: canvas.height };
            const resized = faceapi.resizeResults(detection, displaySize);

            // Draw bounding box and landmarks using resized results
            faceapi.draw.drawDetections(canvas, resized);
            faceapi.draw.drawFaceLandmarks(canvas, resized);
          } catch (err) {
            console.warn("Error drawing face landmarks:", err);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
        } else {
          // Nothing valid to draw — canvas already cleared
        }
      }
      // If face detected, collect descriptors across frames and only act when stable
      if (detection && detection.descriptor) {
        const rawDesc = normalizeDescriptor(
          toFloat32Array(detection.descriptor),
        );

        // Push to circular buffer
        const buf = descBufferRef.current || [];
        buf.push(rawDesc);
        if (buf.length > BUFFER_SIZE) buf.shift();
        descBufferRef.current = buf;

        // Only proceed when buffer is filled and stable
        if (buf.length >= BUFFER_SIZE) {
          const avgDesc = averageDescriptors(buf);
          const deviations = buf.map((d) => euclideanDistance(d, avgDesc));
          const maxDev = Math.max(...deviations);
          // If descriptors are not stable across frames, wait for more stable frames
          if (maxDev > STABILITY_THRESHOLD) {
            // skip this round — wait for more consistent frames
          } else {
            // Stable averaged descriptor — perform duplicate check with stricter thresholds
            const candidates = persons
              .filter((p) => p.descriptor)
              .map((p) => ({
                p,
                dist: euclideanDistance(avgDesc, p.descriptor),
              }))
              .sort((a, b) => a.dist - b.dist);

            const best = candidates.length ? candidates[0] : null;
            const second = candidates.length > 1 ? candidates[1] : null;
            const margin = second ? second.dist - best.dist : Infinity;

            console.log(
              "REGISTRATION DEBUG: averaged candidate distances=",
              candidates.map((c) => ({
                id: c.p.id,
                name: c.p.name,
                dist: c.dist,
              })),
            );

            // More conservative duplicate decision for live capture
            let isConfidentDuplicate = false;
            if (best && best.p && best.p.registration_photo) {
              if (second) {
                isConfidentDuplicate =
                  best.dist < FACE_MATCH_THRESHOLD && margin >= MATCH_MARGIN;
              } else {
                isConfidentDuplicate = best.dist < FACE_MATCH_THRESHOLD * 0.8;
              }
            }

            console.log("REGISTRATION duplicate-check", {
              best: best?.dist,
              second: second?.dist,
              margin,
              isConfidentDuplicate,
            });

            if (isConfidentDuplicate) {
              const res = await Swal.fire({
                icon: "info",
                title: "Possible Duplicate",
                html: `This face is similar to <strong>${
                  best.p.name || "a person"
                }</strong> (ID: ${best.p.id}) with distance <strong>${best.dist.toFixed(
                  3,
                )}</strong>.<br/>Registering a new person may create a duplicate.`,
                showCancelButton: true,
                confirmButtonText: "Register Anyway",
                cancelButtonText: "Cancel",
                focusCancel: true,
              });

              if (res.isConfirmed) {
                // Capture a frame to include with the scan payload
                const frameCanvas = document.createElement("canvas");
                frameCanvas.width = canvas
                  ? canvas.width
                  : (isVideo ? source.videoWidth : source.naturalWidth) || 640;
                frameCanvas.height = canvas
                  ? canvas.height
                  : (isVideo ? source.videoHeight : source.naturalHeight) ||
                    480;
                const fctx = frameCanvas.getContext("2d");
                fctx.drawImage(
                  source,
                  0,
                  0,
                  frameCanvas.width,
                  frameCanvas.height,
                );
                const photoDataUrl = frameCanvas.toDataURL("image/jpeg", 0.85);
                // clear buffer so next person starts fresh
                descBufferRef.current = [];
                if (typeof onFaceScan === "function") {
                  const now = Date.now();
                  if (now - scanCooldownRef.current >= SCAN_COOLDOWN_MS) {
                    scanCooldownRef.current = now;
                    if (!isSwalOpen())
                      onFaceScan({ descriptor: avgDesc, photoDataUrl });
                    else
                      console.log(
                        "Swal visible — skipping onFaceScan after duplicate confirm",
                      );
                  } else {
                    console.log(
                      "RegistrationCamera: suppressed duplicate-confirmed scan due to cooldown",
                    );
                  }
                }
              }
            } else {
              // Not a duplicate — send averaged descriptor as a single stable scan
              const frameCanvas = document.createElement("canvas");
              frameCanvas.width = canvas
                ? canvas.width
                : (isVideo ? source.videoWidth : source.naturalWidth) || 640;
              frameCanvas.height = canvas
                ? canvas.height
                : (isVideo ? source.videoHeight : source.naturalHeight) || 480;
              const fctx = frameCanvas.getContext("2d");
              fctx.drawImage(
                source,
                0,
                0,
                frameCanvas.width,
                frameCanvas.height,
              );
              const photoDataUrl = frameCanvas.toDataURL("image/jpeg", 0.85);
              descBufferRef.current = [];
              if (typeof onFaceScan === "function") {
                const now = Date.now();
                if (now - scanCooldownRef.current >= SCAN_COOLDOWN_MS) {
                  scanCooldownRef.current = now;
                  if (!isSwalOpen())
                    onFaceScan({ descriptor: avgDesc, photoDataUrl });
                  else
                    console.log(
                      "Swal visible — skipping onFaceScan from live capture",
                    );
                } else {
                  console.log(
                    "RegistrationCamera: suppressed live scan due to cooldown",
                  );
                }
              }
            }
          }
        }
        // else wait until buffer fills
      }
      // Pause detection until modal closes (handled by disabled prop)
      // schedule next frame
      animationFrameRef.current = requestAnimationFrame(detect);
    }
    // start detection loop
    animationFrameRef.current = requestAnimationFrame(detect);
    return () => {
      isMounted = false;
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [modelsLoaded, useLocalCamera, disabled, onFaceScan, persons]);

  return (
    <div>
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16/9",
          background: "#0b1120",
        }}
      >
        {useLocalCamera ? (
          <video
            ref={videoRef}
            style={{ width: "100%", borderRadius: 12 }}
            autoPlay
            muted
            playsInline
          />
        ) : (
          <img
            ref={imgRef}
            alt="Camera Stream"
            style={{ width: "100%", borderRadius: 12 }}
          />
        )}
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
      </div>

      {/* Optional: manual photo upload for registration (e.g., 2x2 ID photo) */}
      <div
        style={{
          marginTop: 12,
          display: "flex",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleImageUpload}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          style={{
            padding: "6px 12px",
            borderRadius: 8,
            border: "1px solid #4b5563",
            background: "#111827",
            color: "#e5e7eb",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Upload 2x2 Photo Instead
        </button>
      </div>
    </div>
  );
}
