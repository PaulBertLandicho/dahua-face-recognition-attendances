rc_path = "src/CameraAttendance/RegistrationCamera.js"
with open(rc_path, "r", encoding="utf-8") as f:
    rc_content = f.read()

# First occurrence (inside duplicate confirm)
t1 = """                frameCanvas.width = canvas
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
                const photoDataUrl = frameCanvas.toDataURL("image/jpeg", 0.85);"""

r1 = """                const rawW = canvas ? canvas.width : (isVideo ? source.videoWidth : source.naturalWidth) || 640;
                const rawH = canvas ? canvas.height : (isVideo ? source.videoHeight : source.naturalHeight) || 480;
                const maxDim = 380;
                let fW = rawW, fH = rawH;
                if (fW > fH && fW > maxDim) { fH = Math.round((fH * maxDim) / fW); fW = maxDim; }
                else if (fH > maxDim) { fW = Math.round((fW * maxDim) / fH); fH = maxDim; }
                frameCanvas.width = fW;
                frameCanvas.height = fH;
                const fctx = frameCanvas.getContext("2d");
                fctx.drawImage(source, 0, 0, fW, fH);
                const photoDataUrl = frameCanvas.toDataURL("image/jpeg", 0.70);"""

# Second occurrence (normal live capture)
t2 = """              const frameCanvas = document.createElement("canvas");
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
              const photoDataUrl = frameCanvas.toDataURL("image/jpeg", 0.85);"""

r2 = """              const frameCanvas = document.createElement("canvas");
              const rawW2 = canvas ? canvas.width : (isVideo ? source.videoWidth : source.naturalWidth) || 640;
              const rawH2 = canvas ? canvas.height : (isVideo ? source.videoHeight : source.naturalHeight) || 480;
              const maxDim2 = 380;
              let fW2 = rawW2, fH2 = rawH2;
              if (fW2 > fH2 && fW2 > maxDim2) { fH2 = Math.round((fH2 * maxDim2) / fW2); fW2 = maxDim2; }
              else if (fH2 > maxDim2) { fW2 = Math.round((fW2 * maxDim2) / fH2); fH2 = maxDim2; }
              frameCanvas.width = fW2;
              frameCanvas.height = fH2;
              const fctx = frameCanvas.getContext("2d");
              fctx.drawImage(source, 0, 0, fW2, fH2);
              const photoDataUrl = frameCanvas.toDataURL("image/jpeg", 0.70);"""

norm_rc = rc_content.replace("\r\n", "\n")
norm_t1 = t1.replace("\r\n", "\n")
norm_r1 = r1.replace("\r\n", "\n")
norm_t2 = t2.replace("\r\n", "\n")
norm_r2 = r2.replace("\r\n", "\n")

if norm_t1 in norm_rc and norm_t2 in norm_rc:
    updated_rc = norm_rc.replace(norm_t1, norm_r1, 1).replace(norm_t2, norm_r2, 1)
    if "\r\n" in rc_content:
        updated_rc = updated_rc.replace("\n", "\r\n")
    with open(rc_path, "w", encoding="utf-8") as f:
        f.write(updated_rc)
    print("SUCCESS: RegistrationCamera.js updated.")
else:
    print("FAILED: RegistrationCamera.js targets not found.")
