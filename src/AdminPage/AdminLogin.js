import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../mysqlClient";
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
          navigate("/admin/attendance");
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
    <div className="min-h-screen flex flex-col items-center justify-start p-0 bg-gray-50">
      <div className="max-w-[420px] w-[90%] bg-white rounded-2xl px-8 py-10 shadow-[0_10px_25px_rgba(0,0,0,0.05)] border border-gray-100 mt-[10vh] mb-[100px]">
        <div className="text-center mb-6 flex items-center justify-center flex-col gap-3">
          <div className="flex justify-center mb-1" aria-hidden>
            <img
              src="/image/login-logo.png"
              alt="Multifactors Sales Logo"
              className="w-[140px] h-[140px] object-contain"
            />
          </div>
          <h2 className="m-0 text-3xl font-bold text-gray-900">
            Welcome back
          </h2>
          <div className="text-gray-500 text-[13px] mt-0.5">
            Sign in to access the admin dashboard
          </div>
        </div>

        <form onSubmit={handleLogin} className="flex flex-col gap-[14px]">
          <div className="flex flex-col">
            <label className="text-sm mb-1.5 text-gray-700">Email</label>
            <div className="relative flex items-center bg-[#fbf6f8] rounded-xl px-3 py-2.5 border border-transparent focus-within:border-gray-200 transition-colors">
              <span className="text-gray-400 mr-2 text-base flex items-center">
                <FaEnvelope />
              </span>
              <input
                type="email"
                value={email}
                placeholder="you@company.com"
                onChange={(e) => setEmail(e.target.value)}
                required
                className="flex-1 py-2.5 px-2 rounded-lg border-none bg-transparent outline-none text-[15px] text-gray-900 focus:outline-none focus:ring-0 focus:!ring-0 focus:!border-none focus:!shadow-none !shadow-none !border-none !outline-none"
                aria-label="Email"
              />
            </div>
          </div>

          <div className="flex flex-col">
            <label className="text-sm mb-1.5 text-gray-700">Password</label>
            <div className="relative flex items-center bg-[#fbf6f8] rounded-xl px-3 py-2.5 border border-transparent focus-within:border-gray-200 transition-colors">
              <span className="text-gray-400 mr-2 text-base flex items-center">
                <FaLock />
              </span>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                placeholder="Enter your password"
                onChange={(e) => setPassword(e.target.value)}
                required
                className="flex-1 py-2.5 px-2 rounded-lg border-none bg-transparent outline-none text-[15px] text-gray-900 focus:outline-none focus:ring-0 focus:!ring-0 focus:!border-none focus:!shadow-none !shadow-none !border-none !outline-none"
                aria-label="Password"
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
          </div>



          {error && <div className="text-red-600 text-center text-sm">{error}</div>}

          <button
            type="submit"
            disabled={loading}
            className={`flex items-center justify-center p-3 rounded-lg border-none bg-[#237227] hover:bg-[#1a541c] text-white cursor-pointer font-bold text-base w-full shadow-lg transition-all mt-2 ${
              loading ? "opacity-60 cursor-not-allowed" : ""
            }`}
          >
            {loading ? (
              "Logging in..."
            ) : (
              <>
                <FaSignInAlt className="mr-2 align-middle" /> Sign in
              </>
            )}
          </button>
        </form>
      </div>

      {/* Footer */}
      <div className="sticky bottom-0 left-0 mt-auto py-6 px-8 text-left text-[#0000000] text-md bg-gray-50 w-full border-t border-gray-200 box-border z-10">
        © 2026 Multifactors Sales. All rights reserved.
      </div>
    </div>
  );
}