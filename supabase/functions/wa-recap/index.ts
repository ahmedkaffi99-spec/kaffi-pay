import { supabase } from "../_shared/db.ts";
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import { json, cors } from "../_shared/utils.ts";

Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });

  const url = new URL(req.url);
  const ordreId = url.searchParams.get("ordreId") || (await req.json().catch(() => ({}))).ordreId || "";
  if (!ordreId) return json({ ok: false, reason: "ordreId requis" }, 400, headers);

  // Cherche dans depot_orders puis retrait_orders
  const { data: deps } = await supabase.from("depot_orders").select("*").eq("order_id", ordreId).limit(1);
  const { data: rets } = await supabase.from("retrait_orders").select("*").eq("order_id", ordreId).limit(1);

  const ordre = (deps && deps[0]) || (rets && rets[0]) || null;
  if (!ordre) return json({ ok: false, reason: "Ordre introuvable" }, 404, headers);

  const phone = ordre.whatsapp || "";
  if (!phone) return json({ ok: false, reason: "Aucun numéro WhatsApp" }, 400, headers);

  const isRetrait = ordre.type === "Retrait";
  const montantStr = Number(ordre.montant || 0).toLocaleString();
  const viewSuffix = ordre.view_token ? `-${ordre.view_token}` : "";

  let statut: string;
  if (ordre.status === "Payé")                 statut = "✅ Payé — Paiement envoyé. Vérifiez votre solde Waafi.";
  else if (ordre.status === "Code Validé")      statut = "⏳ Code Validé — Transfert Waafi en cours.";
  else if (ordre.status === "Code Invalide")    statut = `❌ Code Invalide — ${ordre.flag_raison || "contactez le support"}`;
  else if (ordre.status === "Crédité avec succès") statut = "✅ Crédité avec succès";
  else if (ordre.status === "Paiement Reçu")    statut = "💳 Paiement reçu — crédit 1xBet en cours...";
  else if (ordre.status === "Paiement Non Reçu") statut = `❌ Paiement non reçu — ${ordre.flag_raison || "contactez le support"}`;
  else if (ordre.status === "Annulé")           statut = "🚫 Annulé";
  else                                          statut = ordre.status || "⏳ En attente";

  const msg = !isRetrait
    ? `🧾 *Baki-Pay — Récapitulatif Dépôt*\n\n` +
      `N° Ordre : *#${ordreId}*\n` +
      `Montant : ${montantStr} DJF\n` +
      `ID 1xBet : ${ordre.user_id_1xbet || "—"}\n` +
      `Transfer ID Waafi : ${ordre.waafi_transfert_id || ordre.hash || "—"}\n` +
      `N° Expéditeur : ${ordre.numero_payment || "—"}\n` +
      `Statut : ${statut}\n\n` +
      `📲 baki-pay.com/#suivi-${ordreId}${viewSuffix}`
    : `🧾 *Baki-Pay — Récapitulatif Retrait*\n\n` +
      `N° Ordre : *#${ordreId}*\n` +
      `Montant : ${montantStr} DJF\n` +
      `Code retrait : ${ordre.withdrawal_code || ordre.code || "—"}\n` +
      `Numéro Waafi : ${ordre.waafi_number || "—"}\n` +
      `Statut : ${statut}\n\n` +
      `📲 baki-pay.com/#suivi-${ordreId}${viewSuffix}`;

  const result = await sendWhatsApp(phone, msg);
  if (result.ok) {
    return json({ ok: true }, 200, headers);
  } else {
    return json({ ok: false, reason: result.reason || "Échec WhatsApp" }, 500, headers);
  }
});
