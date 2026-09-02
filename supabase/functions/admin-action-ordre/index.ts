import { supabase } from "../_shared/db.ts";
import { sendTelegram, notifyPaiementAgents } from "../_shared/telegram.ts";
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import { callMobcash } from "../_shared/mobcash.ts";
import { json, cors, logAudit } from "../_shared/utils.ts";

const ADMIN_KEY = "kp2026_9f3aXmQ7";

const ERREURS_PERMANENTES = [
  "currency does not match", "account currency",
  "user not found", "invalid user", "account not found",
];

Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });
  if (req.method !== "POST") return json({ error: "POST requis" }, 405, headers);

  const body = await req.json().catch(() => ({}));
  const ak = body._ak || req.headers.get("x-admin-key") || "";
  if (ak !== ADMIN_KEY) return json({ ok: false, error: "Non autorisé" }, 403, headers);

  // Opérations CRUD sur tables admin (agents)
  const { op, table: crudTable, row, id: crudId } = body;
  if (op) {
    if (op === "insert" && crudTable === "agents" && row) {
      const { error } = await supabase.from("agents").insert({
        nom: row.nom, chat_id: row.chat_id, role: row.role || "paiement", actif: row.actif ?? true,
      });
      if (error) return json({ ok: false, error: error.message }, 500, headers);
      return json({ ok: true }, 200, headers);
    }
    if (op === "delete" && crudTable === "agents" && crudId) {
      const { error } = await supabase.from("agents").delete().eq("id", crudId);
      if (error) return json({ ok: false, error: error.message }, 500, headers);
      return json({ ok: true }, 200, headers);
    }
    return json({ ok: false, error: "Opération CRUD inconnue" }, 400, headers);
  }

  const { order_id, action, raison, new_user_id_1xbet } = body;
  if (!order_id || !action) return json({ ok: false, error: "order_id et action requis" }, 400, headers);
  if (!["confirmer", "rejeter", "retry"].includes(action)) {
    return json({ ok: false, error: "action doit être confirmer, rejeter ou retry" }, 400, headers);
  }

  const token = Deno.env.get("TELEGRAM_TOKEN")!;
  const adminId = Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")!;

  const [d, r] = await Promise.all([
    supabase.from("depot_orders").select("*").eq("order_id", order_id).limit(1),
    supabase.from("retrait_orders").select("*").eq("order_id", order_id).limit(1),
  ]);

  const isDepot = d.data && d.data.length > 0;
  const ordre = isDepot ? d.data![0] : (r.data && r.data.length > 0 ? r.data![0] : null);
  const table = isDepot ? "depot_orders" : "retrait_orders";

  if (!ordre) return json({ ok: false, error: `Ordre #${order_id} introuvable` }, 404, headers);

  const montantVal = Number(ordre.montant || 0);
  const whatsapp = (ordre.whatsapp || "") as string;
  const vt = ordre.view_token ? `-${ordre.view_token}` : "";

  // ── CONFIRMER ──
  if (action === "confirmer") {
    if (isDepot) {
      // Dépôt : confirmer manuellement → appel MobCash direct
      const userId = new_user_id_1xbet
        ? String(new_user_id_1xbet).trim()
        : (ordre.user_id_1xbet || ordre.id1x || "");

      await supabase.from(table).update({
        status: "Paiement Reçu",
        confirmed_by: "admin_web_manuel",
        confirmed_at: new Date().toISOString(),
        ...(new_user_id_1xbet ? { user_id_1xbet: userId } : {}),
      }).eq("id", ordre.id);

      if (whatsapp) {
        sendWhatsApp(whatsapp,
          `💳 *Baki-Pay — Paiement reçu* ✅\n\n` +
          `Votre paiement *#${order_id}* de *${montantVal.toLocaleString()} DJF* a bien été reçu.\n\n` +
          `⏳ Crédit de votre compte 1xBet en cours...\n` +
          `📲 baki-pay.com/#suivi-${order_id}${vt}`
        ).catch(() => {});
      }

      if (!userId) {
        await sendTelegram(token, adminId,
          `⚠️ <b>ID 1xBet manquant — #${order_id}</b>\nConfirmé manuellement mais crédit impossible sans ID.`);
        logAudit("admin_confirme_web_sans_id", { order_id });
        return json({ ok: true, status: "Paiement Reçu", warning: "ID 1xBet manquant" }, 200, headers);
      }

      try {
        await callMobcash("Dépôt", userId, montantVal, "");
        await supabase.from(table).update({
          status: "Crédité avec succès",
          webhook_status: "ok",
          webhook_at: new Date().toISOString(),
        }).eq("id", ordre.id);

        const msg = `✅ <b>Dépôt crédité (admin)</b>\n#${order_id} | ${montantVal.toLocaleString()} DJF\nID 1xBet: <code>${userId}</code>`;
        await Promise.allSettled([sendTelegram(token, adminId, msg), notifyPaiementAgents(token, msg)]);

        if (whatsapp) {
          sendWhatsApp(whatsapp,
            `🎉 *Baki-Pay — Compte 1xBet crédité !*\n\n` +
            `Votre dépôt *#${order_id}* de *${montantVal.toLocaleString()} DJF* a été traité avec succès.\n\n` +
            `✅ *Crédité avec succès*\n\nVotre compte 1xBet est rechargé. Bonne chance ! 🎮`
          ).catch(() => {});
        }
        logAudit("admin_confirme_depot_credite", { order_id, userId });
        return json({ ok: true, status: "Crédité avec succès" }, 200, headers);
      } catch (e: unknown) {
        const errMsg = (e as Error).message || "";
        const estPermanente = ERREURS_PERMANENTES.some((s) => errMsg.toLowerCase().includes(s));
        await supabase.from(table).update({
          webhook_status: estPermanente ? "echec_permanent" : "echec",
          webhook_err: errMsg,
        }).eq("id", ordre.id);
        await sendTelegram(token, adminId,
          `⚠️ <b>MobCash échoué (admin) — #${order_id}</b>\n<code>${errMsg}</code>`);
        logAudit("admin_confirme_mobcash_echec", { order_id, errMsg });
        return json({ ok: false, error: errMsg, permanent: estPermanente }, 400, headers);
      }
    } else {
      // Retrait : confirmer → Code Validé
      await supabase.from(table).update({
        status: "Code Validé",
        confirmed_by: "admin_web_manuel",
        confirmed_at: new Date().toISOString(),
      }).eq("id", ordre.id);
      const msg = `✅ Retrait #${order_id} confirmé manuellement → Code Validé\n${montantVal.toLocaleString()} DJF`;
      await Promise.allSettled([sendTelegram(token, adminId, msg), notifyPaiementAgents(token, msg)]);
      logAudit("admin_confirme_retrait_web", { order_id });
      return json({ ok: true, status: "Code Validé" }, 200, headers);
    }
  }

  // ── REJETER ──
  if (action === "rejeter") {
    const raisonText = raison || "Rejeté manuellement";
    const rejetStatus = isDepot ? "Paiement Non Reçu" : "Code Invalide";
    await supabase.from(table).update({
      status: rejetStatus,
      flag_raison: raisonText,
      rejected_by: "admin_web_manuel",
      flagged_at: new Date().toISOString(),
    }).eq("id", ordre.id);

    const msg = `❌ Ordre #${order_id} rejeté manuellement\nMontant : ${montantVal.toLocaleString()} DJF\nRaison : ${raisonText}`;
    await Promise.allSettled([sendTelegram(token, adminId, msg), notifyPaiementAgents(token, msg)]);

    if (whatsapp) {
      sendWhatsApp(whatsapp,
        `❌ *Baki-Pay — Paiement non reçu*\n\n` +
        `Votre ordre *#${order_id}* n'a pas pu être traité.\n` +
        `Raison : ${raisonText}\n\n` +
        `Soumettez un nouvel ordre sur baki-pay.com\n` +
        `📲 baki-pay.com/#suivi-${order_id}${vt}`
      ).catch(() => {});
    }
    logAudit("admin_rejete_web", { order_id, raison: raisonText });
    return json({ ok: true, status: rejetStatus }, 200, headers);
  }

  // ── RETRY (MobCash sur ordre déjà "Paiement Reçu") ──
  if (action === "retry") {
    if (!isDepot) return json({ ok: false, error: "retry uniquement pour les dépôts" }, 400, headers);
    if (ordre.status !== "Paiement Reçu") {
      return json({ ok: false, error: `Statut actuel '${ordre.status}' — retry uniquement sur 'Paiement Reçu'` }, 400, headers);
    }
    const userId = new_user_id_1xbet
      ? String(new_user_id_1xbet).trim()
      : (ordre.user_id_1xbet || ordre.id1x || "");
    if (!userId) return json({ ok: false, error: "ID 1xBet manquant" }, 400, headers);

    try {
      await callMobcash("Dépôt", userId, montantVal, "");
      const updates: Record<string, unknown> = {
        status: "Crédité avec succès",
        webhook_status: "ok",
        webhook_at: new Date().toISOString(),
        recovery_by: "admin_retry",
      };
      if (new_user_id_1xbet) updates.user_id_1xbet = userId;
      await supabase.from(table).update(updates).eq("id", ordre.id);

      await sendTelegram(token, adminId,
        `✅ <b>Retry Admin — Dépôt crédité</b>\n#${order_id} | <code>${userId}</code>\n${montantVal.toLocaleString()} DJF`);

      if (whatsapp) {
        sendWhatsApp(whatsapp,
          `🎉 *Baki-Pay — Compte 1xBet crédité !*\n\n` +
          `Votre dépôt *#${order_id}* de *${montantVal.toLocaleString()} DJF* a été traité avec succès.\n\n` +
          `✅ *Crédité avec succès*`
        ).catch(() => {});
      }
      logAudit("depot_admin_retry_ok", { order_id, userId });
      return json({ ok: true, message: `Ordre #${order_id} crédité avec succès` }, 200, headers);
    } catch (e: unknown) {
      const errMsg = (e as Error).message || "";
      const estPermanente = ERREURS_PERMANENTES.some((s) => errMsg.toLowerCase().includes(s));
      await supabase.from(table).update({
        webhook_status: estPermanente ? "echec_permanent" : "echec",
        webhook_at: new Date().toISOString(),
        ...(new_user_id_1xbet ? { user_id_1xbet: userId } : {}),
      }).eq("id", ordre.id);
      return json({ ok: false, error: errMsg, permanent: estPermanente }, 400, headers);
    }
  }

  return json({ ok: false, error: "Action inconnue" }, 400, headers);
});
