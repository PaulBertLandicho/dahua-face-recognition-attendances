import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../supabaseClient";
import {
  FaEye,
  FaEyeSlash,
  FaEnvelope,
  FaLock,
  FaSignInAlt,
} from "react-icons/fa";

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const { error: loginError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (loginError) {
        setError(loginError.message);
        setLoading(false);
        return;
      }

      // We need to fetch the session to determine the user's role
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        const user = session.user;
        const role = user?.user_metadata?.role || user?.app_metadata?.role || user?.role;
        if (role === "secretary") {
          navigate("/");
        } else {
          navigate("/admin/dashboard");
        }
      } else {
        navigate("/admin/dashboard");
      }
    } catch (err) {
      setError(err.message || "Login failed");
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.headerCentered}>
          <div style={styles.icon} aria-hidden>
            <img
              src="/image/login-logo.png"
              alt="Multifactors Sales Logo"
              style={styles.logoImage}
            />
          </div>
          <h2 style={styles.welcomeTitle}>Welcome back</h2>
          <div style={styles.headerSub}>
            Sign in to access the admin dashboard
          </div>
        </div>

        <form onSubmit={handleLogin} style={styles.form}>
          <div style={styles.inputGroup}>
            <label style={styles.label}>Email</label>
            <div style={styles.inputWrapper}>
              <span style={styles.leftIcon}>
                <FaEnvelope />
              </span>
              <input
                type="email"
                value={email}
                placeholder="you@company.com"
                onChange={(e) => setEmail(e.target.value)}
                required
                style={styles.input}
                aria-label="Email"
              />
            </div>
          </div>

          <div style={styles.inputGroup}>
            <label style={styles.label}>Password</label>
            <div style={styles.inputWrapper}>
              <span style={styles.leftIcon}>
                <FaLock />
              </span>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                placeholder="Enter your password"
                onChange={(e) => setPassword(e.target.value)}
                required
                style={styles.input}
                aria-label="Password"
              />

              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={styles.eyeButton}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <FaEyeSlash /> : <FaEye />}
              </button>
            </div>
          </div>

          <div style={styles.rowBetween}>
            <label style={styles.rememberLabel}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                style={styles.checkbox}
              />
              Remember me
            </label>
            <button
              type="button"
              onClick={() => {
                // placeholder: implement forgot password flow
              }}
              style={styles.forgotLinkButton}
            >
              Forgot password?
            </button>
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button
            type="submit"
            disabled={loading}
            style={{
              ...styles.button,
              ...(loading ? styles.buttonDisabled : {}),
            }}
          >
            {loading ? (
              "Logging in..."
            ) : (
              <>
                <FaSignInAlt style={styles.signInIcon} /> Sign in
              </>
            )}
          </button>
        </form>
      </div>

      {/* Footer */}
      <div style={styles.footer}>
        © 2026 Multifactors Sales Corporation. All rights reserved.
      </div>
    </div>
  );
}

/* STYLES MUST BE OUTSIDE THE COMPONENT */
const styles = {
  container: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-start",
    padding: 0,
    background: "#f9fafb",
  },
  card: {
    maxWidth: "420px",
    width: "90%",
    background: "#ffffff",
    borderRadius: "16px",
    padding: "40px 32px",
    boxShadow: "0 10px 25px rgba(0, 0, 0, 0.05)",
    border: "1px solid #f3f4f6",
    marginTop: "10vh",
    marginBottom: "100px",
  },
  headerCentered: {
    textAlign: "center",
    marginBottom: "24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "column",
    gap: 12,
  },
  icon: {
    display: "flex",
    justifyContent: "center",
    marginBottom: "4px",
  },
  logoImage: {
    width: 140,
    height: 140,
    objectFit: "contain",
  },
  welcomeTitle: {
    margin: 0,
    fontSize: "1.45rem",
    fontWeight: 700,
    color: "#111827",
  },
  headerSub: {
    color: "#6b7280",
    fontSize: "13px",
    marginTop: "2px",
  },
  underline: {
    width: "56px",
    height: "4px",
    background: "#237227",
    margin: "8px auto",
    borderRadius: "6px",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  inputWrapper: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    background: "#fbf6f8",
    borderRadius: "12px",
    padding: "10px 12px",
    border: "1px solid transparent",
  },
  leftIcon: {
    color: "#9ca3af",
    marginRight: "8px",
    fontSize: "16px",
    display: "flex",
    alignItems: "center",
  },
  inputGroup: {
    display: "flex",
    flexDirection: "column",
  },
  label: {
    fontSize: "14px",
    marginBottom: "6px",
    color: "#374151",
  },
  input: {
    flex: 1,
    padding: "10px 8px 10px 8px",
    paddingRight: "40px",
    borderRadius: "8px",
    border: "none",
    background: "transparent",
    outline: "none",
    fontSize: "15px",
    color: "#111827",
  },
  button: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "12px",
    borderRadius: "8px",
    border: "none",
    background: "#237227",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: "16px",
    width: "100%",
    boxShadow: "0 4px 12px rgba(35, 114, 39, 0.2)",
    transition: "background 0.2s",
  },
  buttonDisabled: {
    opacity: 0.6,
    cursor: "not-allowed",
  },
  error: {
    color: "#dc2626",
    textAlign: "center",
    fontSize: "14px",
  },
  rowBetween: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  forgotLink: {
    color: "#237227",
    fontSize: "13px",
    textDecoration: "none",
  },
  forgotLinkButton: {
    background: "transparent",
    border: "none",
    color: "#237227",
    fontSize: "13px",
    cursor: "pointer",
    padding: 0,
  },
  checkbox: {
    marginRight: "8px",
  },
  rememberLabel: {
    display: "inline-flex",
    alignItems: "center",
    color: "#374151",
    fontSize: "14px",
  },
  eyeButton: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "#6b7280",
    fontSize: "16px",
    display: "flex",
    alignItems: "center",
    position: "absolute",
    right: "25px",
    top: "50%",
    transform: "translateY(-50%)",
    padding: 0,
    lineHeight: 1,
  },
  signInIcon: {
    marginRight: 8,
    verticalAlign: "middle",
  },
  footer: {
    position: "sticky",
    bottom: 0,
    left: 0,
    marginTop: "auto",
    padding: "24px 32px",
    textAlign: "left",
    color: "#6b7280",
    fontSize: "13px",
    background: "#f9fafb",
    width: "100%",
    borderTop: "1px solid #e5e7eb",
    boxSizing: "border-box",
    zIndex: 10,
  },
};
