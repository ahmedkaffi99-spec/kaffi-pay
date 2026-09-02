import { supabase } from "../_shared/db.ts";
import { json, cors } from "../_shared/utils.ts";

const ADMIN_KEY = "kp2026_9f3aXmQ7";

Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method Not Allowed" }, 405, headers);

  const url = new URL(req.url);
  const ak = req.headers.get("x-admin-key") || url.searchParams.get("_ak") || "";
  if (ak !== ADMIN_KEY) return json({ ok: false, error: "Non autorisé" }, 403, headers);

  const period = url.searchParams.get("period") || "7j";
  const days = period === "30j" ? 30 : period === "all" ? 3650 : 7;
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [d, r] = await Promise.all([
    supabase.from("depot_orders").select("order_id,status,montant,fraud_type,flag_raison,created_at").gte("created_at", startDate),
    supabase.from("retrait_orders").select("order_id,status,montant,flag_raison,created_at").gte("created_at", startDate),
  ]);

  const depots = d.data || [];
  const retraits = r.data || [];
  const all = [...depots, ...retraits];

  const confDep = depots.filter(x => x.status === "Crédité avec succès");
  const confRet = retraits.filter(x => x.status === "Payé" || x.status === "Crédité avec succès");
  const pending = all.filter(x => ["En attente", "Paiement Reçu", "Code Validé"].includes(x.status));
  const fraudes = all.filter(x => x.fraud_type || (x.flag_raison && x.flag_raison.toUpperCase().includes("FRAUDE")));
  const rejected = all.filter(x => x.status === "Paiement Non Reçu" || x.status === "Code Invalide");

  const totalDep = confDep.reduce((s, x) => s + Number(x.montant || 0), 0);
  const totalRet = confRet.reduce((s, x) => s + Number(x.montant || 0), 0);

  // Chart data groupé par jour
  const chartDays = period === "30j" ? 30 : 7;
  const chart = [];
  for (let i = chartDays - 1; i >= 0; i--) {
    const d0 = new Date(); d0.setDate(d0.getDate() - i); d0.setHours(0, 0, 0, 0);
    const d1 = new Date(d0); d1.setHours(23, 59, 59, 999);
    const label = `${String(d0.getDate()).padStart(2, "0")}/${String(d0.getMonth() + 1).padStart(2, "0")}`;
    const dep = confDep.filter(x => { const t = new Date(x.created_at); return t >= d0 && t <= d1; })
      .reduce((s, x) => s + Number(x.montant || 0), 0);
    const ret = confRet.filter(x => { const t = new Date(x.created_at); return t >= d0 && t <= d1; })
      .reduce((s, x) => s + Number(x.montant || 0), 0);
    chart.push({ label, dep, ret });
  }

  return json({
    ok: true, period,
    stats: {
      totalDepots: totalDep,
      countDepots: confDep.length,
      totalRetraits: totalRet,
      countRetraits: confRet.length,
      pending: pending.length,
      fraudes: fraudes.length,
      countRejected: rejected.length,
      countCredited: confDep.length + confRet.length,
      volume: totalDep + totalRet,
      benefice: Math.round(totalDep * 0.05 + totalRet * 0.02),
    },
    chart,
  }, 200, headers);
});
