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

  // Djibouti = UTC+3 toute l'année (pas d'heure d'été) — bornes de jour
  // calendaire calculées sur ce fuseau fixe, pas sur celui du serveur Deno.
  const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;
  function localMidnight(daysAgo: number): Date {
    const local = new Date(Date.now() + TZ_OFFSET_MS);
    local.setUTCHours(0, 0, 0, 0);
    local.setUTCDate(local.getUTCDate() - daysAgo);
    return new Date(local.getTime() - TZ_OFFSET_MS);
  }

  let startDate: string;
  let endDate: string | null = null;
  let chartDays = 7;
  if (period === "today") {
    startDate = localMidnight(0).toISOString();
    chartDays = 1;
  } else if (period === "hier") {
    startDate = localMidnight(1).toISOString();
    endDate = localMidnight(0).toISOString();
    chartDays = 1;
  } else if (period === "mois") {
    const local = new Date(Date.now() + TZ_OFFSET_MS);
    const first = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
    startDate = new Date(first.getTime() - TZ_OFFSET_MS).toISOString();
    chartDays = local.getUTCDate();
  } else if (period === "30j") {
    startDate = localMidnight(29).toISOString();
    chartDays = 30;
  } else if (period === "all") {
    startDate = new Date(0).toISOString();
    chartDays = 30;
  } else {
    // "7j" par défaut
    startDate = localMidnight(6).toISOString();
    chartDays = 7;
  }

  let depotsQuery = supabase.from("depot_orders").select("order_id,status,montant,fraud_type,flag_raison,created_at").gte("created_at", startDate);
  let retraitsQuery = supabase.from("retrait_orders").select("order_id,status,montant,flag_raison,created_at").gte("created_at", startDate);
  if (endDate) { depotsQuery = depotsQuery.lt("created_at", endDate); retraitsQuery = retraitsQuery.lt("created_at", endDate); }

  const [d, r, dPend, rPend] = await Promise.all([
    depotsQuery,
    retraitsQuery,
    // "En attente" reste en attente indépendamment de la période affichée —
    // compté sur TOUT l'historique, pas seulement la fenêtre sélectionnée.
    supabase.from("depot_orders").select("order_id,status").in("status", ["En attente", "Paiement Reçu"]),
    supabase.from("retrait_orders").select("order_id,status").in("status", ["En attente", "Code Validé"]),
  ]);

  const depots = d.data || [];
  const retraits = r.data || [];
  const all = [...depots, ...retraits];

  const confDep = depots.filter(x => x.status === "Crédité avec succès");
  const confRet = retraits.filter(x => x.status === "Payé" || x.status === "Crédité avec succès");
  const pending = (dPend.data || []).length + (rPend.data || []).length;
  const fraudes = all.filter(x => x.fraud_type || (x.flag_raison && x.flag_raison.toUpperCase().includes("FRAUDE")));
  const rejected = all.filter(x => x.status === "Paiement Non Reçu" || x.status === "Code Invalide");

  const totalDep = confDep.reduce((s, x) => s + Number(x.montant || 0), 0);
  const totalRet = confRet.reduce((s, x) => s + Number(x.montant || 0), 0);

  // Chart data groupé par jour
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
      pending,
      fraudes: fraudes.length,
      countRejected: rejected.length,
      countCredited: confDep.length + confRet.length,
      volume: totalDep + totalRet,
      benefice: Math.round(totalDep * 0.05 + totalRet * 0.02),
    },
    chart,
  }, 200, headers);
});
