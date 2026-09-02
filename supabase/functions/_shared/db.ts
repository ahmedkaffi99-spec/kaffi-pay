import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// Prevent unhandled async rejections (e.g. from supabase-js auth init) from
// causing EarlyDrop on fast-returning handlers like OPTIONS preflight.
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    event.preventDefault();
    console.warn("unhandledrejection swallowed:", (event.reason as Error)?.message ?? String(event.reason));
  });
}

export const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
);
