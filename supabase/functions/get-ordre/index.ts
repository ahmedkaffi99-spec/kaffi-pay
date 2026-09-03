import { supabase } from "../_shared/db.ts";
import { json, cors } from "../_shared/utils.ts";

// Public endpoint to fetch order status for the tracking page
// GET /get-ordre?order_id=082626&view_token=abc123de
Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return json({ error: "GET requis" }, 405, headers);

  const url = new URL(req.url);
  const orderId = url.searchParams.get("order_id") || "";
  const viewToken = url.searchParams.get("view_token") || "";

  if (!orderId) return json({ error: "order_id requis" }, 400, headers);

  const [d, r] = await Promise.all([
    supabase.from("depot_orders")
      .select("order_id,status,montant,montant_notif,user_id_1xbet,id1x,waafi_transfert_id,hash,numero_payment,whatsapp,view_token,flag_raison,confirmed_at,created_at,webhook_status")
      .eq("order_id", orderId).limit(1),
    supabase.from("retrait_orders")
      .select("order_id,status,montant,montant_mobcash,user_id_1xbet,id1x,withdrawal_code,code,numero_waafi,whatsapp,view_token,flag_raison,confirmed_at,created_at,webhook_status")
      .eq("order_id", orderId).limit(1),
  ]);

  const ordre = (d.data && d.data[0]) || (r.data && r.data[0]);
  const type = d.data && d.data[0] ? "Dépôt" : "Retrait";

  if (!ordre) return json({ error: "Ordre introuvable" }, 404, headers);

  // Validate view token if provided (security check)
  if (viewToken && ordre.view_token && ordre.view_token !== viewToken) {
    return json({ error: "Accès refusé" }, 403, headers);
  }

  // Return safe subset (never expose internal fields).
  // These extra fields used to be selected above but never returned, so the
  // tracking page only showed ID 1xBet / Transfer ID / sender number / date
  // right after submission (from local browser state) — reopening the
  // WhatsApp link on a fresh page load had nothing to fall back on and
  // rendered them blank.
  return json({
    ok: true,
    type,
    order_id: ordre.order_id,
    status: ordre.status,
    montant: ordre.montant,
    montant_final: ordre.montant_notif || ordre.montant_mobcash || ordre.montant,
    user_id_1xbet: ordre.user_id_1xbet || ordre.id1x || null,
    waafi_transfert_id: ordre.waafi_transfert_id || ordre.hash || null,
    numero_payment: ordre.numero_payment || null,
    withdrawal_code: ordre.withdrawal_code || ordre.code || null,
    numero_waafi: ordre.numero_waafi || null,
    whatsapp: ordre.whatsapp || null,
    webhook_status: ordre.webhook_status || null,
    flag_raison: ordre.flag_raison || null,
    confirmed_at: ordre.confirmed_at || null,
    created_at: ordre.created_at,
  }, 200, headers);
});
