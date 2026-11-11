import os

uas_path = "src/CameraAttendance/UserAttendanceScanner.js"
with open(uas_path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Add import for FaceVerificationGate
target_import = """import {
  FiCamera,"""

replacement_import = """import FaceVerificationGate from "./FaceVerificationGate";
import {
  FiCamera,"""

# 2. Add verified state
target_state = """  // Employees & Partner Group Dropdown
  const [employees, setEmployees] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);"""

replacement_state = """  // Face Verification Gate state
  const [verifiedPerson, setVerifiedPerson] = useState(null);
  const [verificationToken, setVerificationToken] = useState(null);

  // Employees & Partner Group Dropdown
  const [employees, setEmployees] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);"""

# 3. Add handleFaceVerified callback
target_helpers = """  // Toggle employee selection
  const toggleSelectPerson = (id) => {"""

replacement_helpers = """  // Handle verification from FaceVerificationGate
  const handleFaceVerified = useCallback(({ person, token }) => {
    setVerifiedPerson(person);
    setVerificationToken(token);
    setSelectedIds((prev) => {
      if (prev.includes(person.id)) return prev;
      return [person.id, ...prev];
    });
  }, []);

  // Toggle employee selection
  const toggleSelectPerson = (id) => {
    if (verifiedPerson && id === verifiedPerson.id) return;"""

# 4. In removeSelectedPerson & handleClearAll, protect verified person
target_remove = """  // Remove single selected person badge
  const removeSelectedPerson = (id) => {
    setSelectedIds((prev) => prev.filter((pId) => pId !== id));
  };

  // Select all filtered employees
  const handleSelectAllFiltered = () => {
    const filteredIds = filteredEmployees.map((e) => e.id);
    setSelectedIds((prev) => Array.from(new Set([...prev, ...filteredIds])));
  };

  // Clear all selections
  const handleClearAll = () => {
    setSelectedIds([]);
  };"""

replacement_remove = """  // Remove single selected person badge
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
  };"""

# 5. Optimize employee fetch (don't pull heavy registration_photo for all on mobile)
target_fetch = """.select("id, name, department, registration_photo")"""
replacement_fetch = """.select("id, name, department")"""

# 6. Pass verification_token in handleExecuteAttendance
target_execute = """          scanPayload: {
            photoDataUrl: capturedPhoto,
            point: locationPoint || null,
            notes: descriptionNote.trim() || null,
            forcedEvent,
          },"""

replacement_execute = """          scanPayload: {
            photoDataUrl: capturedPhoto,
            point: locationPoint || null,
            notes: descriptionNote.trim() || null,
            forcedEvent,
            verification_token: verificationToken,
          },"""

# 7. In handleCloseSuccessModal, reset verifiedPerson and verificationToken (Q5)
target_close_modal = """    setCapturedPhoto(null);
    setDescriptionNote("");
    setSelectedIds([]);
  };"""

replacement_close_modal = """    setCapturedPhoto(null);
    setDescriptionNote("");
    setSelectedIds([]);
    setVerifiedPerson(null);
    setVerificationToken(null);
  };"""

# 8. Render FaceVerificationGate if !verifiedPerson, or unlocked UI if verifiedPerson
target_render_step1 = """        {/* STEP 1: DROPDOWN MENU FOR PARTNER GROUP SELECTION */}
        <div
          ref={dropdownRef}
          className="bg-white rounded-2xl border border-gray-200 p-3 shadow-xs flex flex-col gap-2 relative z-30"
        >"""

replacement_render_step1 = """        {/* FACE VERIFICATION GATE OR UNLOCKED CONTENT */}
        {!verifiedPerson ? (
          <FaceVerificationGate onVerified={handleFaceVerified} />
        ) : (
          <>
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
            >"""

# Close fragment at end of main content
target_main_end = """        </div>
      </main>"""

replacement_main_end = """        </div>
          </>
        )}
      </main>"""

# 9. In dropdown, show 'You · Verified' badge
target_dropdown_item = """                        {isSelected && (
                          <span className="text-[10px] text-[#237227] font-bold">
                            Selected ✓
                          </span>
                        )}"""

replacement_dropdown_item = """                        {isSelected && (
                          <span className={`text-[10px] font-bold ${
                            verifiedPerson && emp.id === verifiedPerson.id
                              ? "text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full"
                              : "text-[#237227]"
                          }`}>
                            {verifiedPerson && emp.id === verifiedPerson.id
                              ? "You · Verified"
                              : "Selected ✓"}
                          </span>
                        )}"""

norm = content.replace("\r\n", "\n")
norm_ti = target_import.replace("\r\n", "\n")
norm_ri = replacement_import.replace("\r\n", "\n")
norm_ts = target_state.replace("\r\n", "\n")
norm_rs = replacement_state.replace("\r\n", "\n")
norm_th = target_helpers.replace("\r\n", "\n")
norm_rh = replacement_helpers.replace("\r\n", "\n")
norm_tr = target_remove.replace("\r\n", "\n")
norm_rr = replacement_remove.replace("\r\n", "\n")
norm_tf = target_fetch.replace("\r\n", "\n")
norm_rf = replacement_fetch.replace("\r\n", "\n")
norm_te = target_execute.replace("\r\n", "\n")
norm_re = replacement_execute.replace("\r\n", "\n")
norm_tcm = target_close_modal.replace("\r\n", "\n")
norm_rcm = replacement_close_modal.replace("\r\n", "\n")
norm_tr1 = target_render_step1.replace("\r\n", "\n")
norm_rr1 = replacement_render_step1.replace("\r\n", "\n")
norm_tme = target_main_end.replace("\r\n", "\n")
norm_rme = replacement_main_end.replace("\r\n", "\n")
norm_tdi = target_dropdown_item.replace("\r\n", "\n")
norm_rdi = replacement_dropdown_item.replace("\r\n", "\n")

checks = [
    ("import", norm_ti in norm),
    ("state", norm_ts in norm),
    ("helpers", norm_th in norm),
    ("remove", norm_tr in norm),
    ("fetch", norm_tf in norm),
    ("execute", norm_te in norm),
    ("close_modal", norm_tcm in norm),
    ("render_step1", norm_tr1 in norm),
    ("main_end", norm_tme in norm),
    ("dropdown_item", norm_tdi in norm),
]

failed = [name for name, passed in checks if not passed]
if not failed:
    updated = norm.replace(norm_ti, norm_ri, 1)
    updated = updated.replace(norm_ts, norm_rs, 1)
    updated = updated.replace(norm_th, norm_rh, 1)
    updated = updated.replace(norm_tr, norm_rr, 1)
    updated = updated.replace(norm_tf, norm_rf, 1)
    updated = updated.replace(norm_te, norm_re, 1)
    updated = updated.replace(norm_tcm, norm_rcm, 1)
    updated = updated.replace(norm_tr1, norm_rr1, 1)
    updated = updated.replace(norm_tme, norm_rme, 1)
    updated = updated.replace(norm_tdi, norm_rdi, 1)
    if "\r\n" in content:
        updated = updated.replace("\n", "\r\n")
    with open(uas_path, "w", encoding="utf-8") as f:
        f.write(updated)
    print("SUCCESS: UserAttendanceScanner.js updated.")
else:
    print("FAILED checks:", failed)
