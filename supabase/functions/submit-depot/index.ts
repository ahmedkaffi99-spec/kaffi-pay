import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { supabase } from "../_shared/db.ts";
import { sendTelegram, notifyPaiementAgents } from "../_shared/telegram.ts";
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import { analyserFraude } from "../_shared/fraud.ts";
import { scorerCorrespondance, mismatchToRaison } from "../_shared/scoring.ts";
import { confirmerDepot } from "../_shared/confirmer.ts";
import { json, cors, logAudit, genToken } from "../_shared/utils.ts";

serve(async (req: Request) => {
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

  // Analyse fraude
  const fraude = analyserFraude(montant, transferId || null, phone);
  const fraudeTag = fraude.score >= 70
    ? `\n🚨 <b>Fraude ${fraude.risque.toUpperCase()} (${fraude.score}/100)</b> : ${fraude.raisons.join(", ")}`
    : fraude.score >= 40
    ? `\n⚠️ <i>Risque fraude moyen (${fraude.score}/100) : ${fraude.raisons.join(", ")}</i>`
    : "";

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
    score_fraude: fraude.score,
    fraud_type: fraude.risque,
  }).select().single();

  if (insertErr) return json({ error: insertErr.message }, 500, headers);

  logAudit("nouvel_depot", { ordreId, montant, phone });

  // Répondre au client immédiatement
  const response = json({ success: true, order_id: ordreId, view_token: viewToken }, 200, headers);

  // Traitement asynchrone (best-effort)
  (async () => {
    if (fraude.action === "rejeter") {
      await supabase.from("depot_orders").update({
        status: "Paiement Non Reçu",
        flag_raison: `Fraude détectée : ${fraude.raisons.join(", ")}`,
        fraud_type: fraude.risque,
        score_fraude: fraude.score,
        flagged_at: new Date().toISOString(),
        auto_notified: true,
      }).eq("id", ordre.id);

      await sendTelegram(token, adminId,
        `🚨 <b>Dépôt rejeté — Fraude</b> <code>#${ordreId}</code>\n` +
        `Score: ${fraude.score}/100 | Risque: ${fraude.risque}\n` +
        fraude.raisons.map((r: string) => `• ${r}`).join("\n")
      );
      if (whatsapp) {
        await sendWhatsApp(whatsapp,
          `❌ *Baki-Pay — Ordre refusé*\n\nVotre ordre *#${ordreId}* n'a pas pu être traité.\n\n` +
          `Pour toute question, contactez notre support :\n` +
          `📲 baki-pay.com/#suivi-${ordreId}-${viewToken}`
        ).catch(() => {});
      }
      logAudit("depot_rejete_fraude", { ordreId, score: fraude.score });
      return;
    }

    // Telegram admin + agents — nouvel ordre reçu
    const newDepotMsg = `📥 <b>Nouvel ordre Dépôt</b> — <code>#${ordreId}</code>\n\n` +
      `Montant : <b>${montant.toLocaleString()} DJF</b>\n` +
      `ID 1xBet : <code>${userId1xbet || "—"}</code>\n` +
      `Transfer-ID : <code>${transferId || "—"}</code>\n` +
      `N° Waafi : <code>${phone || "—"}</code>${fraudeTag}\n\n` +
      `<i>⏳ Vérification en cours...</i>`;
    await Promise.allSettled([
      sendTelegram(token, adminId, newDepotMsg),
      notifyPaiementAgents(token, newDepotMsg),
    ]);

    // WhatsApp — accusé de réception immédiat
    if (whatsapp) {
      await sendWhatsApp(whatsapp,
        `🧾 *Baki-Pay — Ordre reçu* ✅\n\n` +
        `Votre ordre *#${ordreId}* a bien été soumis.\n\n` +
        `📥 *Dépôt 1xBet*\n` +
        `Montant : *${montant.toLocaleString()} DJF*\n` +
        `ID 1xBet : ${userId1xbet || "—"}\n` +
        `Waafi Transfer ID : ${transferId || "—"}\n` +
        `N° expéditeur : ${phone || "—"}\n\n` +
        `Statut : ⏳ *En attente*\n\n` +
        `Vous recevrez une notification dès que votre paiement sera validé.\n` +
        `📲 Suivi : baki-pay.com/#suivi-${ordreId}-${viewToken}`
      ).catch(() => {});
    }

    if (!transferId) {
      await supabase.from("depot_orders").update({
        status: "Paiement Non Reçu",
        flag_raison: "Transfer ID manquant",
        flagged_at: new Date().toISOString(),
        auto_notified: true,
      }).eq("id", ordre.id);
      await sendTelegram(token, adminId,
        `❌ <b>Dépôt rejeté — Transfer ID manquant</b>\nOrdre: <code>#${ordreId}</code>`);
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
          // Vérifier que le TID de cette notif n'est pas déjà utilisé
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
          // Doublon TID : appartient à un autre ordre
          const { data: autreTraite } = await supabase.from("ordre_traite")
            .select("ordre_id").eq("transfer_id", waafiNotif.transfer_id || "").limit(1);
          const autreId = autreTraite && autreTraite.length > 0 ? autreTraite[0].ordre_id : "?";
          if (autreId === ordreId) return;

          await supabase.from("depot_orders").update({
            status: "Paiement Non Reçu",
            flag_raison: `Transfer-ID déjà utilisé par l'ordre #${autreId}`,
            flagged_at: new Date().toISOString(),
            auto_notified: true,
          }).eq("id", ordre.id);
          await sendTelegram(token, adminId,
            `⚠️ <b>Doublon TID détecté — #${ordreId}</b>\n\n` +
            `Transfer-ID <code>${transferId}</code> déjà utilisé par l'ordre <code>#${autreId}</code>.\n` +
            `Montant: ${montant.toLocaleString()} DJF | ID 1xBet: <code>${userId1xbet || "?"}</code>`);
          if (whatsapp) {
            await sendWhatsApp(whatsapp,
              `❌ *Baki-Pay — Paiement non reçu*\n\nVotre ordre *#${ordreId}* n'a pas pu être traité.\n` +
              `Raison : Transfer ID déjà utilisé.\n\n📲 baki-pay.com/#suivi-${ordreId}-${viewToken}`
            ).catch(() => {});
          }
        }
        return;
      }

      // Mauvaise correspondance
      const raison = mismatchToRaison(mismatches);
      await supabase.from("depot_orders").update({
        status: "Paiement Non Reçu",
        flag_raison: raison,
        flagged_at: new Date().toISOString(),
        auto_notified: true,
      }).eq("id", ordre.id);
      if (whatsapp) {
        await sendWhatsApp(whatsapp,
          `❌ *Baki-Pay — Paiement non reçu*\n\nVotre ordre *#${ordreId}* n'a pas pu être traité.\n` +
          `Raison : ${raison}\n\nVérifiez les informations et soumettez un nouvel ordre sur baki-pay.com`
        ).catch(() => {});
      }
      await sendTelegram(token, adminId,
        `❌ <b>Dépôt rejeté (${score}/3) — ${raison}</b>\n\n` +
        `Ordre <code>#${ordreId}</code>\n${mismatches.map((m: string) => `• ${m}`).join("\n")}`);
      logAudit("depot_rejete_mauvaise_correspondance", { ordreId, score, mismatches, raison });
      return;
    }

    // Aucun SMS Waafi avec ce TID
    const raisonIntrouvable = "Transfer ID introuvable — paiement non reçu";
    await supabase.from("depot_orders").update({
      status: "Paiement Non Reçu",
      flag_raison: raisonIntrouvable,
      flagged_at: new Date().toISOString(),
      auto_notified: true,
    }).eq("id", ordre.id);
    if (whatsapp) {
      await sendWhatsApp(whatsapp,
        `❌ *Baki-Pay — Paiement non reçu*\n\nVotre ordre *#${ordreId}* n'a pas pu être traité.\n` +
        `Raison : Transfer ID introuvable\n\nVérifiez votre Transfer ID Waafi et soumettez un nouvel ordre sur baki-pay.com`
      ).catch(() => {});
    }
    await sendTelegram(token, adminId,
      `❌ <b>Dépôt rejeté — TID introuvable</b>\n\n` +
      `Ordre: <code>#${ordreId}</code>\n` +
      `Transfer-ID: <code>${transferId}</code>\n` +
      `Montant: ${montant.toLocaleString()} DJF\n\n` +
      `<i>Aucun SMS Waafi avec ce Transfer ID dans les registres.</i>`);
    logAudit("depot_rejete_tid_introuvable", { ordreId, transferId });
  })().catch((e) => console.error("submit-depot async error:", e));

  return response;
});
