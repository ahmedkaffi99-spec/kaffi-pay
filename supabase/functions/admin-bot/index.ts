import { supabase } from "../_shared/db.ts";
import { sendTelegram, sendTelegramKeyboard, notifyPaiementAgents, answerCallback } from "../_shared/telegram.ts";
import { extractTransferId, extractMontant, extractNumClient } from "../_shared/parser.ts";
import { scorerCorrespondance, mismatchToRaison } from "../_shared/scoring.ts";
import { callMobcash, callMobcashDepot } from "../_shared/mobcash.ts";
import { confirmerDepot } from "../_shared/confirmer.ts";
import { json, cors, logAudit, transitionValide, webhookStatusPourErreurMobcash } from "../_shared/utils.ts";

const ADMIN_KEY = "kp2026_9f3aXmQ7";

async function findOrder(num: string) {
  const [d, r] = await Promise.all([
    supabase.from("depot_orders").select("*").eq("order_id", num).limit(1),
    supabase.from("retrait_orders").select("*").eq("order_id", num).limit(1),
  ]);
  if (d.data && d.data.length > 0) return { ...d.data[0], _table: "depot_orders" };
  if (r.data && r.data.length > 0) return { ...r.data[0], _table: "retrait_orders" };
  return null;
}

async function updateOrder(table: string, id: string, data: Record<string, unknown>) {
  return supabase.from(table).update(data).eq("id", id);
}

async function isAuthorized(chatId: string, adminId: string): Promise<boolean> {
  if (chatId === adminId) return true;
  const { data } = await supabase.from("agents")
    .select("id").eq("chat_id", chatId).eq("actif", true).limit(1);
  return !!(data && data.length > 0);
}

Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405, headers);

  const body = await req.json().catch(() => ({}));
  const token = Deno.env.get("TELEGRAM_TOKEN")!;
  const adminId = Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")!;

  try {
    // Callback query (bouton inline)
    if (body.callback_query) {
      const cb = body.callback_query;
      const cbId = cb.id;
      const cbData = cb.data || "";
      const fromId = String(cb.from.id);

      const authorized = await isAuthorized(fromId, adminId);

      if (authorized && cbData.startsWith("terminer_")) {
        const ordreId = cbData.replace("terminer_", "");
        await answerCallback(token, cbId, "✅ Retrait finalisé !");

        const ordre = await findOrder(ordreId);
        if (!ordre) {
          await sendTelegram(token, fromId, `❓ Ordre <b>#${ordreId}</b> introuvable.`);
          return json({ ok: true }, 200, headers);
        }

        if (ordre.status === "Payé") {
          await sendTelegram(token, fromId, `ℹ️ Retrait <b>#${ordreId}</b> déjà finalisé.`);
          return json({ ok: true }, 200, headers);
        }

        if (!transitionValide(ordre.status, "Payé")) {
          await sendTelegram(token, fromId,
            `⛔ Impossible de finaliser — statut actuel : <b>${ordre.status}</b>.`);
          return json({ ok: true }, 200, headers);
        }

        await updateOrder(ordre._table, ordre.id, {
          status: "Payé",
          finalise_par: fromId === adminId ? "admin_terminer_button" : "agent_paiement_terminer",
          finalise_at: new Date().toISOString(),
        });
        await supabase.from("ordre_traite").insert({
          transfer_id: ordreId,
          ordre_id: ordreId,
          status: "finalise",
          credited_at: new Date().toISOString(),
        });
        logAudit("retrait_finalise_admin", { ordreId, adminId, parAgent: fromId !== adminId });
        await sendTelegram(token, fromId, `✅ Retrait <b>#${ordreId}</b> — Payé. Notifications client en cours…`);

      } else if (authorized && cbData.startsWith("pay_recharge_")) {
        const ordreId = cbData.replace("pay_recharge_", "");
        await answerCallback(token, cbId, "⚡ Relance en cours…");
        const ordre = await findOrder(ordreId);
        if (!ordre) { await sendTelegram(token, fromId, `❓ Ordre <b>#${ordreId}</b> introuvable.`); return json({ ok: true }, 200, headers); }
        const id1xbet = ordre.user_id_1xbet || ordre.id1x || "";
        const montantVal = ordre.montant || 0;
        if (!id1xbet) { await sendTelegram(token, fromId, `⚠️ ID 1xBet manquant pour <b>#${ordreId}</b>.`); return json({ ok: true }, 200, headers); }
        await sendTelegram(token, fromId, `🔄 Relance MobCash — <b>#${ordreId}</b> | <code>${id1xbet}</code>…`);
        try {
          if ((ordre.type || "Dépôt") === "Retrait") {
            await callMobcash("Retrait", id1xbet, montantVal, ordre.withdrawal_code || "");
          } else {
            await callMobcashDepot(id1xbet, montantVal);
          }
          const newStatus = ordre.type === "Retrait" ? "Code Validé" : "Crédité avec succès";
          await updateOrder(ordre._table, ordre.id, { status: newStatus, webhook_status: "ok", webhook_at: new Date().toISOString() });
          logAudit("recharge_agent_paiement_ok", { ordreId, agentId: fromId, id1xbet });
          await sendTelegram(token, fromId,
            `✅ <b>Recharge réussie !</b>\n#${ordreId} | <code>${id1xbet}</code> | ${Number(montantVal).toLocaleString()} DJF`);
        } catch (e: unknown) {
          const errMsg = (e as Error).message || "";
          const webhookStatus = webhookStatusPourErreurMobcash(errMsg);
          await updateOrder(ordre._table, ordre.id, {
            webhook_status: webhookStatus, webhook_err: errMsg, webhook_at: new Date().toISOString(),
          });
          const hint = webhookStatus === "echec_permanent"
            ? "\n<i>Compte probablement en devise étrangère — utilisez <code>recharge " + ordreId + " NOUVEL_ID</code>.</i>"
            : webhookStatus === "echec_solde"
            ? "\n<i>Solde cashdesk insuffisant — rechargez puis relancez.</i>"
            : "";
          await sendTelegram(token, fromId, `❌ Échec MobCash : <code>${errMsg}</code>${hint}`);
        }
      } else {
        await answerCallback(token, cbId, "");
      }
      return json({ ok: true }, 200, headers);
    }

    // Message texte
    const msg = body.message || body.edited_message;
    if (!msg) return json({ ok: true }, 200, headers);

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();
    const replyId = chatId;

    if (!text) return json({ ok: true }, 200, headers);

    const authorized = await isAuthorized(chatId, adminId);
    if (!authorized) return json({ ok: true }, 200, headers);

    const t = text.toLowerCase().trim();

    // confirmer #ID
    const confirmMatch = text.match(/^confirmer?\s+#?(\S+)\b/i);
    if (confirmMatch) {
      const num = confirmMatch[1];
      const ordre = await findOrder(num);
      if (!ordre) { await sendTelegram(token, replyId, `❓ Ordre <b>#${num}</b> introuvable.`); return json({ ok: true }, 200, headers); }
      if (["Crédité avec succès", "Payé"].includes(ordre.status)) {
        await sendTelegram(token, replyId, `ℹ️ <b>#${num}</b> déjà finalisé.`); return json({ ok: true }, 200, headers);
      }
      const montantVal = Number(ordre.montant || 0);
      if (ordre.type === "Retrait" || ordre._table === "retrait_orders") {
        if (!transitionValide(ordre.status, "Code Validé")) {
          await sendTelegram(token, replyId, `⛔ Impossible de confirmer — statut : <b>${ordre.status}</b>.`); return json({ ok: true }, 200, headers);
        }
        await updateOrder(ordre._table, ordre.id, { status: "Code Validé", confirmed_by: "admin_telegram", confirmed_at: new Date().toISOString() });
        await sendTelegram(token, replyId, `✅ Retrait <b>#${num}</b> — Code Validé — ${montantVal.toLocaleString()} DJF`);
        const wNum = (ordre.numero_waafi || ordre.tel || "").replace(/\s/g, "").replace(/^\+?253/, "");
        if (wNum) {
          const ussd = `*200*${wNum}*${montantVal}#`;
          const ussdMsg = `📤 <b>Retrait à payer — #${num}</b>\n\nMontant : <b>${montantVal.toLocaleString()} DJF</b>\nN° Waafi : <code>${wNum}</code>\n📱 USSD : <code>${ussd}</code>`;
          const ussdKb = [[{ text: "✅ Paiement Waafi effectué — Terminer", callback_data: `terminer_${num}` }]];
          await sendTelegramKeyboard(token, adminId, ussdMsg, ussdKb);
          await notifyPaiementAgents(token, ussdMsg, ussdKb).catch(() => {});
        }
      } else {
        if (!transitionValide(ordre.status, "Paiement Reçu")) {
          await sendTelegram(token, replyId, `⛔ Impossible de confirmer — statut : <b>${ordre.status}</b>.`); return json({ ok: true }, 200, headers);
        }
        await updateOrder(ordre._table, ordre.id, { status: "Paiement Reçu", confirmed_by: "admin_telegram", confirmed_at: new Date().toISOString() });
        await sendTelegram(token, replyId, `✅ Dépôt <b>#${num}</b> confirmé — ${montantVal.toLocaleString()} DJF\n🔄 MobCash en cours...`);
      }
      logAudit("confirme_admin_telegram", { num, adminId: chatId, type: ordre._table });
      return json({ ok: true }, 200, headers);
    }

    // rejeter #ID [raison]
    const rejectMatch = text.match(/^rejeter?\s+#?(\S+)(?:\s+(.+))?$/i);
    if (rejectMatch) {
      const num = rejectMatch[1];
      const raison = (rejectMatch[2] || "Rejeté par admin").trim();
      const ordre = await findOrder(num);
      if (!ordre) { await sendTelegram(token, replyId, `❓ Ordre <b>#${num}</b> introuvable.`); return json({ ok: true }, 200, headers); }
      if (["Paiement Non Reçu", "Code Invalide"].includes(ordre.status)) {
        await sendTelegram(token, replyId, `ℹ️ <b>#${num}</b> déjà rejeté.`); return json({ ok: true }, 200, headers);
      }
      const rejetStatut = ordre._table === "retrait_orders" ? "Code Invalide" : "Paiement Non Reçu";
      if (!transitionValide(ordre.status, rejetStatut)) {
        await sendTelegram(token, replyId, `⛔ Impossible de rejeter — statut : <b>${ordre.status}</b>.`); return json({ ok: true }, 200, headers);
      }
      await updateOrder(ordre._table, ordre.id, { status: rejetStatut, flag_raison: raison, rejected_by: "admin_telegram", flagged_at: new Date().toISOString() });
      logAudit("rejete_admin_telegram", { num, raison, adminId: chatId, type: ordre._table });
      await sendTelegram(token, replyId, `❌ Ordre <b>#${num}</b> — ${rejetStatut}.\nRaison : <i>${raison}</i>`);
      return json({ ok: true }, 200, headers);
    }

    // remettre #ID
    const remettreMatch = text.match(/^remettre\s+#?(\S+)\b/i);
    if (remettreMatch) {
      const num = remettreMatch[1];
      const ordre = await findOrder(num);
      if (!ordre) { await sendTelegram(token, replyId, `❓ Ordre <b>#${num}</b> introuvable.`); return json({ ok: true }, 200, headers); }
      if (!transitionValide(ordre.status, "En attente")) {
        await sendTelegram(token, replyId, `⛔ Impossible de remettre en attente un ordre en statut <b>${ordre.status}</b>.`); return json({ ok: true }, 200, headers);
      }
      await updateOrder(ordre._table, ordre.id, { status: "En attente", remis_en_attente_by: "admin_telegram", remis_en_attente_at: new Date().toISOString() });
      logAudit("remis_en_attente_admin", { num, adminId: chatId, ancienStatut: ordre.status });
      await sendTelegram(token, replyId, `🔄 Ordre <b>#${num}</b> remis en attente.`);
      return json({ ok: true }, 200, headers);
    }

    // client 77XXXXXXX
    const clientMatch = text.match(/^client\s+((?:77|78|70|71|21)\d{6})\b/i);
    if (clientMatch) {
      const phone = clientMatch[1];
      const [d, r] = await Promise.all([
        supabase.from("depot_orders").select("order_id,montant,status,flag_raison").eq("numero_payment", phone).limit(10),
        supabase.from("retrait_orders").select("order_id,montant,status,flag_raison").eq("numero_waafi", phone).limit(10),
      ]);
      const all = [...(d.data || []).map(o => ({ ...o, type: "Dépôt" })), ...(r.data || []).map(o => ({ ...o, type: "Retrait" }))];
      if (!all.length) { await sendTelegram(token, replyId, `❓ Aucun ordre pour <code>${phone}</code>.`); return json({ ok: true }, 200, headers); }
      const lignes = all.map(o => `• #${o.order_id} | ${o.type} | ${o.montant} DJF | ${o.status}`);
      await sendTelegram(token, replyId, `👤 <b>Ordres ${phone} (${all.length})</b>\n\n${lignes.join("\n")}`);
      return json({ ok: true }, 200, headers);
    }

    // alerte
    if (t === "alerte" || t === "/alerte") {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const [d, r] = await Promise.all([
        supabase.from("depot_orders").select("order_id,montant,created_at").eq("status", "En attente").lt("created_at", cutoff),
        supabase.from("retrait_orders").select("order_id,montant,created_at").eq("status", "En attente").lt("created_at", cutoff),
      ]);
      const vieux = [...(d.data || []).map(o => ({ ...o, type: "Dépôt" })), ...(r.data || []).map(o => ({ ...o, type: "Retrait" }))];
      if (!vieux.length) { await sendTelegram(token, replyId, "✅ Aucun ordre en attente > 30 min."); return json({ ok: true }, 200, headers); }
      const lignes = vieux.map(o => {
        const age = Math.round((Date.now() - new Date(o.created_at).getTime()) / 60000);
        return `• #${o.order_id} | ${o.type} | ${o.montant} DJF | ⏱ ${age}min`;
      });
      await sendTelegram(token, replyId, `⚠️ <b>Bloqués > 30 min (${vieux.length})</b>\n\n${lignes.join("\n")}\n\n<i>confirmer #ID | rejeter #ID raison</i>`);
      return json({ ok: true }, 200, headers);
    }

    // nonmatche
    if (t === "nonmatche" || t === "/nonmatche") {
      const { data: notifs } = await supabase.from("waafi_notifications")
        .select("transfer_id,montant,num_client,status").neq("status", "matché").order("created_at", { ascending: false }).limit(20);
      if (!notifs || !notifs.length) { await sendTelegram(token, replyId, "✅ Aucun SMS en attente."); return json({ ok: true }, 200, headers); }
      const lignes = notifs.map(n => `• TID:${n.transfer_id || "?"} | ${n.montant || "?"}DJF | N°${n.num_client || "?"} | ${n.status}`);
      await sendTelegram(token, replyId, `📭 <b>SMS en attente (${notifs.length})</b>\n\n${lignes.join("\n")}`);
      return json({ ok: true }, 200, headers);
    }

    // /sms <texte>
    const smsMatch = text.match(/^\/sms\s+(.+)/is);
    if (smsMatch) {
      const smsText = smsMatch[1].trim();
      const tid = extractTransferId(smsText);
      const montantParsed = extractMontant(smsText);
      const numCli = extractNumClient(smsText);

      if (!tid && !montantParsed) {
        await sendTelegram(token, replyId,
          `❌ <b>SMS non reconnu</b>\nFormat attendu : Transfer-Id, Received DJF, numéro\n\nSMS reçu :\n<code>${smsText.substring(0, 200)}</code>`);
        return json({ ok: true }, 200, headers);
      }

      // Vérifier si TID déjà enregistré
      let existingNotif = null;
      if (tid) {
        const { data: ex } = await supabase.from("waafi_notifications")
          .select("*").eq("transfer_id", tid).limit(1);
        if (ex && ex.length > 0) existingNotif = ex[0];
      }

      let notifId: string;
      if (existingNotif) {
        notifId = existingNotif.id;
        await sendTelegram(token, replyId, `ℹ️ TID <code>${tid}</code> déjà enregistré — tentative de confirmation...`);
      } else {
        const { data: newNotif } = await supabase.from("waafi_notifications").insert({
          notification: smsText, transfer_id: tid, montant: montantParsed, num_client: numCli,
          source: "admin_manual", status: "reçu",
        }).select().single();
        notifId = newNotif?.id;
        await sendTelegram(token, replyId,
          `📩 <b>SMS Waafi enregistré</b>\n\nTransfer-ID: <code>${tid || "?"}</code>\n` +
          `Montant: <b>${montantParsed ? Number(montantParsed).toLocaleString() : "?"} DJF</b>\n` +
          `Expéditeur: <code>${numCli || "?"}</code>\n\n<i>Recherche d'un ordre correspondant...</i>`);
      }

      if (!tid) {
        await sendTelegram(token, replyId, `⚠️ Transfer-ID non trouvé dans le SMS — confirmation manuelle requise.`);
        return json({ ok: true }, 200, headers);
      }

      const { data: ordreList } = await supabase.from("depot_orders")
        .select("*").eq("waafi_transfert_id", tid).eq("status", "En attente").limit(1);
      if (!ordreList || !ordreList.length) {
        await sendTelegram(token, replyId,
          `⏳ Aucun ordre "En attente" avec TID <code>${tid}</code> trouvé.\nLa notification est enregistrée.`);
        return json({ ok: true }, 200, headers);
      }

      const { data: dejaTraite } = await supabase.from("ordre_traite")
        .select("id").eq("transfer_id", tid).eq("status", "credite").limit(1);
      if (dejaTraite && dejaTraite.length > 0) {
        await sendTelegram(token, replyId, `⚠️ TID <code>${tid}</code> déjà crédité — doublon bloqué.`);
        return json({ ok: true }, 200, headers);
      }

      const ordreDoc = ordreList[0];
      const { data: notifDoc } = await supabase.from("waafi_notifications").select("*").eq("id", notifId).single();
      const { score, mismatches, decision } = scorerCorrespondance(ordreDoc, notifDoc);
      const ordreRef2 = ordreDoc.order_id || ordreDoc.id;

      if (decision === "confirmer") {
        await confirmerDepot(ordreDoc, notifDoc, token, adminId);
        await sendTelegram(token, replyId, `✅ Ordre <b>#${ordreRef2}</b> confirmé via SMS manuel.`);
      } else {
        const raison = mismatchToRaison(mismatches);
        await sendTelegram(token, replyId,
          `❌ <b>Score ${score}/3 — ${raison}</b>\nOrdre <code>#${ordreRef2}</code>\n` +
          mismatches.map((m: string) => `• ${m}`).join("\n") +
          `\n\nUtilise <code>confirmer ${ordreRef2}</code> pour forcer si nécessaire.`);
      }
      return json({ ok: true }, 200, headers);
    }

    // recharge #ID [nouvelID1xBet] — le second paramètre est optionnel, utile
    // quand la relance précédente a échoué pour cause de compte en devise
    // étrangère et que le client a fourni un nouvel ID en DJF.
    const rechargeMatch = text.match(/^recharge\s+#?(\S+)(?:\s+(\S+))?\s*$/i);
    if (rechargeMatch) {
      const num = rechargeMatch[1];
      const nouvelId = (rechargeMatch[2] || "").trim();
      const ordre = await findOrder(num);
      if (!ordre) { await sendTelegram(token, replyId, `❓ Ordre <b>#${num}</b> introuvable.`); return json({ ok: true }, 200, headers); }
      if (ordre.status !== "Paiement Reçu" || ordre.webhook_status === "ok") {
        await sendTelegram(token, replyId, `⛔ Ordre <b>#${num}</b> ne peut pas être rechargé (statut: <b>${ordre.status}</b>).`); return json({ ok: true }, 200, headers);
      }
      const id1xbet = nouvelId || ordre.user_id_1xbet || ordre.id1x || "";
      const montantVal = ordre.montant || 0;
      if (!id1xbet) { await sendTelegram(token, replyId, `⚠️ ID 1xBet manquant pour <b>#${num}</b>.`); return json({ ok: true }, 200, headers); }
      await sendTelegram(token, replyId, `🔄 Relance MobCash — <b>#${num}</b> | <code>${id1xbet}</code>…`);
      try {
        if ((ordre.type || "Dépôt") === "Retrait") {
          await callMobcash("Retrait", id1xbet, montantVal, ordre.withdrawal_code || "");
        } else {
          await callMobcashDepot(id1xbet, montantVal);
        }
        await updateOrder(ordre._table, ordre.id, {
          status: "Crédité avec succès", webhook_status: "ok", webhook_at: new Date().toISOString(), recharge_admin: true,
          ...(nouvelId ? { user_id_1xbet: nouvelId } : {}),
        });
        logAudit("recharge_manuelle_ok", { num, adminId: chatId, id1xbet });
        await sendTelegram(token, replyId,
          `✅ <b>Recharge réussie !</b>\n#${num} | <code>${id1xbet}</code> | ${Number(montantVal).toLocaleString()} DJF`);
      } catch (e: unknown) {
        const errMsg = (e as Error).message || "";
        const webhookStatus = webhookStatusPourErreurMobcash(errMsg);
        await updateOrder(ordre._table, ordre.id, {
          webhook_status: webhookStatus, webhook_err: errMsg, webhook_at: new Date().toISOString(),
          ...(nouvelId ? { user_id_1xbet: nouvelId } : {}),
        });
        const hint = webhookStatus === "echec_permanent"
          ? "\n<i>Compte probablement en devise étrangère — <code>recharge " + num + " NOUVEL_ID</code> avec un ID DJF.</i>"
          : webhookStatus === "echec_solde"
          ? "\n<i>Solde cashdesk insuffisant — rechargez puis relancez.</i>"
          : "";
        await sendTelegram(token, replyId, `❌ Échec MobCash : <code>${errMsg}</code>${hint}`);
      }
      return json({ ok: true }, 200, headers);
    }

    // webhook admin — configure le webhook du bot admin
    if (t === "webhook admin" || t === "/webhook_admin") {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const funcUrl = `${supabaseUrl}/functions/v1/admin-bot`;
      const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: funcUrl, allowed_updates: ["message", "callback_query"] }),
        signal: AbortSignal.timeout(10000),
      });
      const rj = await r.json().catch(() => ({}));
      if (rj.ok) {
        await sendTelegram(token, replyId, `✅ Webhook admin bot configuré :\n<code>${funcUrl}</code>`);
      } else {
        await sendTelegram(token, replyId, `❌ Erreur webhook : ${rj.description || r.status}`);
      }
      return json({ ok: true }, 200, headers);
    }

    // webhook support
    if (t === "webhook support" || t === "/webhook_support") {
      const sToken = Deno.env.get("SUPPORT_BOT_TOKEN");
      if (!sToken) { await sendTelegram(token, replyId, "❌ Secret SUPPORT_BOT_TOKEN non configuré."); return json({ ok: true }, 200, headers); }
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const funcUrl = `${supabaseUrl}/functions/v1/support-client`;
      const r = await fetch(`https://api.telegram.org/bot${sToken}/setWebhook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: funcUrl, allowed_updates: ["message", "callback_query"] }),
        signal: AbortSignal.timeout(10000),
      });
      const rj = await r.json().catch(() => ({}));
      if (rj.ok) {
        await sendTelegram(token, replyId, `✅ Webhook support bot configuré :\n<code>${funcUrl}</code>`);
      } else {
        await sendTelegram(token, replyId, `❌ Erreur webhook : ${rj.description || r.status}`);
      }
      return json({ ok: true }, 200, headers);
    }

    // test mobcash
    if (t === "test mobcash" || t === "/test_mobcash") {
      await sendTelegram(token, replyId, "🔄 Test MobCash…");
      try {
        await callMobcash("Dépôt", "TEST_NO_EXEC", 0, "");
        await sendTelegram(token, replyId, "✅ MobCash répond correctement !");
      } catch (e: unknown) {
        await sendTelegram(token, replyId,
          `❌ MobCash : <code>${(e as Error).message}</code>\n\nVérifiez les secrets MOBCASH_*`);
      }
      return json({ ok: true }, 200, headers);
    }

    // statut support
    if (t === "statut support" || t === "/statut_support") {
      const sToken = Deno.env.get("SUPPORT_BOT_TOKEN");
      if (!sToken) { await sendTelegram(token, replyId, "❌ Secret SUPPORT_BOT_TOKEN non configuré."); return json({ ok: true }, 200, headers); }
      const [meR, whR] = await Promise.all([
        fetch(`https://api.telegram.org/bot${sToken}/getMe`, { signal: AbortSignal.timeout(8000) }),
        fetch(`https://api.telegram.org/bot${sToken}/getWebhookInfo`, { signal: AbortSignal.timeout(8000) }),
      ]);
      const meJ = await meR.json().catch(() => ({}));
      const whJ = await whR.json().catch(() => ({}));
      const bot = meJ.result || {};
      const wh = whJ.result || {};
      await sendTelegram(token, replyId,
        `🤖 <b>Support Bot — Diagnostic</b>\n\n` +
        `<b>Bot :</b> ${bot.first_name || "?"} (@${bot.username || "?"})\n` +
        `<b>Token :</b> ${meJ.ok ? "✅ valide" : "❌ invalide"}\n\n` +
        `<b>Webhook URL :</b>\n<code>${wh.url || "❌ non configuré"}</code>\n` +
        `<b>Mises à jour en attente :</b> ${wh.pending_update_count ?? "?"}\n` +
        `<b>Dernière erreur :</b> ${wh.last_error_message ? `❌ ${wh.last_error_message}` : "✅ aucune"}`
      );
      return json({ ok: true }, 200, headers);
    }

    // agents — liste et test
    if (t === "agents" || t === "/agents") {
      const { data: agentsList } = await supabase.from("agents").select("nom,chat_id,role,actif");
      if (!agentsList || !agentsList.length) {
        await sendTelegram(token, replyId, "Aucun agent enregistré."); return json({ ok: true }, 200, headers);
      }
      const paiement = agentsList.filter(a => a.role === "paiement");
      const support = agentsList.filter(a => a.role === "support");
      let lines = `👥 <b>Agents (${agentsList.length})</b>\n\n`;
      lines += `<b>Paiement (${paiement.length}) :</b>\n`;
      paiement.forEach(a => { lines += `• ${a.nom || "?"} | <code>${a.chat_id}</code> | ${a.actif ? "✅" : "❌"}\n`; });
      lines += `\n<b>Support (${support.length}) :</b>\n`;
      support.forEach(a => { lines += `• ${a.nom || "?"} | <code>${a.chat_id}</code> | ${a.actif ? "✅" : "❌"}\n`; });
      await sendTelegram(token, replyId, lines);
      return json({ ok: true }, 200, headers);
    }

    // Requête générale — tableau de bord
    const [recentD, recentR, attenteD, attenteR, notifSnap] = await Promise.all([
      supabase.from("depot_orders").select("order_id,montant,status,flag_raison,numero_payment").order("created_at", { ascending: false }).limit(10),
      supabase.from("retrait_orders").select("order_id,montant,status,flag_raison,numero_waafi").order("created_at", { ascending: false }).limit(10),
      supabase.from("depot_orders").select("order_id,montant,status,flag_raison,numero_payment").eq("status", "En attente"),
      supabase.from("retrait_orders").select("order_id,montant,status,flag_raison,numero_waafi").eq("status", "En attente"),
      supabase.from("waafi_notifications").select("transfer_id,montant,num_client,status").order("created_at", { ascending: false }).limit(10),
    ]);

    const seen = new Set<string>();
    const allOrders = [
      ...(recentD.data || []).map(o => ({ ...o, type: "Dépôt" })),
      ...(recentR.data || []).map(o => ({ ...o, type: "Retrait" })),
      ...(attenteD.data || []).map(o => ({ ...o, type: "Dépôt" })),
      ...(attenteR.data || []).map(o => ({ ...o, type: "Retrait" })),
    ].filter(o => { const k = o.order_id; if (seen.has(k)) return false; seen.add(k); return true; });

    const orderLines = allOrders.map(o =>
      `• #${o.order_id} | ${o.type} | ${o.montant} DJF | ${o.status}${o.flag_raison ? ` | ${o.flag_raison}` : ""}`
    );
    const notifLines = (notifSnap.data || []).map((n: { transfer_id: string; montant: number; num_client: string; status: string }) =>
      `• TID:${n.transfer_id || "?"} | ${n.montant || "?"}DJF | N°${n.num_client || "?"} | ${n.status}`
    );

    const attenteCount = (attenteD.data?.length || 0) + (attenteR.data?.length || 0);
    let report = `📊 <b>Tableau de bord Baki-Pay</b>\n\n`;
    report += `⏳ En attente : <b>${attenteCount}</b> ordre(s)\n\n`;
    if (orderLines.length) report += `<b>Ordres récents :</b>\n${orderLines.slice(0, 10).join("\n")}\n\n`;
    if (notifLines.length) report += `<b>SMS Waafi récents :</b>\n${notifLines.join("\n")}\n\n`;
    report += `<i>Commandes : confirmer #ID | rejeter #ID | remettre #ID | /sms | alerte | nonmatche | agents | recharge #ID</i>`;

    await sendTelegram(token, replyId, report);

  } catch (e) {
    console.error("admin-bot crash:", (e as Error).message);
  }

  return json({ ok: true }, 200, headers);
});
