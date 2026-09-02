import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// Lazy singleton — createClient() is deferred until the first DB call.
// This prevents supabase-js from firing its internal async initialize()
// Promise at module-load time, which caused EarlyDrop on fast-returning
// handlers (e.g. OPTIONS preflight) before a response could be sent.
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
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
  }
  return _client;
}

// Proxy preserves the `import { supabase }` contract across all shared modules
// while deferring createClient() until the first property access.
export const supabase = new Proxy({} as SupabaseClient, {
  get(_: unknown, prop: string | symbol) {
    return (getClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
