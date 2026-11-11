import os

uas_path = "src/CameraAttendance/UserAttendanceScanner.js"
with open(uas_path, "r", encoding="utf-8") as f:
    content = f.read()

# Let's inspect lines around 660 to 730
start_marker = """        {/* Column 1 in Landscape (Left Panel) or Top in Portrait */}
        <div className="flex flex-col gap-3">
        {/* Minimal Site Info & Clock Strip */}"""

# We want the fragment inside column 1 to close before </div> of column 1:
# In column 1, after line 931:
# )}
# </div>
target_col1_end = """            {!capturedPhoto && (
              <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg p-2 text-center m-0 border border-amber-200">
                Please capture the store image above to enable Time In / Out.
              </p>
            )}
          </div>
        )}
        </div>"""

replacement_col1_end = """            {!capturedPhoto && (
              <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg p-2 text-center m-0 border border-amber-200">
                Please capture the store image above to enable Time In / Out.
              </p>
            )}
          </div>
        )}
            </>
          )}
        </div>"""

# For Column 2:
target_col2_start = """        {/* Column 2 in Landscape (Right Panel) or Bottom in Portrait */}
        <div className="flex flex-col gap-3">"""

replacement_col2_start = """        {/* Column 2 in Landscape (Right Panel) or Bottom in Portrait */}
        {verifiedPerson && (
        <div className="flex flex-col gap-3">"""

# At end of Column 2 and main:
target_col2_end = """            {!capturedPhoto && (
              <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg p-2 text-center m-0 border border-amber-200">
                Please capture the store image above to enable Time In / Out.
              </p>
            )}
          </div>
        )}
        </div>
          </>
        )}
      </main>"""

replacement_col2_end = """            {!capturedPhoto && (
              <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg p-2 text-center m-0 border border-amber-200">
                Please capture the store image above to enable Time In / Out.
              </p>
            )}
          </div>
        )}
        </div>
        )}
      </main>"""

norm = content.replace("\r\n", "\n")
norm_t1 = target_col1_end.replace("\r\n", "\n")
norm_r1 = replacement_col1_end.replace("\r\n", "\n")
norm_t2 = target_col2_start.replace("\r\n", "\n")
norm_r2 = replacement_col2_start.replace("\r\n", "\n")
norm_t3 = target_col2_end.replace("\r\n", "\n")
norm_r3 = replacement_col2_end.replace("\r\n", "\n")

if norm_t1 in norm and norm_t2 in norm and norm_t3 in norm:
    updated = norm.replace(norm_t1, norm_r1, 1)
    updated = updated.replace(norm_t2, norm_r2, 1)
    updated = updated.replace(norm_t3, norm_r3, 1)
    if "\r\n" in content:
        updated = updated.replace("\n", "\r\n")
    with open(uas_path, "w", encoding="utf-8") as f:
        f.write(updated)
    print("SUCCESS: JSX nesting fixed.")
else:
    print("FAILED checks:", norm_t1 in norm, norm_t2 in norm, norm_t3 in norm)
