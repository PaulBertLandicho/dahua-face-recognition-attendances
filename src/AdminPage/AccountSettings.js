import React, { useState, useEffect } from "react";
import Swal from "sweetalert2";
import {
  FiLock,
  FiUser,
  FiMail,
  FiKey,
  FiCheck,
  FiEye,
  FiEyeOff,
  FiShield,
  FiSave,
} from "react-icons/fi";
import { updateUserProfile } from "../utils/dahuaApi";
import { supabase } from "../mysqlClient";

export default function AccountSettings() {
  const [currentUser, setCurrentUser] = useState(null);
  const [userName, setUserName] = useState("");
  const [email, setEmail] = useState("");

  // Password fields
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load current user session
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setCurrentUser(session.user);
        setUserName(session.user.name || session.user.user_metadata?.name || "");
        setEmail(session.user.email || "");
      }
    });
  }, []);

  // Handle Form Submit
  const handleSaveSettings = async (e) => {
    e.preventDefault();

    if (!userName.trim()) {
      Swal.fire({
        icon: "warning",
        title: "Name Required",
        text: "Please enter your name.",
        customClass: { popup: "!rounded-2xl font-sans" },
      });
      return;
    }

    if (!email.trim()) {
      Swal.fire({
        icon: "warning",
        title: "Email Required",
        text: "Please enter your email address.",
        customClass: { popup: "!rounded-2xl font-sans" },
      });
      return;
    }

    // If attempting to change password
    const isChangingPassword = Boolean(newPassword && newPassword.trim().length > 0);
    if (isChangingPassword) {
      if (newPassword.length < 4) {
        Swal.fire({
          icon: "warning",
          title: "Weak Password",
          text: "New password must be at least 4 characters long.",
          customClass: { popup: "!rounded-2xl font-sans" },
        });
        return;
      }

      if (newPassword !== confirmPassword) {
        Swal.fire({
          icon: "error",
          title: "Passwords Do Not Match",
          text: "Please make sure your new password and confirmation match exactly.",
          customClass: { popup: "!rounded-2xl font-sans" },
        });
        return;
      }

      if (!currentPassword) {
        Swal.fire({
          icon: "warning",
          title: "Current Password Required",
          text: "Please enter your current password to confirm password change.",
          customClass: { popup: "!rounded-2xl font-sans" },
        });
        return;
      }
    }

    setSaving(true);
    try {
      const res = await updateUserProfile({
        userId: currentUser?.id,
        email: currentUser?.email,
        newName: userName.trim(),
        newEmail: email.trim(),
        currentPassword: currentPassword || undefined,
        newPassword: isChangingPassword ? newPassword : undefined,
      });

      if (res?.user) {
        // Update local session
        const stored = localStorage.getItem("sb-session");
        if (stored) {
          try {
            const parsed = JSON.parse(stored);
            parsed.user = { ...parsed.user, ...res.user };
            localStorage.setItem("sb-session", JSON.stringify(parsed));
          } catch (e) {}
        }
        setCurrentUser(res.user);
      }

      Swal.fire({
        icon: "success",
        iconColor: "#237227",
        title: "Account Settings Saved!",
        text: isChangingPassword
          ? "Your name, email, and password have been successfully updated."
          : "Your account profile information has been saved.",
        timer: 3000,
        showConfirmButton: false,
        customClass: {
          popup: "!rounded-2xl font-sans",
          title: "!text-xl !font-bold text-gray-800",
        },
      });

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Save Failed",
        text: err.message || "Failed to update account settings. Please check your credentials.",
        customClass: { popup: "!rounded-2xl font-sans" },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-[760px] mx-auto py-4 px-2 sm:px-4 font-sans text-gray-800">
      {/* Header */}
      <div className="flex flex-col items-center justify-center text-center mb-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[rgba(35,114,39,0.1)] text-[#237227] text-xs font-bold uppercase tracking-wider mb-2">
          <FiShield className="text-sm" /> Account Profile & Security
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 m-0 mb-2">
          Account Settings
        </h1>
        <p className="text-sm text-gray-500 m-0">
          Manage your account profile name, email address, and login credentials.
        </p>
      </div>

      <div className="bg-white rounded-3xl p-6 sm:p-9 border border-gray-200 shadow-sm">
        <form onSubmit={handleSaveSettings} className="space-y-6">
          {/* Section 1: User Profile Details */}
          <div>
            <div className="flex items-center gap-2.5 pb-3 mb-4 border-b border-gray-100">
              <div className="w-8 h-8 rounded-lg bg-emerald-50 text-[#237227] flex items-center justify-center text-base">
                <FiUser />
              </div>
              <div>
                <h2 className="text-base font-bold text-gray-900 m-0">
                  Profile Information
                </h2>
                <p className="text-xs text-gray-500 m-0">
                  Update your display name and email address
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {/* User Name */}
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
                  Full Name / Username
                </label>
                <div className="relative flex items-center bg-gray-50 rounded-xl px-3.5 py-1.5 border border-gray-200 focus-within:border-[#237227] focus-within:bg-white transition-all">
                  <FiUser className="text-gray-400 mr-2.5 flex-shrink-0" />
                  <input
                    type="text"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    placeholder="e.g. Multifactors Admin"
                    required
                    className="flex-1 py-2 text-sm bg-transparent border-none outline-none text-gray-900"
                  />
                </div>
              </div>

              {/* Email Address */}
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
                  Email Address
                </label>
                <div className="relative flex items-center bg-gray-50 rounded-xl px-3.5 py-1.5 border border-gray-200 focus-within:border-[#237227] focus-within:bg-white transition-all">
                  <FiMail className="text-gray-400 mr-2.5 flex-shrink-0" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="e.g. admin@company.com"
                    required
                    className="flex-1 py-2 text-sm bg-transparent border-none outline-none text-gray-900"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Password & Security */}
          <div className="pt-2">
            <div className="flex items-center gap-2.5 pb-3 mb-4 border-b border-gray-100">
              <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center text-base">
                <FiLock />
              </div>
              <div>
                <h2 className="text-base font-bold text-gray-900 m-0">
                  Change Password
                </h2>
                <p className="text-xs text-gray-500 m-0">
                  Leave password fields blank if you do not wish to change your password
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Current Password */}
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
                  Current Password {newPassword && <span className="text-red-500">*</span>}
                </label>
                <div className="relative flex items-center bg-gray-50 rounded-xl px-3.5 py-1.5 border border-gray-200 focus-within:border-[#237227] focus-within:bg-white transition-all">
                  <FiKey className="text-gray-400 mr-2.5 flex-shrink-0" />
                  <input
                    type={showCurrent ? "text" : "password"}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder={newPassword ? "Required to change password" : "Enter current password (optional)"}
                    className="flex-1 py-2 text-sm bg-transparent border-none outline-none text-gray-900"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrent(!showCurrent)}
                    className="text-gray-400 hover:text-gray-600 p-1 border-none bg-transparent cursor-pointer"
                  >
                    {showCurrent ? <FiEyeOff /> : <FiEye />}
                  </button>
                </div>
              </div>

              {/* New Password */}
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
                  New Password
                </label>
                <div className="relative flex items-center bg-gray-50 rounded-xl px-3.5 py-1.5 border border-gray-200 focus-within:border-[#237227] focus-within:bg-white transition-all">
                  <FiLock className="text-gray-400 mr-2.5 flex-shrink-0" />
                  <input
                    type={showNew ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password (min. 4 characters)"
                    minLength={4}
                    className="flex-1 py-2 text-sm bg-transparent border-none outline-none text-gray-900"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew(!showNew)}
                    className="text-gray-400 hover:text-gray-600 p-1 border-none bg-transparent cursor-pointer"
                  >
                    {showNew ? <FiEyeOff /> : <FiEye />}
                  </button>
                </div>
              </div>

              {/* Confirm New Password */}
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
                  Confirm New Password
                </label>
                <div className="relative flex items-center bg-gray-50 rounded-xl px-3.5 py-1.5 border border-gray-200 focus-within:border-[#237227] focus-within:bg-white transition-all">
                  <FiCheck className="text-gray-400 mr-2.5 flex-shrink-0" />
                  <input
                    type={showConfirm ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    minLength={4}
                    className="flex-1 py-2 text-sm bg-transparent border-none outline-none text-gray-900"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm(!showConfirm)}
                    className="text-gray-400 hover:text-gray-600 p-1 border-none bg-transparent cursor-pointer"
                  >
                    {showConfirm ? <FiEyeOff /> : <FiEye />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-gray-100 flex items-center justify-end">
            <button
              type="submit"
              disabled={saving}
              className="py-3 px-8 rounded-xl bg-[#237227] hover:bg-[#1a541c] text-white text-sm font-bold cursor-pointer transition-all shadow-md disabled:opacity-50 border-none flex items-center justify-center gap-2 min-w-[180px]"
            >
              <FiSave className="text-base" />
              {saving ? "Saving Changes..." : "Save Account Settings"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
