import * as faceapi from "face-api.js";
import { supabase } from "../mysqlClient";
import { normalizeDescriptor } from "./faceUtils";

let modelsLoadingPromise = null;

export async function ensureFaceModelsLoaded() {
  if (
    faceapi.nets.tinyFaceDetector.isLoaded &&
    faceapi.nets.faceLandmark68Net.isLoaded &&
    faceapi.nets.faceRecognitionNet.isLoaded
  ) {
    return true;
  }

  if (modelsLoadingPromise) return modelsLoadingPromise;

  modelsLoadingPromise = (async () => {
    const LOCAL_URL = "/models";
    const CDN_URL = "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights";
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(LOCAL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(LOCAL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(LOCAL_URL),
      ]);
    } catch (e) {
      console.warn("Failed loading models locally, falling back to CDN:", e.message);
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(CDN_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(CDN_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(CDN_URL),
      ]);
    }
    return true;
  })();

  return modelsLoadingPromise;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

/**
 * Builds and saves 128-d face descriptors for persons using their registration_photo.
 *
 * @param {Object} options
 * @param {Array} [options.persons] - list of persons, or if not provided, queries from database
 * @param {Function} [options.onProgress] - callback: ({ current, total, name })
 * @param {boolean} [options.force] - if true, rebuilds even for persons with an existing descriptor
 * @returns {Promise<Object>} summary stats
 */
export async function buildDescriptors({ persons: inputPersons, onProgress, force = false } = {}) {
  await ensureFaceModelsLoaded();

  let persons = inputPersons;
  if (!persons || !Array.isArray(persons)) {
    const { data, error } = await supabase
      .from("persons")
      .select("id, name, registration_photo, descriptor")
      .eq("archived", 0);
    if (error) throw error;
    persons = data || [];
  }

  const targets = persons.filter((p) => {
    if (!p.registration_photo) return false;
    if (force) return true;
    return !p.descriptor;
  });

  const summary = {
    total: persons.length,
    targets: targets.length,
    built: 0,
    skippedExisting: persons.filter((p) => p.descriptor && !force).length,
    skippedNoPhoto: persons.filter((p) => !p.registration_photo).length,
    failedNoFace: 0,
    failedMultipleFaces: 0,
    errors: [],
  };

  const detectionOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 });

  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    if (onProgress) {
      onProgress({ current: i + 1, total: targets.length, name: p.name || p.id });
    }

    try {
      const img = await loadImageElement(p.registration_photo);
      const detections = await faceapi
        .detectAllFaces(img, detectionOptions)
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (!detections || detections.length === 0) {
        summary.failedNoFace++;
        summary.errors.push(`${p.name || p.id}: No face detected in photo`);
        continue;
      }

      // Pick the most prominent / largest face in the photo
      const targetDetection = detections.reduce((best, curr) => {
        const areaBest = (best.detection?.box?.width || 0) * (best.detection?.box?.height || 0);
        const areaCurr = (curr.detection?.box?.width || 0) * (curr.detection?.box?.height || 0);
        return areaCurr > areaBest ? curr : best;
      }, detections[0]);

      const rawDesc = targetDetection.descriptor;
      const normDesc = normalizeDescriptor(rawDesc);
      if (!normDesc) {
        summary.errors.push(`${p.name || p.id}: Normalization failed`);
        continue;
      }

      const descArray = Array.from(normDesc);
      const { error: updateErr } = await supabase
        .from("persons")
        .update({ descriptor: JSON.stringify(descArray) })
        .eq("id", p.id);

      if (updateErr) {
        summary.errors.push(`${p.name || p.id}: DB update failed (${updateErr.message})`);
        continue;
      }

      summary.built++;
    } catch (err) {
      console.warn(`[buildFaceDescriptors] Error on person ${p.id}:`, err);
      summary.errors.push(`${p.name || p.id}: ${err.message}`);
    }
  }

  return summary;
}
