import { supabase } from "./db.ts";
import { sendTelegram, notifyPaiementAgents } from "./telegram.ts";
import { sendWhatsApp } from "./whatsapp.ts";
import { callMobcash } from "./mobcash.ts";
import { logAudit } from "./utils.ts";

const ERREURS_PERMANENTES = [
  "currency does not match",
  "account currency",
  "user not found",
  "invalid user",
  "account not found",
];

export async function confirmerDepot(
  ordre: Record<string, unknown>,
  notif: Record<string, unknown>,
  token: string,
  adminId: string
): Promise<boolean> {
  const ordreId = ordre.order_id as string;
  const montantNotif = Number(notif.montant || ordre.montant || 0);
  const numReel = (notif.num_client || ordre.numero_payment || "") as string;
  const transferId = (notif.transfer_id || "") as string;
  const userId1xbet = (ordre.user_id_1xbet || ordre.id1x || "") as string;
  const whatsapp = (ordre.whatsapp || "") as string;
  const viewToken = (ordre.view_token || "") as string;

  // Anti-doublon : insert dans ordre_traite (échoue si TID déjà utilisé)
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

  // Marquer "Paiement Reçu"
  await supabase.from("depot_orders").update({
    status: "Paiement Reçu",
    confirmed_by: "auto_match_waafi",
    montant_notif: montantNotif,
    expediteur_recu: numReel,
    confirmed_at: new Date().toISOString(),
  }).eq("id", ordre.id);

  // Marquer notification Waafi comme matchée.
  // Pas de .catch() ici : le query builder Supabase est un PromiseLike sans
  // méthode catch(), l'appeler lève un TypeError qui tuait tout le traitement.
  await supabase.from("waafi_notifications").update({
    status: "matché", ordre_ref: ordreId, matched_at: new Date().toISOString(),
  }).eq("id", notif.id);

  logAudit("depot_paiement_confirme", { ordreId, transferId, montant: montantNotif });

  // Telegram — paiement reçu, crédit en cours
  const vt = viewToken ? `-${viewToken}` : "";
  const confirmeMsg =
    `💳 <b>Paiement Waafi validé — #${ordreId}</b>\n\n` +
    `Montant : <b>${montantNotif.toLocaleString()} DJF</b>\n` +
    `Transfer-ID : <code>${transferId || "?"}</code> | N° : <code>${numReel}</code>` +
    (whatsapp ? `\nWhatsApp : <code>${whatsapp}</code>` : "") +
    `\n\n<i>⏳ Appel MobCash en cours...</i>`;
  await sendTelegram(token, adminId, confirmeMsg);
  await notifyPaiementAgents(token, confirmeMsg).catch(() => {});

  // WhatsApp — paiement reçu
  if (whatsapp) {
    sendWhatsApp(whatsapp,
      `💳 *Baki-Pay — Paiement reçu* ✅\n\n` +
      `Votre paiement *#${ordreId}* de *${montantNotif.toLocaleString()} DJF* a bien été reçu.\n\n` +
      `⏳ Crédit de votre compte 1xBet en cours...\n` +
      `📲 baki-pay.com/#suivi-${ordreId}${vt}`
    ).catch(() => {});
  }

  // MobCash — créditer le compte 1xBet
  if (!userId1xbet) {
    await sendTelegram(token, adminId,
      `⚠️ <b>ID 1xBet manquant — #${ordreId}</b>\n${montantNotif.toLocaleString()} DJF — crédit impossible, vérifiez l'ordre.`);
    return true;
  }

  try {
    await callMobcash("Dépôt", userId1xbet, montantNotif, "");

    // Mettre à jour ordre_traite → "credite"
    await supabase.from("ordre_traite").update({ status: "credite" })
      .eq("transfer_id", transferId || ordreId);

    // Marquer "Crédité avec succès"
    await supabase.from("depot_orders").update({
      status: "Crédité avec succès",
      webhook_status: "ok",
      webhook_at: new Date().toISOString(),
    }).eq("id", ordre.id);

    logAudit("depot_mobcash_ok", { ordreId, userId1xbet });

    const creditMsg = `✅ <b>Dépôt crédité avec succès</b>\n#${ordreId} — ${montantNotif.toLocaleString()} DJF`;
    await sendTelegram(token, adminId, creditMsg);
    await notifyPaiementAgents(token, creditMsg).catch(() => {});

    if (whatsapp) {
      sendWhatsApp(whatsapp,
        `🎉 *Baki-Pay — Compte 1xBet crédité !*\n\n` +
        `Votre dépôt *#${ordreId}* de *${montantNotif.toLocaleString()} DJF* a été traité avec succès.\n\n` +
        `✅ *Crédité avec succès*\n\n` +
        `Votre compte 1xBet est rechargé. Vous pouvez maintenant jouer ! 🎮`
      ).catch(() => {});
    }
  } catch (e) {
    const errMsg = (e as Error).message || "";
    const estPermanente = ERREURS_PERMANENTES.some((s) => errMsg.toLowerCase().includes(s));

    await supabase.from("depot_orders").update({
      webhook_status: estPermanente ? "echec_permanent" : "echec",
      webhook_err: errMsg,
    }).eq("id", ordre.id);

    logAudit("depot_mobcash_echec", { ordreId, err: errMsg, permanent: estPermanente });

    if (estPermanente) {
      await sendTelegram(token, adminId,
        `🚨 <b>Erreur permanente MobCash — #${ordreId}</b>\n` +
        `ID 1xBet : <code>${userId1xbet}</code>\n` +
        `<code>${errMsg}</code>\n\n` +
        `<b>Cause probable :</b> compte 1xBet en devise étrangère (USD/EUR).\n` +
        `<b>Action requise :</b> demander l'ID DJF au client ou créditer manuellement.`);
    } else {
      await sendTelegram(token, adminId,
        `⚠️ <b>MobCash Dépôt échoué — #${ordreId}</b>\n` +
        `<code>${errMsg}</code>\n` +
        `<i>Relancez manuellement depuis le panel admin.</i>`);
    }
  }

  return true;
}
