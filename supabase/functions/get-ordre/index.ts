import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { supabase } from "../_shared/db.ts";
import { json, cors } from "../_shared/utils.ts";

// Public endpoint to fetch order status for the tracking page
// GET /get-ordre?order_id=082626&view_token=abc123de
serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });
  if (req.method !== "GET") return json({ error: "GET requis" }, 405, headers);

  const url = new URL(req.url);
  const orderId = url.searchParams.get("order_id") || "";
  const viewToken = url.searchParams.get("view_token") || "";

  if (!orderId) return json({ error: "order_id requis" }, 400, headers);

  const [d, r] = await Promise.all([
    supabase.from("depot_orders")
      .select("order_id,status,montant,montant_notif,user_id_1xbet,whatsapp,view_token,flag_raison,confirmed_at,created_at,webhook_status")
      .eq("order_id", orderId).limit(1),
    supabase.from("retrait_orders")
      .select("order_id,status,montant,montant_mobcash,user_id_1xbet,whatsapp,view_token,flag_raison,confirmed_at,created_at")
      .eq("order_id", orderId).limit(1),
  ]);

  const ordre = (d.data && d.data[0]) || (r.data && r.data[0]);
  const type = d.data && d.data[0] ? "Dépôt" : "Retrait";

  if (!ordre) return json({ error: "Ordre introuvable" }, 404, headers);

  // Validate view token if provided (security check)
  if (viewToken && ordre.view_token && ordre.view_token !== viewToken) {
    return json({ error: "Accès refusé" }, 403, headers);
  }

  // Return safe subset (never expose internal fields)
  return json({
    ok: true,
    type,
    order_id: ordre.order_id,
    status: ordre.status,
    montant: ordre.montant,
    montant_final: ordre.montant_notif || ordre.montant_mobcash || ordre.montant,
    flag_raison: ordre.flag_raison || null,
    confirmed_at: ordre.confirmed_at || null,
    created_at: ordre.created_at,
  }, 200, headers);
});
