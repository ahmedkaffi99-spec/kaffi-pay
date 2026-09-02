// v2
import { supabase } from "../_shared/db.ts";
import { json, cors } from "../_shared/utils.ts";

Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });

  const checks: Record<string, unknown> = {};

  // DB check
  try {
    const { count } = await supabase.from("depot_orders").select("*", { count: "exact", head: true });
    checks.database = { ok: true, depot_count: count };
  } catch (e) {
    checks.database = { ok: false, error: (e as Error).message };
  }

  // Env secrets check
  const secrets = ["TELEGRAM_TOKEN", "TELEGRAM_ADMIN_CHAT_ID", "MACRODROID_SECRET",
    "GREEN_API_ID", "GREEN_API_TOKEN", "MOBCASH_HASH", "MOBCASH_CASHIERPASS", "MOBCASH_CASHDESKID"];
  checks.secrets = Object.fromEntries(secrets.map(k => [k, !!Deno.env.get(k)]));

  // Recent SMS
  try {
    const { data } = await supabase.from("waafi_notifications")
      .select("created_at,status").order("created_at", { ascending: false }).limit(1);
    checks.last_sms = data?.[0] || null;
  } catch {
    checks.last_sms = null;
  }

  const allOk = (checks.database as { ok: boolean }).ok;
  return json({ ok: allOk, timestamp: new Date().toISOString(), checks }, allOk ? 200 : 503, headers);
});
