// MySQL frontend client adapter.
// The implementation is retained in supabaseClient.js for backwards compatibility.
export {
  supabase,
  SUPABASE_CONFIGURED,
  subscribeToTable,
  setActiveFaceToken,
  getActiveFaceToken,
} from "./supabaseClient";

export { supabase as default } from "./supabaseClient";

