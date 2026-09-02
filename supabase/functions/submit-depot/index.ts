import { supabase } from "../_shared/db.ts";
import { sendTelegram, notifyPaiementAgents } from "../_shared/telegram.ts";
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import { scorerCorrespondance, mismatchToRaison } from "../_shared/scoring.ts";
import { confirmerDepot } from "../_shared/confirmer.ts";
import { json, cors, logAudit, genToken } from "../_shared/utils.ts";

Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405, headers);

  const body = await req.json().catch(() => ({}));
  const token = Deno.env.get("TELEGRAM_TOKEN")!;
  const adminId = Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")!;

  const ordreId = body.order_id as string;
  const montant = Number(body.montant || 0);
  const transferId = (body.waafi_transfert_id || body.hash || "").trim();
  const phone = (body.numero_payment || "").trim();
  const userId1xbet = (body.user_id_1xbet || body.id1x || "").trim();
  const whatsapp = (body.whatsapp || "").trim();
  const viewToken = (body.view_token || genToken()) as string;

  if (!ordreId || !montant) return json({ error: "order_id et montant requis" }, 400, headers);

  // Insérer l'ordre en base
  const { data: ordre, error: insertErr } = await supabase.from("depot_orders").insert({
    order_id: ordreId,
    status: "En attente",
    montant,
    user_id_1xbet: userId1xbet || null,
    id1x: userId1xbet || null,
    waafi_transfert_id: transferId || null,
    hash: transferId || null,
    numero_payment: phone || null,
    whatsapp: whatsapp || null,
    view_token: viewToken,
    score_fraude: 0,
    fraud_type: "aucun",
  }).select().single();

  if (insertErr) return json({ error: insertErr.message }, 500, headers);

  logAudit("nouvel_depot", { ordreId, montant, phone });

  // Répondre immédiatement au client
  const response = json({ success: true, order_id: ordreId, view_token: viewToken }, 200, headers);

  // Traitement en arrière-plan (maintenu vivant par waitUntil)
  const process = (async () => {
    const vt = viewToken ? `-${viewToken}` : "";

    // Telegram admin + agents — nouvel ordre reçu
    const newDepotMsg =
      `📥 <b>Nouvel ordre Dépôt</b> — <code>#${ordreId}</code>\n\n` +
      `Montant : <b>${montant.toLocaleString()} DJF</b>\n` +
      `ID 1xBet : <code>${userId1xbet || "—"}</code>\n` +
      `Transfer-ID : <code>${transferId || "—"}</code>\n` +
      `N° Waafi : <code>${phone || "—"}</code>\n\n` +
      `<i>⏳ Vérification en cours...</i>`;
    await Promise.allSettled([
      sendTelegram(token, adminId, newDepotMsg),
      notifyPaiementAgents(token, newDepotMsg),
    ]);

    // WhatsApp — accusé de réception immédiat
    if (whatsapp) {
      sendWhatsApp(whatsapp,
        `🧾 *Baki-Pay — Ordre reçu* ✅\n\n` +
        `Votre ordre *#${ordreId}* a bien été soumis.\n\n` +
        `📥 *Dépôt 1xBet*\n` +
        `Montant : *${montant.toLocaleString()} DJF*\n` +
        `ID 1xBet : ${userId1xbet || "—"}\n` +
        `Waafi Transfer ID : ${transferId || "—"}\n` +
        `N° expéditeur : ${phone || "—"}\n\n` +
        `Statut : ⏳ *En attente*\n\n` +
        `Vous recevrez une notification dès que votre paiement sera validé.\n` +
        `📲 Suivi : baki-pay.com/#suivi-${ordreId}${vt}`
      ).catch(() => {});
    }

    // Pas de Transfer ID → rejet immédiat
    if (!transferId) {
      await supabase.from("depot_orders").update({
        status: "Paiement Non Reçu",
        flag_raison: "Transfer ID manquant",
        flagged_at: new Date().toISOString(),
        auto_notified: true,
      }).eq("id", ordre.id);
      await sendTelegram(token, adminId,
        `❌ <b>Dépôt rejeté — Transfer ID manquant</b>\nOrdre: <code>#${ordreId}</code>`);
      if (whatsapp) {
        sendWhatsApp(whatsapp,
          `❌ *Baki-Pay — Paiement non reçu*\n\n` +
          `Votre ordre *#${ordreId}* n'a pas pu être traité.\n` +
          `Raison : Transfer ID Waafi manquant.\n\n` +
          `Vérifiez votre SMS Waafi et soumettez un nouvel ordre sur baki-pay.com`
        ).catch(() => {});
      }
      return;
    }

    // Recherche 1 : par Transfer ID exact
    let waafiNotif = null;
    const { data: byTid } = await supabase.from("waafi_notifications")
      .select("*").eq("transfer_id", transferId).neq("status", "matché").limit(1);
    if (byTid && byTid.length > 0) waafiNotif = byTid[0];

    // Recherche 2 (fallback) : par numéro + montant ±5%
    if (!waafiNotif && phone) {
      const tolerance = Math.max(5, montant * 0.05);
      const { data: byPhone } = await supabase.from("waafi_notifications")
        .select("*").eq("num_client", phone).neq("status", "matché").limit(10);
      if (byPhone) {
        for (const n of byPhone) {
          if (n.montant && Math.abs(montant - Number(n.montant)) > tolerance) continue;
          if (n.transfer_id) {
            const { data: dejaTraite } = await supabase.from("ordre_traite")
              .select("id").eq("transfer_id", n.transfer_id).eq("status", "credite").limit(1);
            if (dejaTraite && dejaTraite.length > 0) continue;
          }
          waafiNotif = n;
          break;
        }
      }
    }

    if (waafiNotif) {
      const { score, mismatches, decision } = scorerCorrespondance(ordre, waafiNotif);

      if (decision === "confirmer") {
        const confirmed = await confirmerDepot(ordre, waafiNotif, token, adminId);
        if (!confirmed) {
          // Doublon TID : déjà utilisé par un autre ordre
          const { data: autreTraite } = await supabase.from("ordre_traite")
            .select("ordre_id").eq("transfer_id", waafiNotif.transfer_id || "").limit(1);
          const autreId = autreTraite && autreTraite.length > 0 ? autreTraite[0].ordre_id : "?";
          if (autreId !== ordreId) {
            await supabase.from("depot_orders").update({
              status: "Paiement Non Reçu",
              flag_raison: `Transfer-ID déjà utilisé par l'ordre #${autreId}`,
              flagged_at: new Date().toISOString(),
              auto_notified: true,
            }).eq("id", ordre.id);
            await sendTelegram(token, adminId,
              `⚠️ <b>Doublon TID — #${ordreId}</b>\n` +
              `Transfer-ID <code>${transferId}</code> déjà utilisé par <code>#${autreId}</code>.\n` +
              `Montant: ${montant.toLocaleString()} DJF | ID 1xBet: <code>${userId1xbet || "?"}</code>`);
            if (whatsapp) {
              sendWhatsApp(whatsapp,
                `❌ *Baki-Pay — Paiement non reçu*\n\n` +
                `Votre ordre *#${ordreId}* n'a pas pu être traité.\n` +
                `Raison : Transfer ID déjà utilisé.\n\n` +
                `Si vous avez soumis un nouvel ordre avec le même Transfer ID, contactez le support.\n` +
                `📲 baki-pay.com/#suivi-${ordreId}${vt}`
              ).catch(() => {});
            }
          }
        }
        return;
      }

      // Correspondance partielle (score < 3) → Paiement Non Reçu (comme Firebase)
      const raison = mismatchToRaison(mismatches);
      await supabase.from("depot_orders").update({
        status: "Paiement Non Reçu",
        flag_raison: raison,
        flagged_at: new Date().toISOString(),
        auto_notified: true,
      }).eq("id", ordre.id);
      if (whatsapp) {
        sendWhatsApp(whatsapp,
          `❌ *Baki-Pay — Paiement non reçu*\n\n` +
          `Votre ordre *#${ordreId}* n'a pas pu être traité.\n` +
          `Raison : ${raison}\n\n` +
          `Vérifiez les informations et soumettez un nouvel ordre sur baki-pay.com`
        ).catch(() => {});
      }
      await sendTelegram(token, adminId,
        `❌ <b>Dépôt rejeté (${score}/3) — ${raison}</b>\n\n` +
        `Ordre <code>#${ordreId}</code>\n${mismatches.map((m: string) => `• ${m}`).join("\n")}`);
      await notifyPaiementAgents(token,
        `❌ <b>Dépôt rejeté (${score}/3) — ${raison}</b>\nOrdre <code>#${ordreId}</code>`).catch(() => {});
      logAudit("depot_rejete_mauvaise_correspondance", { ordreId, score, mismatches, raison });
      return;
    }

    // Aucun SMS Waafi avec ce TID → Paiement Non Reçu (comme Firebase)
    const raisonIntrouvable = "Transfer ID introuvable — paiement non reçu";
    await supabase.from("depot_orders").update({
      status: "Paiement Non Reçu",
      flag_raison: raisonIntrouvable,
      flagged_at: new Date().toISOString(),
      auto_notified: true,
    }).eq("id", ordre.id);
    if (whatsapp) {
      sendWhatsApp(whatsapp,
        `❌ *Baki-Pay — Paiement non reçu*\n\n` +
        `Votre ordre *#${ordreId}* n'a pas pu être traité.\n` +
        `Raison : Transfer ID introuvable\n\n` +
        `Vérifiez votre Transfer ID Waafi et soumettez un nouvel ordre sur baki-pay.com`
      ).catch(() => {});
    }
    await sendTelegram(token, adminId,
      `❌ <b>Dépôt rejeté — TID introuvable</b>\n\n` +
      `Ordre: <code>#${ordreId}</code>\n` +
      `Transfer-ID: <code>${transferId}</code>\n` +
      `Montant: ${montant.toLocaleString()} DJF\n\n` +
      `<i>Aucun SMS Waafi avec ce Transfer ID dans les registres.</i>`);
    logAudit("depot_rejete_tid_introuvable", { ordreId, transferId });
  })();

  try {
    (globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
      .EdgeRuntime?.waitUntil(process);
  } catch (_) {
    await process;
  }

  return response;
});
