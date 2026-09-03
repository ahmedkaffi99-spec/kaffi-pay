import { supabase } from "../_shared/db.ts";
import { sendTelegram, notifyPaiementAgents } from "../_shared/telegram.ts";
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import { callMobcash, callMobcashDepot } from "../_shared/mobcash.ts";
import { json, cors, logAudit, webhookStatusPourErreurMobcash, transitionValide } from "../_shared/utils.ts";

const ADMIN_KEY = "kp2026_9f3aXmQ7";

Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "POST requis" }, 405, headers);

  const body = await req.json().catch(() => ({}));
  const ak = body._ak || req.headers.get("x-admin-key") || "";
  if (ak !== ADMIN_KEY) return json({ ok: false, error: "Non autorisé" }, 403, headers);

  // Opérations CRUD sur tables admin (agents)
  const { op, table: crudTable, row, id: crudId } = body;
  if (op) {
    // Lecture des tables réservées à service_role par RLS — le frontend ne peut
    // pas les lire directement, il passe donc par ici (protégé par la clé admin).
    if (op === "list" && crudTable === "agents") {
      const { data, error } = await supabase.from("agents")
        .select("id,nom,chat_id,role,actif").order("nom");
      if (error) return json({ ok: false, error: error.message }, 500, headers);
      return json({ ok: true, rows: data || [] }, 200, headers);
    }
    if (op === "list" && crudTable === "waafi_notifications") {
      const { data, error } = await supabase.from("waafi_notifications")
        .select("*").order("created_at", { ascending: false }).limit(50);
      if (error) return json({ ok: false, error: error.message }, 500, headers);
      return json({ ok: true, rows: data || [] }, 200, headers);
    }
    if (op === "get_reserves") {
      const { data, error } = await supabase.from("reserves")
        .select("platform,montant,dep_offset,ret_offset,updated_at").not("platform", "is", null);
      if (error) return json({ ok: false, error: error.message }, 500, headers);
      return json({ ok: true, rows: data || [] }, 200, headers);
    }
    if (op === "save_reserve") {
      const { platform, montant, dep_offset, ret_offset } = body;
      if (!["1xbet", "waafi"].includes(platform) || typeof montant !== "number" || montant < 0) {
        return json({ ok: false, error: "platform ('1xbet'|'waafi') et montant requis" }, 400, headers);
      }
      const { error } = await supabase.from("reserves").upsert({
        platform,
        montant,
        dep_offset: Number(dep_offset) || 0,
        ret_offset: Number(ret_offset) || 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: "platform" });
      if (error) return json({ ok: false, error: error.message }, 500, headers);
      return json({ ok: true }, 200, headers);
    }
    // Panel "Paiement Manuel" — traiter un dépôt/retrait MobCash hors flux
    // normal (ex: correction, cas non couvert par un ordre existant). Le
    // frontend envoyait auparavant {type,userId,montant,code} sans op ni
    // action, ce que cette fonction n'a jamais su traiter — 400 à chaque
    // appel, l'outil n'a jamais fonctionné.
    if (op === "manual_mobcash") {
      const userIdStr = String(body.userId || "").trim();
      const montantNum = Number(body.montant) || 0;
      if (!userIdStr || montantNum <= 0) {
        return json({ ok: false, error: "userId et montant requis" }, 400, headers);
      }
      try {
        const data = body.type === "retrait"
          ? await callMobcash("Retrait", userIdStr, montantNum, String(body.code || "").trim())
          : await callMobcashDepot(userIdStr, montantNum);
        logAudit("mobcash_manuel", { type: body.type || "depot", userId: userIdStr, montant: montantNum });
        return json({ ok: true, data }, 200, headers);
      } catch (e: unknown) {
        return json({ ok: false, error: (e as Error).message || "Erreur MobCash" }, 400, headers);
      }
    }
    // "🗑️ Supprimer ordres bloqués >24h" — le frontend envoyait {heures:24} sans
    // op, ce que cette fonction n'a jamais su traiter (400 systématique).
    if (op === "purge_old_pending") {
      const heures = Number(body.heures) || 24;
      const cutoff = new Date(Date.now() - heures * 3600 * 1000).toISOString();
      const [d1, d2] = await Promise.all([
        supabase.from("depot_orders").delete().eq("status", "En attente").lt("created_at", cutoff).select("id"),
        supabase.from("retrait_orders").delete().eq("status", "En attente").lt("created_at", cutoff).select("id"),
      ]);
      if (d1.error) return json({ ok: false, error: d1.error.message }, 500, headers);
      if (d2.error) return json({ ok: false, error: d2.error.message }, 500, headers);
      const count = (d1.data?.length || 0) + (d2.data?.length || 0);
      logAudit("admin_purge_ordres_24h", { heures, count });
      return json({ ok: true, message: `${count} ordre(s) supprimé(s)` }, 200, headers);
    }
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
  if (!["confirmer", "rejeter", "retry", "finaliser"].includes(action)) {
    return json({ ok: false, error: "action doit être confirmer, rejeter, retry ou finaliser" }, 400, headers);
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
        await callMobcashDepot(userId, montantVal);
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
        const webhookStatus = webhookStatusPourErreurMobcash(errMsg);
        await supabase.from(table).update({
          webhook_status: webhookStatus,
          webhook_err: errMsg,
        }).eq("id", ordre.id);
        const msgSolde = webhookStatus === "echec_solde"
          ? `🏦 <b>Solde MobCash insuffisant (admin) — #${order_id}</b>\n<code>${errMsg}</code>\n<i>Rechargez le cashdesk puis relancez.</i>`
          : `⚠️ <b>MobCash échoué (admin) — #${order_id}</b>\n<code>${errMsg}</code>`;
        await sendTelegram(token, adminId, msgSolde);
        logAudit("admin_confirme_mobcash_echec", { order_id, errMsg, webhookStatus });
        return json({ ok: false, error: errMsg, webhook_status: webhookStatus }, 400, headers);
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

  // ── FINALISER (retrait payé en Waafi) ──
  // Le bouton "Terminer" du panel web appelait updateTxFirebase({status:'Payé'}),
  // qui ne mappe "Payé" vers aucune action connue et ne fait donc rien — le
  // retrait restait bloqué malgré le toast de succès affiché à l'admin. Miroir
  // exact du callback Telegram `terminer_` qui, lui, fonctionne déjà.
  if (action === "finaliser") {
    if (isDepot) return json({ ok: false, error: "finaliser uniquement pour les retraits" }, 400, headers);
    if (!transitionValide(ordre.status, "Payé")) {
      return json({ ok: false, error: `Statut actuel '${ordre.status}' — impossible de finaliser` }, 400, headers);
    }
    await supabase.from(table).update({
      status: "Payé",
      finalise_par: "admin_web_manuel",
      finalise_at: new Date().toISOString(),
    }).eq("id", ordre.id);
    await supabase.from("ordre_traite").insert({
      transfer_id: order_id, ordre_id: order_id, status: "finalise", credited_at: new Date().toISOString(),
    });
    const msg = `✅ Retrait #${order_id} finalisé (web) → Payé\n${montantVal.toLocaleString()} DJF`;
    await Promise.allSettled([sendTelegram(token, adminId, msg), notifyPaiementAgents(token, msg)]);
    logAudit("admin_finalise_retrait_web", { order_id });
    return json({ ok: true, status: "Payé" }, 200, headers);
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
      await callMobcashDepot(userId, montantVal);
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
      const webhookStatus = webhookStatusPourErreurMobcash(errMsg);
      await supabase.from(table).update({
        webhook_status: webhookStatus,
        webhook_err: errMsg,
        webhook_at: new Date().toISOString(),
        ...(new_user_id_1xbet ? { user_id_1xbet: userId } : {}),
      }).eq("id", ordre.id);
      return json({ ok: false, error: errMsg, webhook_status: webhookStatus }, 400, headers);
    }
  }

  return json({ ok: false, error: "Action inconnue" }, 400, headers);
});
