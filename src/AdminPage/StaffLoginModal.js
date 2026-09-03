import React, { useEffect, useState } from "react";
import {
  FaEnvelope,
  FaLock,
  FaTimes,
  FaSignInAlt,
  FaUserShield,
  FaEye,
  FaEyeSlash,
} from "react-icons/fa";
import { supabase } from "../mysqlClient";
import {
  SECRETARY_ROLE,
  getLoginRedirectPath,
  getSessionRole,
} from "../utils/authRoles";

export default function StaffLoginModal({ open, onClose, onStaffLoggedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setError("");
    setLoading(false);
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const { data, error: signInError } =
        await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

      if (signInError) {
        setError(signInError.message || "Unable to sign in.");
        setLoading(false);
        return;
      }

      const role = getSessionRole(data);
      if (role !== SECRETARY_ROLE) {
        await supabase.auth.signOut();
        setError(
          role === "admin"
            ? "This is the admin account. Please use secretary account instead."
            : "That account does not have secretary access yet.",
        );
        setLoading(false);
        return;
      }

      setMessage("Signed in successfully.");
      if (typeof onStaffLoggedIn === "function") {
        onStaffLoggedIn({
          email: email.trim(),
          redirectTo: getLoginRedirectPath(data),
        });
      }
    } catch (err) {
      setError(err.message || "Unable to sign in.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.backdrop} onClick={onClose} role="presentation">
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          style={styles.closeButton}
          aria-label="Close staff login modal"
        >
          <FaTimes />
        </button>

        <div style={styles.badge}>
          <FaUserShield style={{ marginRight: 8 }} />
          Secretary Login
        </div>

        <h2 style={styles.title}>Open the attendance account</h2>
        <p style={styles.subtitle}>
          Sign in with the secretary email and password. Admin accounts must use
          the Admin Login page.
        </p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>Attendance email</label>
          <div style={styles.inputRow}>
            <FaEnvelope style={styles.inputIcon} />
            <input
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="attendances@gmail.com"
              required
              className="focus:!outline-none focus:!ring-0 focus:!shadow-none focus:!border-none !shadow-none !border-none !outline-none"
              style={styles.input}
            />
          </div>

          <label style={styles.label}>Password</label>
          <div style={styles.inputRow}>
            <FaLock style={styles.inputIcon} />

            <input
              name="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter attendance password"
              required
              className="focus:!outline-none focus:!ring-0 focus:!shadow-none focus:!border-none !shadow-none !border-none !outline-none"
              style={styles.input}
            />

            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="bg-transparent hover:!bg-transparent border-none cursor-pointer text-gray-500 hover:text-gray-700 text-base flex items-center justify-center p-1 leading-none transition-colors !shadow-none hover:!shadow-none !transform-none hover:!transform-none focus:outline-none focus:!outline-none focus:!ring-0 focus:!shadow-none"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <FaEyeSlash /> : <FaEye />}
            </button>
          </div>

          {error && <div style={styles.error}>{error}</div>}
          {message && <div style={styles.message}>{message}</div>}

          <button type="submit" disabled={loading} style={styles.button}>
            <FaSignInAlt style={{ marginRight: 8 }} />
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(2, 6, 23, 0.68)",
    backdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 200000,
    padding: 16,
  },
  modal: {
    width: "100%",
    maxWidth: 520,
    background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
    borderRadius: 24,
    boxShadow: "0 30px 80px rgba(15, 23, 42, 0.35)",
    border: "1px solid rgba(148, 163, 184, 0.2)",
    padding: "28px 24px 24px",
    position: "relative",
  },
  closeButton: {
    position: "absolute",
    top: 14,
    right: 14,
    border: "none",
    background: "#e5e7eb",
    color: "#111827",
    width: 36,
    height: 36,
    borderRadius: 999,
    cursor: "pointer",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "8px 14px",
    borderRadius: 999,
    background: "#dcfce7",
    color: "#166534",
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    marginBottom: 14,
  },
  title: {
    margin: 0,
    fontSize: 26,
    lineHeight: 1.15,
    color: "#0f172a",
  },
  subtitle: {
    margin: "10px 0 22px",
    color: "#475569",
    lineHeight: 1.6,
    fontSize: 14,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: 700,
    color: "#334155",
  },
  inputRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
  },
  inputIcon: {
    color: "#64748b",
  },
  input: {
    flex: 1,
    border: "none",
    outline: "none",
    fontSize: 15,
    background: "transparent",
  },
  button: {
    marginTop: 10,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "12px 18px",
    borderRadius: 14,
    border: "none",
    background: "#237227",
    color: "#ffffff",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 14px 30px rgba(35, 114, 39, 0.25)",
  },
  error: {
    padding: "10px 12px",
    borderRadius: 12,
    background: "#fee2e2",
    color: "#991b1b",
    fontSize: 13,
  },
  message: {
    padding: "10px 12px",
    borderRadius: 12,
    background: "#dcfce7",
    color: "#166534",
    fontSize: 13,
  },
};
