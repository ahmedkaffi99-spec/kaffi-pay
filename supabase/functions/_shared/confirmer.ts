import { supabase } from "./db.ts";
import { sendTelegram, notifyPaiementAgents } from "./telegram.ts";
import { sendWhatsApp } from "./whatsapp.ts";
import { logAudit } from "./utils.ts";

export async function confirmerDepot(
  ordre: Record<string, unknown>,
  notif: Record<string, unknown>,
  token: string,
  adminId: string
): Promise<boolean> {
  const ordreId = ordre.order_id as string;
  const montantNotif = (notif.montant || ordre.montant) as number;
  const numReel = (notif.num_client || ordre.numero_payment || "") as string;
  const transferId = (notif.transfer_id || "") as string;

  // Anti-doublon : upsert ordre_traite avec conflit sur transfer_id
  const { error: traitErr } = await supabase.from("ordre_traite").insert({
    transfer_id: transferId || ordreId,
    ordre_id: ordreId,
    status: "confirme",
    credited_at: new Date().toISOString(),
  });
  if (traitErr) return false; // TID déjà utilisé

  // Vérifier que l'ordre est encore "En attente"
  const { data: fresh } = await supabase.from("depot_orders")
    .select("status").eq("id", ordre.id).single();
  if (!fresh || fresh.status !== "En attente") return false;

  // Marquer paiement reçu
  await supabase.from("depot_orders").update({
    status: "Paiement Reçu",
    confirmed_by: "auto_match_waafi",
    montant_notif: montantNotif,
    expediteur_recu: numReel,
    confirmed_at: new Date().toISOString(),
  }).eq("id", ordre.id);

  // Marquer notification Waafi comme matchée
  await supabase.from("waafi_notifications").update({
    status: "matché", ordre_ref: ordreId, matched_at: new Date().toISOString(),
  }).eq("id", notif.id).catch(() => {});

  logAudit("depot_paiement_confirme", { ordreId, transferId, montant: montantNotif });

  const confirmeMsg = `💳 <b>Paiement Waafi validé</b>\n\n` +
    `Ordre: <b>#${ordreId}</b> | <b>${Number(montantNotif).toLocaleString()} DJF</b>\n` +
    `Transfer-ID: <code>${transferId || "?"}</code> | N°: <code>${numReel}</code>` +
    (ordre.whatsapp ? `\nWhatsApp: <code>${ordre.whatsapp}</code>` : "") +
    `\n\n<i>⏳ MobCash va créditer le compte 1xBet...</i>`;
  await sendTelegram(token, adminId, confirmeMsg);
  await notifyPaiementAgents(token, confirmeMsg).catch(() => {});

  if (!ordre.user_id_1xbet && !ordre.id1x) {
    await sendTelegram(token, adminId,
      `⚠️ <b>ID 1xBet manquant</b> — #${ordreId}\n${Number(montantNotif).toLocaleString()} DJF en attente de crédit.`);
  }

  if (ordre.whatsapp) {
    const vt = ordre.view_token ? `-${ordre.view_token}` : "";
    await sendWhatsApp(ordre.whatsapp as string,
      `💳 *Baki-Pay — Paiement reçu* ✅\n\n` +
      `Votre paiement *#${ordreId}* de *${Number(montantNotif).toLocaleString()} DJF* a bien été reçu.\n\n` +
      `Statut : 💳 *Paiement reçu*\n\n` +
      `⏳ Crédit de votre compte 1xBet en cours...\n` +
      `📲 baki-pay.com/#suivi-${ordreId}${vt}`
    );
  }

  return true;
}
