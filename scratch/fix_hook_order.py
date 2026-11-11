import os

uas_path = "src/CameraAttendance/UserAttendanceScanner.js"
with open(uas_path, "r", encoding="utf-8") as f:
    content = f.read()

target_cb = """  // Handle verification from FaceVerificationGate
  const handleFaceVerified = useCallback(({ person, token }) => {
    setVerifiedPerson(person);
    setVerificationToken(token);
    setSelectedIds((prev) => {
      if (prev.includes(person.id)) return prev;
      return [person.id, ...prev];
    });
  }, []);"""

# We remove it from line 467
content_without_cb = content.replace(target_cb + "\n\n", "").replace(target_cb + "\n", "")

# We insert it right after fetchLocation around line 220
target_after_location = """  useEffect(() => {
    fetchLocation();
  }, [fetchLocation]);"""

replacement_after_location = """  useEffect(() => {
    fetchLocation();
  }, [fetchLocation]);

  // Handle verification from FaceVerificationGate
  const handleFaceVerified = useCallback(({ person, token }) => {
    setVerifiedPerson(person);
    setVerificationToken(token);
    setSelectedIds((prev) => {
      if (prev.includes(person.id)) return prev;
      return [person.id, ...prev];
    });
  }, []);"""

norm = content_without_cb.replace("\r\n", "\n")
norm_tal = target_after_location.replace("\r\n", "\n")
norm_ral = replacement_after_location.replace("\r\n", "\n")

if norm_tal in norm:
    updated = norm.replace(norm_tal, norm_ral, 1)
    if "\r\n" in content:
        updated = updated.replace("\n", "\r\n")
    with open(uas_path, "w", encoding="utf-8") as f:
        f.write(updated)
    print("SUCCESS: Hook order fixed.")
else:
    print("FAILED: Could not find target_after_location.")
