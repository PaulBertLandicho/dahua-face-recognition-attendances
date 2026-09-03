// Role definitions and helpers for session role checks
export const ADMIN_ROLE = "admin";
export const SECRETARY_ROLE = "secretary";
export const STAFF_ROLES = [ADMIN_ROLE, SECRETARY_ROLE];

function _extractUserFromSession(sessionOrData) {
  if (!sessionOrData) return null;

  // Case: supabase.auth.getSession() -> session object
  if (sessionOrData.user) return sessionOrData.user;

  // Case: result from signInWithPassword -> data object with session and user
  if (sessionOrData.session && sessionOrData.session.user) return sessionOrData.session.user;

  // Case: older structures or direct user object passed in
  if (sessionOrData.data && sessionOrData.data.user) return sessionOrData.data.user;

  return null;
}

export function getSessionRole(sessionOrData) {
  const user = _extractUserFromSession(sessionOrData);
  if (!user) return null;

  // Check common places where role might be stored
  // 1) user.user_metadata.role
  if (user.user_metadata && typeof user.user_metadata.role === "string") return user.user_metadata.role;

  // 2) user.app_metadata.role
  if (user.app_metadata && typeof user.app_metadata.role === "string") return user.app_metadata.role;

  // 3) top-level field (rare)
  if (typeof user.role === "string") return user.role;

  return null;
}

export function getLoginRedirectPath(sessionOrData) {
  return getSessionRole(sessionOrData) === SECRETARY_ROLE ? "/admin/attendance" : "/admin/dashboard";
}

export function hasAllowedRole(sessionOrData, allowedRoles = STAFF_ROLES) {
  const role = getSessionRole(sessionOrData);
  return Array.isArray(allowedRoles) ? allowedRoles.includes(role) : role === allowedRoles;
}

