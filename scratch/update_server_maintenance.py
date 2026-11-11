import re

server_path = "server.js"
with open(server_path, "r", encoding="utf-8") as f:
    server_content = f.read()

# Maintenance logic to insert before static routes
maintenance_code = """
// ==========================================
// AUTOMATED STORAGE MAINTENANCE & PHOTO PRUNING
// ==========================================
const PHOTO_RETENTION_DAYS = Number(process.env.PHOTO_RETENTION_DAYS || 60);

async function pruneOldAttendancePhotos(days = PHOTO_RETENTION_DAYS) {
  try {
    const daysNum = Math.max(1, Number(days) || 60);
    const sql = `
      UPDATE attendance 
      SET photo = NULL 
      WHERE photo IS NOT NULL 
        AND device_time < DATE_SUB(NOW(), INTERVAL ? DAY)
    `;
    const [result] = await pool.query(sql, [daysNum]);
    if (result && result.affectedRows > 0) {
      console.log(`[Storage Optimization] Pruned photos from ${result.affectedRows} attendance records older than ${daysNum} days.`);
    }
    return { success: true, prunedCount: result.affectedRows, days: daysNum };
  } catch (err) {
    console.error("[Storage Optimization] Failed to prune old attendance photos:", err.message);
    return { success: false, error: err.message };
  }
}

// Storage stats endpoint for dashboard monitoring
app.get("/api/maintenance/storage-stats", async (req, res) => {
  try {
    const [[totalRecords]] = await pool.query("SELECT COUNT(*) AS total FROM attendance");
    const [[recordsWithPhoto]] = await pool.query("SELECT COUNT(*) AS with_photo FROM attendance WHERE photo IS NOT NULL");
    const [[oldPhotosCount]] = await pool.query(
      "SELECT COUNT(*) AS old_photos FROM attendance WHERE photo IS NOT NULL AND device_time < DATE_SUB(NOW(), INTERVAL ? DAY)",
      [PHOTO_RETENTION_DAYS]
    );

    return res.json({
      totalAttendanceRecords: totalRecords?.total || 0,
      recordsWithPhotos: recordsWithPhoto?.with_photo || 0,
      photosOlderThanRetention: oldPhotosCount?.old_photos || 0,
      retentionDaysConfigured: PHOTO_RETENTION_DAYS,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Maintenance endpoint: Prune attendance photos older than N days (default 60)
app.post("/api/maintenance/prune-photos", async (req, res) => {
  try {
    const days = req.body?.days || req.query?.days || PHOTO_RETENTION_DAYS;
    const result = await pruneOldAttendancePhotos(days);
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    return res.json({
      message: `Pruned photos from ${result.prunedCount} attendance records older than ${result.days} days.`,
      prunedCount: result.prunedCount,
      days: result.days,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Maintenance endpoint: Optimize MySQL tables to reclaim freed disk space
app.post("/api/maintenance/optimize-tables", async (req, res) => {
  try {
    const [attResult] = await pool.query("OPTIMIZE TABLE attendance");
    const [perResult] = await pool.query("OPTIMIZE TABLE persons");
    return res.json({
      message: "Tables optimized successfully.",
      attendance: attResult,
      persons: perResult,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
"""

target_health = """app.get("/health/stream", (req, res) => res.json({ ...streamState }));
app.get("/health", (req, res) => res.json({ status: "ok" }));"""

replacement_health = target_health + "\n" + maintenance_code

# In listen block, trigger maintenance and periodic timers
target_listen = """app.listen(PORT, () => {
  console.log(`Server running at port ${PORT}`);
  setTimeout(() => {
    regeneratePayrollPeriodsIfNeeded();
  }, 4000);
});"""

replacement_listen = """app.listen(PORT, () => {
  console.log(`Server running at port ${PORT}`);
  setTimeout(() => {
    regeneratePayrollPeriodsIfNeeded();
    // Storage optimization: prune photos older than retention policy on startup
    pruneOldAttendancePhotos(PHOTO_RETENTION_DAYS);
    clearHlsArtifacts();
  }, 4000);

  // Periodic daily retention cleaner (every 24 hours)
  setInterval(() => {
    pruneOldAttendancePhotos(PHOTO_RETENTION_DAYS);
  }, 24 * 60 * 60 * 1000);

  // Periodic HLS artifact cleaner (every 30 minutes)
  setInterval(() => {
    clearHlsArtifacts();
  }, 30 * 60 * 1000);
});"""

norm_server = server_content.replace("\r\n", "\n")
norm_th = target_health.replace("\r\n", "\n")
norm_rh = replacement_health.replace("\r\n", "\n")
norm_tl = target_listen.replace("\r\n", "\n")
norm_rl = replacement_listen.replace("\r\n", "\n")

if norm_th in norm_server and norm_tl in norm_server:
    updated = norm_server.replace(norm_th, norm_rh, 1).replace(norm_tl, norm_rl, 1)
    if "\r\n" in server_content:
        updated = updated.replace("\n", "\r\n")
    with open(server_path, "w", encoding="utf-8") as f:
        f.write(updated)
    print("SUCCESS: server.js updated with storage maintenance.")
else:
    print("FAILED: Could not find targets in server.js.")
