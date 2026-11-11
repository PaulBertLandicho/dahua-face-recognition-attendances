import os

file_path = "src/AdminPage/PersonsTable.js"
with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Update imports
target_import = """import { syncDahuaUsers } from "../utils/dahuaApi";"""
replacement_import = """import { syncDahuaUsers } from "../utils/dahuaApi";
import { buildDescriptors } from "../utils/buildFaceDescriptors";
import { FiCpu } from "react-icons/fi";"""

# 2. Add state
target_state = """  const [syncingDahuaUsers, setSyncingDahuaUsers] = useState(false);"""
replacement_state = """  const [syncingDahuaUsers, setSyncingDahuaUsers] = useState(false);
  const [buildingDescriptors, setBuildingDescriptors] = useState(false);"""

# 3. Add handleRebuildFaceData function and update handleSyncDahuaPersons
target_sync_func = """    try {
      const data = await syncDahuaUsers();

      try {
        const { data: refreshedPersons, error: refreshError } = await supabase
          .from("persons")
          .select("*");
        if (!refreshError) setPersons(refreshedPersons || []);
      } catch (refreshErr) {}

      const count = data?.count || 0;"""

replacement_sync_func = """    try {
      const data = await syncDahuaUsers();

      // Automatically generate face descriptors for newly synced users with photos
      try {
        await buildDescriptors({
          onProgress: ({ current, total, name }) => {
            const el = Swal.getHtmlContainer()?.querySelector("p");
            if (el) el.textContent = `Extracting face vector for ${name} (${current} of ${total})...`;
          },
          force: false,
        });
      } catch (descErr) {
        console.warn("[Dahua Sync] Auto-build descriptors warning:", descErr);
      }

      try {
        const { data: refreshedPersons, error: refreshError } = await supabase
          .from("persons")
          .select("*");
        if (!refreshError) setPersons(refreshedPersons || []);
      } catch (refreshErr) {}

      const count = data?.count || 0;"""

# Rebuild Face Data handler
rebuild_func = """
  const handleRebuildFaceData = async (force = true) => {
    if (buildingDescriptors) return;
    setBuildingDescriptors(true);

    Swal.fire({
      title: "Building Face Recognition Data...",
      html: `
        <div class="flex flex-col items-center justify-center py-2 text-center font-sans">
          <p class="text-sm text-gray-600 mb-2" id="face-build-progress">
            Initializing face recognition models...
          </p>
        </div>
      `,
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      width: "420px",
      didOpen: () => Swal.showLoading(),
    });

    try {
      const summary = await buildDescriptors({
        onProgress: ({ current, total, name }) => {
          const el = document.getElementById("face-build-progress");
          if (el) el.textContent = `Processing face for ${name} (${current} of ${total})...`;
        },
        force,
      });

      const { data: refreshedPersons } = await supabase.from("persons").select("*");
      if (refreshedPersons) setPersons(refreshedPersons);

      Swal.fire({
        icon: "success",
        title: "Face Data Rebuilt!",
        html: `
          <div class="text-sm text-gray-600 space-y-1 text-left max-w-xs mx-auto font-sans">
            <p><strong>Processed:</strong> ${summary.built} person(s)</p>
            ${summary.failedNoFace > 0 ? `<p class="text-amber-600"><strong>No face detected:</strong> ${summary.failedNoFace}</p>` : ""}
            ${summary.failedMultipleFaces > 0 ? `<p class="text-amber-600"><strong>Multiple faces:</strong> ${summary.failedMultipleFaces}</p>` : ""}
            ${summary.skippedNoPhoto > 0 ? `<p class="text-gray-500"><strong>No photo:</strong> ${summary.skippedNoPhoto}</p>` : ""}
          </div>
        `,
        confirmButtonText: "OK",
        buttonsStyling: false,
        customClass: {
          confirmButton: "!bg-[#237227] !text-white !font-semibold !rounded-xl !px-8 !py-2.5 !text-sm cursor-pointer",
        },
      });
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Failed",
        text: err.message || "Failed to build face descriptors",
      });
    } finally {
      setBuildingDescriptors(false);
    }
  };
"""

# Insert rebuild_func before handleSyncDahuaPersons
target_before_sync = """  // Export to Excel
  const handleSyncDahuaPersons = async () => {"""

replacement_before_sync = rebuild_func + "\n  // Export to Excel\n  const handleSyncDahuaPersons = async () => {"

# 4. Add Button in UI
target_button = """          <button
            onClick={handleSyncDahuaPersons}
            disabled={syncingDahuaUsers}
            className={`inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-sm font-semibold border-none cursor-pointer transition-colors bg-[#237227] hover:bg-[#1c5c20] text-white shadow-sm whitespace-nowrap focus:outline-none ${
              syncingDahuaUsers ? "opacity-70 cursor-not-allowed" : ""
            }`}
          >
            <FiRefreshCw className={`mr-1 text-white ${syncingDahuaUsers ? "animate-spin" : ""}`} />
            {syncingDahuaUsers ? "Syncing Dahua Users..." : "Sync Dahua Users"}
          </button>"""

replacement_button = """          <button
            onClick={handleSyncDahuaPersons}
            disabled={syncingDahuaUsers}
            className={`inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-sm font-semibold border-none cursor-pointer transition-colors bg-[#237227] hover:bg-[#1c5c20] text-white shadow-sm whitespace-nowrap focus:outline-none ${
              syncingDahuaUsers ? "opacity-70 cursor-not-allowed" : ""
            }`}
          >
            <FiRefreshCw className={`mr-1 text-white ${syncingDahuaUsers ? "animate-spin" : ""}`} />
            {syncingDahuaUsers ? "Syncing Dahua Users..." : "Sync Dahua Users"}
          </button>
          <button
            onClick={() => handleRebuildFaceData(true)}
            disabled={buildingDescriptors}
            title="Extract face descriptors from registration photos for mobile face verification"
            className={`inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-md text-sm font-semibold border border-[#237227] cursor-pointer transition-colors bg-white hover:bg-emerald-50 text-[#237227] shadow-sm whitespace-nowrap focus:outline-none ${
              buildingDescriptors ? "opacity-70 cursor-not-allowed" : ""
            }`}
          >
            <FiCpu className={`mr-1 text-[#237227] ${buildingDescriptors ? "animate-spin" : ""}`} />
            {buildingDescriptors ? "Building Face Data..." : "Rebuild Face Data"}
          </button>"""

norm_content = content.replace("\r\n", "\n")
norm_ti = target_import.replace("\r\n", "\n")
norm_ri = replacement_import.replace("\r\n", "\n")
norm_ts = target_state.replace("\r\n", "\n")
norm_rs = replacement_state.replace("\r\n", "\n")
norm_tsf = target_sync_func.replace("\r\n", "\n")
norm_rsf = replacement_sync_func.replace("\r\n", "\n")
norm_tbs = target_before_sync.replace("\r\n", "\n")
norm_rbs = replacement_before_sync.replace("\r\n", "\n")
norm_tb = target_button.replace("\r\n", "\n")
norm_rb = replacement_button.replace("\r\n", "\n")

if norm_ti in norm_content and norm_ts in norm_content and norm_tsf in norm_content and norm_tbs in norm_content and norm_tb in norm_content:
    updated = norm_content.replace(norm_ti, norm_ri, 1)
    updated = updated.replace(norm_ts, norm_rs, 1)
    updated = updated.replace(norm_tsf, norm_rsf, 1)
    updated = updated.replace(norm_tbs, norm_rbs, 1)
    updated = updated.replace(norm_tb, norm_rb, 1)
    if "\r\n" in content:
        updated = updated.replace("\n", "\r\n")
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(updated)
    print("SUCCESS: PersonsTable.js updated.")
else:
    print("FAILED: Targets not matched in PersonsTable.js")
