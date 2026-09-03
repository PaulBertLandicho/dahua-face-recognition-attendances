// MySQL frontend client adapter.
// The implementation is retained in supabaseClient.js for backwards compatibility.
export {
  supabase,
  SUPABASE_CONFIGURED,
  subscribeToTable,
} from "./supabaseClient";

export { supabase as default } from "./supabaseClient";
