import { supabase } from "./db.ts";
import { sendTelegram, notifyPaiementAgents } from "./telegram.ts";
import { sendWhatsApp } from "./whatsapp.ts";
import { callMobcashDepot } from "./mobcash.ts";
import { logAudit, webhookStatusPourErreurMobcash } from "./utils.ts";

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
  // devise/montant_usd déterminent quel cashdesk MobCash créditer et avec
  // quel montant — montantNotif (DJF) reste le montant réellement payé via
  // Waafi, utilisé pour le matching et l'affichage, jamais pour le crédit
  // MobCash d'un ordre USD.
  const devise = (ordre.devise === "USD" ? "USD" : "DJF") as "DJF" | "USD";
  const montantUsd = devise === "USD" ? Number(ordre.montant_usd || 0) : null;
  const montantACrediter = devise === "USD" ? (montantUsd || 0) : montantNotif;
  const montantAffiche = devise === "USD" ? `${montantNotif.toLocaleString()} DJF (crédit : ${montantUsd}$)` : `${montantNotif.toLocaleString()} DJF`;

  // Anti-doublon : insert dans ordre_traite (échoue si TID déjà utilisé)
  const { error: traitErr } = await supabase.from("ordre_traite").insert({
    transfer_id: transferId || ordreId,
    ordre_id: ordreId,
    status: "confirme",
    credited_at: new Date().toISOString(),
  });
  if (traitErr) return false; // TID déjà utilisé

  // Vérifier que l'ordre est encore confirmable. "Paiement Non Reçu" est admis
  // en plus de "En attente" : un rejet "Transfer ID introuvable" peut être
  // rouvert par un SMS Waafi arrivé en retard (sms-webhook) — tout autre
  // statut (déjà crédité, annulé...) reste définitif.
  const { data: fresh } = await supabase.from("depot_orders")
    .select("status").eq("id", ordre.id).single();
  if (!fresh || !["En attente", "Paiement Non Reçu"].includes(fresh.status)) return false;

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
    `Montant : <b>${montantAffiche}</b>\n` +
    `Transfer-ID : <code>${transferId || "?"}</code> | N° : <code>${numReel}</code>` +
    (whatsapp ? `\nWhatsApp : <code>${whatsapp}</code>` : "") +
    `\n\n<i>⏳ Appel MobCash en cours...</i>`;
  await sendTelegram(token, adminId, confirmeMsg);
  await notifyPaiementAgents(token, confirmeMsg).catch(() => {});

  // WhatsApp — paiement reçu
  if (whatsapp) {
    sendWhatsApp(whatsapp,
      `💳 *Baki-Pay — Paiement reçu* ✅\n\n` +
      `Votre paiement *#${ordreId}* de *${montantAffiche}* a bien été reçu.\n\n` +
      `⏳ Crédit de votre compte 1xBet en cours...\n` +
      `📲 baki-pay.com/#suivi-${ordreId}${vt}`
    ).catch(() => {});
  }

  // MobCash — créditer le compte 1xBet
  if (!userId1xbet) {
    const m = `⚠️ <b>ID 1xBet manquant — #${ordreId}</b>\n${montantAffiche} — crédit impossible, vérifiez l'ordre.`;
    await Promise.allSettled([sendTelegram(token, adminId, m), notifyPaiementAgents(token, m)]);
    return true;
  }

  try {
    await callMobcashDepot(userId1xbet, montantACrediter, devise);

    // Mettre à jour ordre_traite → "credite"
    await supabase.from("ordre_traite").update({ status: "credite" })
      .eq("transfer_id", transferId || ordreId);

    // Marquer "Crédité avec succès"
    await supabase.from("depot_orders").update({
      status: "Crédité avec succès",
      webhook_status: "ok",
      webhook_at: new Date().toISOString(),
    }).eq("id", ordre.id);

    logAudit("depot_mobcash_ok", { ordreId, userId1xbet, devise, montantACrediter });

    const creditMsg = `✅ <b>Dépôt crédité avec succès</b>\n#${ordreId} — ${montantAffiche}`;
    await sendTelegram(token, adminId, creditMsg);
    await notifyPaiementAgents(token, creditMsg).catch(() => {});

    if (whatsapp) {
      sendWhatsApp(whatsapp,
        `🎉 *Baki-Pay — Compte 1xBet crédité !*\n\n` +
        `Votre dépôt *#${ordreId}* de *${montantAffiche}* a été traité avec succès.\n\n` +
        `✅ *Crédité avec succès*\n\n` +
        `Votre compte 1xBet est rechargé. Vous pouvez maintenant jouer ! 🎮`
      ).catch(() => {});
    }
  } catch (e) {
    const errMsg = (e as Error).message || "";
    const webhookStatus = webhookStatusPourErreurMobcash(errMsg);

    await supabase.from("depot_orders").update({
      webhook_status: webhookStatus,
      webhook_err: errMsg,
    }).eq("id", ordre.id);

    logAudit("depot_mobcash_echec", { ordreId, err: errMsg, webhookStatus, devise });

    if (webhookStatus === "echec_permanent") {
      // Le cashdesk utilisé (DJF ou USD, voir devise) correspondait déjà à la
      // devise attendue de l'ordre — un "currency does not match" ici signifie
      // que le compte 1xBet du client n'est PAS dans la devise qu'il a
      // sélectionnée sur le formulaire, pas forcément DJF par défaut.
      const causeProbable = devise === "USD"
        ? "le compte 1xBet n'est probablement pas en USD (client a sélectionné USD par erreur)."
        : "compte 1xBet en devise étrangère (USD/EUR).";
      const actionRequise = devise === "USD"
        ? "vérifier la vraie devise du compte avec le client, ou créditer manuellement sur le bon cashdesk."
        : "demander l'ID DJF au client ou créditer manuellement.";
      const m = `🚨 <b>Erreur permanente MobCash (${devise}) — #${ordreId}</b>\n` +
        `ID 1xBet : <code>${userId1xbet}</code>\n` +
        `<code>${errMsg}</code>\n\n` +
        `<b>Cause probable :</b> ${causeProbable}\n` +
        `<b>Action requise :</b> ${actionRequise}`;
      await Promise.allSettled([sendTelegram(token, adminId, m), notifyPaiementAgents(token, m)]);
    } else if (webhookStatus === "echec_solde") {
      const m = `🏦 <b>Solde MobCash insuffisant (cashdesk ${devise}) — #${ordreId}</b>\n` +
        `ID 1xBet : <code>${userId1xbet}</code> | ${montantAffiche}\n` +
        `<code>${errMsg}</code>\n\n` +
        `<i>Le client ne voit pas d'échec — sa page affiche "crédit en cours".</i>\n` +
        `<b>Action requise :</b> rechargez le solde cashdesk ${devise} puis <code>recharge ${ordreId}</code> sur ce bot.`;
      await Promise.allSettled([sendTelegram(token, adminId, m), notifyPaiementAgents(token, m)]);
    } else {
      const m = `⚠️ <b>MobCash Dépôt échoué — #${ordreId}</b>\n` +
        `<code>${errMsg}</code>\n` +
        `<i>Relancez manuellement depuis le panel admin.</i>`;
      await Promise.allSettled([sendTelegram(token, adminId, m), notifyPaiementAgents(token, m)]);
    }
  }

  return true;
}
