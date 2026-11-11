uas_path = "src/CameraAttendance/UserAttendanceScanner.js"
with open(uas_path, "r", encoding="utf-8") as f:
    uas_content = f.read()

uas_target = """    const canvas = canvasRef.current || document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);

    if (facingMode === "user") {
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
    ctx.restore();

    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);"""

uas_replacement = """    const MAX_DIM = 320;
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

    const dataUrl = canvas.toDataURL("image/jpeg", 0.65);"""

norm_uas = uas_content.replace("\r\n", "\n")
norm_uas_target = uas_target.replace("\r\n", "\n")
norm_uas_replacement = uas_replacement.replace("\r\n", "\n")

if norm_uas_target in norm_uas:
    updated_uas = norm_uas.replace(norm_uas_target, norm_uas_replacement, 1)
    if "\r\n" in uas_content:
        updated_uas = updated_uas.replace("\n", "\r\n")
    with open(uas_path, "w", encoding="utf-8") as f:
        f.write(updated_uas)
    print("SUCCESS: UserAttendanceScanner.js updated.")
else:
    print("FAILED: UserAttendanceScanner.js target not found.")
