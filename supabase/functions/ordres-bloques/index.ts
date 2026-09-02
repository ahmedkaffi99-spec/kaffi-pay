import { supabase } from "../_shared/db.ts";
import { sendTelegram, notifyPaiementAgents, sendTelegramKeyboard } from "../_shared/telegram.ts";
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import { callMobcash } from "../_shared/mobcash.ts";
import { scorerCorrespondance, mismatchToRaison } from "../_shared/scoring.ts";
import { confirmerDepot } from "../_shared/confirmer.ts";
import { json, cors, logAudit } from "../_shared/utils.ts";

// Called by pg_cron every 5 minutes (or manually via HTTP GET with secret)
Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  // Accept GET with secret header OR POST (from pg_cron via HTTP)
  const secret = req.headers.get("x-cron-secret") || new URL(req.url).searchParams.get("secret");
  const expected = Deno.env.get("CRON_SECRET") || "cron_kaffi_secret";
  if (secret !== expected) return json({ error: "Non autorisé" }, 403, headers);

  const token = Deno.env.get("TELEGRAM_TOKEN")!;
  const adminId = Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")!;
  let processed = 0;

  // ── PARTIE 1 : Dépôts "Paiement Reçu" bloqués → relance MobCash ──
  const cutoff10 = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: blockedDepots } = await supabase.from("depot_orders")
    .select("*")
    .eq("status", "Paiement Reçu")
    .neq("webhook_status", "ok")
    .lt("confirmed_at", cutoff10)
    .limit(10);

  for (const ordre of (blockedDepots || [])) {
    const ordreId = ordre.order_id;
    const id1xbet = ordre.user_id_1xbet || ordre.id1x || "";
    const montantVal = Number(ordre.montant || 0);

    if (!id1xbet) {
      await sendTelegram(token, adminId,
        `⚠️ <b>ID 1xBet manquant</b> — #${ordreId}\n${montantVal.toLocaleString()} DJF en attente de crédit.`
      );
      continue;
    }

    try {
      await callMobcash("Dépôt", id1xbet, montantVal, "");
      await supabase.from("depot_orders").update({
        status: "Crédité avec succès",
        webhook_status: "ok",
        webhook_at: new Date().toISOString(),
        mobcash_at: new Date().toISOString(),
      }).eq("id", ordre.id);
      logAudit("depot_mobcash_relance_ok", { ordreId, id1xbet, montantVal });
      await sendTelegram(token, adminId,
        `✅ <b>Relance MobCash réussie</b> — #${ordreId}\n${montantVal.toLocaleString()} DJF crédité sur <code>${id1xbet}</code>`);
      if (ordre.whatsapp) {
        await sendWhatsApp(ordre.whatsapp,
          `✅ *Baki-Pay — Crédité avec succès* 🎉\n\nVotre dépôt *#${ordreId}* de *${montantVal.toLocaleString()} DJF* a été crédité sur votre compte 1xBet.\n\n📲 baki-pay.com/#suivi-${ordreId}${ordre.view_token ? `-${ordre.view_token}` : ""}`
        ).catch(() => {});
      }
      processed++;
    } catch (e: unknown) {
      const errMsg = (e as Error).message || "";
      await sendTelegram(token, adminId,
        `❌ <b>Relance MobCash échouée</b> — #${ordreId}\n` +
        `ID: <code>${id1xbet}</code> | ${montantVal.toLocaleString()} DJF\n` +
        `Erreur : <code>${errMsg.substring(0, 200)}</code>`);
      await supabase.from("depot_orders").update({
        webhook_status: "echec",
        webhook_at: new Date().toISOString(),
      }).eq("id", ordre.id);
    }
  }

  // ── PARTIE 2 : Dépôts "En attente" bloqués > 15 min → retry matching Waafi ──
  const cutoff15 = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: depotAttente } = await supabase.from("depot_orders")
    .select("*")
    .eq("status", "En attente")
    .lt("created_at", cutoff15)
    .eq("auto_notified", false)
    .limit(20);

  for (const ordre of (depotAttente || [])) {
    const ordreId = ordre.order_id;
    const transferId = ordre.waafi_transfert_id || "";
    const phone = ordre.numero_payment || "";
    const montantVal = Number(ordre.montant || 0);

    if (!transferId) continue;

    // Chercher une notif Waafi non matchée
    const { data: notifList } = await supabase.from("waafi_notifications")
      .select("*").eq("transfer_id", transferId).neq("status", "matché").limit(1);

    let waafiNotif = notifList && notifList.length > 0 ? notifList[0] : null;

    // Fallback par numéro
    if (!waafiNotif && phone) {
      const tolerance = Math.max(5, montantVal * 0.05);
      const { data: byPhone } = await supabase.from("waafi_notifications")
        .select("*").eq("num_client", phone).neq("status", "matché").limit(10);
      if (byPhone) {
        for (const n of byPhone) {
          if (n.montant && Math.abs(montantVal - Number(n.montant)) > tolerance) continue;
          waafiNotif = n;
          break;
        }
      }
    }

    if (waafiNotif) {
      const { decision } = scorerCorrespondance(ordre, waafiNotif);
      if (decision === "confirmer") {
        await confirmerDepot(ordre, waafiNotif, token, adminId);
        processed++;
      }
    } else {
      // Marquer auto_notified pour ne pas réessayer indéfiniment
      await supabase.from("depot_orders").update({ auto_notified: true }).eq("id", ordre.id);
      const rechargeKb = [[{ text: "⚡ Relancer MobCash", callback_data: `pay_recharge_${ordreId}` }]];
      await sendTelegramKeyboard(token, adminId,
        `⚠️ <b>Dépôt en attente > 15 min</b>\n\n` +
        `Ordre <code>#${ordreId}</code> | ${montantVal.toLocaleString()} DJF\n` +
        `Transfer-ID: <code>${transferId || "—"}</code>\n` +
        `N° Waafi: <code>${phone || "—"}</code>\n\n` +
        `<i>Aucun SMS Waafi correspondant trouvé.</i>`,
        rechargeKb
      );
      await notifyPaiementAgents(token,
        `⚠️ <b>Dépôt en attente > 15 min — #${ordreId}</b>\n${montantVal.toLocaleString()} DJF | TID: <code>${transferId || "—"}</code>`,
        rechargeKb
      ).catch(() => {});
    }
  }

  // ── PARTIE 3 : Retraits "Code Validé" bloqués > 30 min ──
  const cutoff30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: retraitBloques } = await supabase.from("retrait_orders")
    .select("*")
    .eq("status", "Code Validé")
    .lt("mobcash_at", cutoff30)
    .limit(10);

  for (const ordre of (retraitBloques || [])) {
    const ordreId = ordre.order_id;
    const montantVal = Number(ordre.montant || 0);
    const waafiNum = (ordre.numero_waafi || "").replace(/\s/g, "").replace(/^\+?253/, "");
    const ussd = waafiNum ? `*200*${waafiNum}*${montantVal}#` : "—";

    const retraitKb = [[{ text: "✅ Paiement Waafi effectué — Terminer", callback_data: `terminer_${ordreId}` }]];
    await sendTelegramKeyboard(token, adminId,
      `⚠️ <b>Retrait bloqué > 30 min — #${ordreId}</b>\n\n` +
      `Montant : <b>${montantVal.toLocaleString()} DJF</b>\n` +
      `N° Waafi : <code>${waafiNum || "—"}</code>\n` +
      `📱 USSD : <code>${ussd}</code>\n\n` +
      `<i>Le retrait 1xBet a été effectué. Avez-vous payé en Waafi ?</i>`,
      retraitKb
    );
    await notifyPaiementAgents(token,
      `⚠️ <b>Retrait à finaliser — #${ordreId}</b>\n${montantVal.toLocaleString()} DJF | N°<code>${waafiNum || "—"}</code>`,
      retraitKb
    ).catch(() => {});
  }

  return json({ ok: true, processed, timestamp: new Date().toISOString() }, 200, headers);
});
