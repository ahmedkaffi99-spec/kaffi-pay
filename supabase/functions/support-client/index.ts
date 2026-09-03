import { supabase } from "../_shared/db.ts";
import { sendTelegram, sendTelegramKeyboard, answerCallback, notifySupportAgents, notifyPaiementAgents } from "../_shared/telegram.ts";
import { json, cors, logAudit } from "../_shared/utils.ts";

const SUPPORT_BOT_TOKEN_KEY = "SUPPORT_BOT_TOKEN";

async function sendSupport(chatId: string, text: string) {
  const token = Deno.env.get(SUPPORT_BOT_TOKEN_KEY)!;
  return sendTelegram(token, chatId, text);
}

async function sendSupportKb(chatId: string, text: string, keyboard: { text: string; callback_data?: string }[][]) {
  const token = Deno.env.get(SUPPORT_BOT_TOKEN_KEY)!;
  return sendTelegramKeyboard(token, chatId, text, keyboard);
}

type SupportSession = {
  id: string;
  order_id: string | null;
  client_chat_id: string;
  client_name: string | null;
  montant: number;
  id_1xbet: string;
  tid: string;
  webhook_status: string;
  webhook_err: string;
  role: "support" | "paiement";
  agent_chat_id: string | null;
  agent_name: string | null;
  status: "pending" | "open" | "closed";
  opened_at: string;
};

async function findSession(id: string): Promise<SupportSession | null> {
  const { data } = await supabase.from("support_sessions").select("*").eq("id", id).limit(1);
  return (data && data[0]) || null;
}

async function closeSession(session: SupportSession, closedByAgent: boolean) {
  await supabase.from("support_sessions").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", session.id);
  const supportToken = Deno.env.get(SUPPORT_BOT_TOKEN_KEY)!;
  if (session.agent_chat_id) {
    await sendTelegram(supportToken, session.agent_chat_id, `✅ Session${session.order_id ? ` #${session.order_id}` : ""} fermée.`).catch(() => {});
  }
  await sendTelegram(supportToken, session.client_chat_id,
    `✅ <b>Conversation terminée</b>\n\nMerci d'avoir contacté Baki-Pay Support.${closedByAgent ? "" : " Si vous avez d'autres questions, tapez /agent."}`
  ).catch(() => {});
  logAudit("support_session_fermee", { sessionId: session.id, closedByAgent });
}

Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405, headers);

  const body = await req.json().catch(() => ({}));
  const supportToken = Deno.env.get(SUPPORT_BOT_TOKEN_KEY)!;

  try {
    // ── Callback query (bouton inline "Prendre en charge" / "Fermer") ──
    if (body.callback_query) {
      const cb = body.callback_query;
      const cbId = cb.id;
      const cbData = cb.data || "";
      const fromId = String(cb.from.id);
      const fromName = cb.from.first_name || cb.from.username || "Agent";

      if (cbData.startsWith("agent_take_")) {
        const sessionId = cbData.replace("agent_take_", "");
        const session = await findSession(sessionId);
        if (!session || session.status !== "pending") {
          await answerCallback(supportToken, cbId, "⚠️ Session déjà prise en charge ou introuvable.");
          return json({ ok: true }, 200, headers);
        }
        await answerCallback(supportToken, cbId, "✅ Session ouverte");
        await supabase.from("support_sessions").update({
          agent_chat_id: fromId, agent_name: fromName, status: "open", taken_at: new Date().toISOString(),
        }).eq("id", sessionId);

        const details =
          (session.order_id ? `📄 Ordre : <b>#${session.order_id}</b>\n` : "") +
          (session.montant ? `💰 Montant : ${Number(session.montant).toLocaleString()} DJF\n` : "") +
          (session.id_1xbet ? `🔑 ID 1xBet : <code>${session.id_1xbet}</code>\n` : "") +
          (session.webhook_err ? `⚠️ Erreur : <code>${session.webhook_err}</code>\n` : "");

        await sendSupportKb(fromId,
          `✅ <b>Session ouverte</b>${session.order_id ? ` — #${session.order_id}` : ""}\n\n` +
          `👤 Client : <b>${session.client_name || "?"}</b>\n` + details + `\n` +
          `Écrivez directement ici — vos messages seront transmis au client.\nPour clôturer, tapez <b>fermer</b>.`,
          [[{ text: "🔒 Fermer la session", callback_data: `agent_close_${sessionId}` }]]
        );
        await sendSupport(session.client_chat_id,
          `👤 <b>Agent ${fromName} disponible</b>\n\nVotre dossier est pris en charge. Écrivez ici directement.`
        ).catch(() => {});
        logAudit("support_session_prise_en_charge", { sessionId, agentId: fromId });
        return json({ ok: true }, 200, headers);
      }

      if (cbData.startsWith("agent_close_")) {
        const sessionId = cbData.replace("agent_close_", "");
        const session = await findSession(sessionId);
        if (!session) {
          await answerCallback(supportToken, cbId, "❓ Session introuvable.");
          return json({ ok: true }, 200, headers);
        }
        await answerCallback(supportToken, cbId, "✅ Session fermée");
        await closeSession(session, true);
        return json({ ok: true }, 200, headers);
      }

      await answerCallback(supportToken, cbId, "");
      return json({ ok: true }, 200, headers);
    }

    const msg = body.message || body.edited_message;
    if (!msg) return json({ ok: true }, 200, headers);

    const chatId = String(msg.chat.id);
    const senderName = msg.from?.first_name || msg.chat?.first_name || "Client";
    const text = (msg.text || "").trim();
    const t = text.toLowerCase().trim();

    if (!text) return json({ ok: true }, 200, headers);

    // ── RELAI SESSION AGENT <-> CLIENT ──
    // Priorité absolue sur tout le reste : un agent ou un client avec une
    // session active écrit ici pour discuter, pas pour déclencher /suivi ou
    // /aide. Portage de l'ancien relais Firestore (functions/index.js),
    // jamais recréé lors de la migration vers Supabase — /agent ne faisait
    // plus qu'envoyer une notif ponctuelle, sans aucun moyen pour l'agent de
    // répondre au client ensuite.
    const { data: agentSessions } = await supabase.from("support_sessions")
      .select("*").eq("agent_chat_id", chatId).eq("status", "open").limit(1);
    if (agentSessions && agentSessions.length > 0) {
      const session = agentSessions[0] as SupportSession;
      if (["fermer", "/fermer", "close", "/close"].includes(t)) {
        await closeSession(session, true);
      } else {
        await sendSupport(session.client_chat_id, `💬 <b>Agent ${session.agent_name || "support"} :</b>\n\n${text}`).catch(() => {});
        await sendSupport(chatId, `✅ Envoyé à ${session.client_name || "client"}.`);
      }
      return json({ ok: true }, 200, headers);
    }

    const { data: clientSessions } = await supabase.from("support_sessions")
      .select("*").eq("client_chat_id", chatId).in("status", ["open", "pending"]).limit(1);
    if (clientSessions && clientSessions.length > 0) {
      const session = clientSessions[0] as SupportSession;
      // Une session "pending" jamais prise en charge ne doit pas bloquer le
      // client indéfiniment (aucun autre statut ne le libère sinon) — expire
      // après 1h et laisse retomber sur le traitement normal des commandes.
      const pendingExpired = session.status === "pending" &&
        Date.now() - new Date(session.opened_at).getTime() > 60 * 60 * 1000;
      if (pendingExpired) {
        await supabase.from("support_sessions").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", session.id);
      } else if (session.status === "pending") {
        await sendSupport(chatId, `⏳ Votre demande est toujours en attente — un agent va bientôt vous répondre.`);
        return json({ ok: true }, 200, headers);
      } else if (session.agent_chat_id) {
        await sendSupport(session.agent_chat_id, `💬 <b>${session.client_name || senderName} :</b>\n\n${text}`).catch(() => {});
        await sendSupport(chatId, `✅ Message transmis à votre agent.`);
        return json({ ok: true }, 200, headers);
      }
    }

    // /start
    if (t === "/start" || t === "start") {
      await sendSupport(chatId,
        `👋 <b>Bienvenue sur Baki-Pay Support</b>\n\n` +
        `Je suis votre assistant pour les dépôts et retraits 1xBet via Waafi.\n\n` +
        `<b>Commandes disponibles :</b>\n` +
        `/suivi — Suivre un ordre\n` +
        `/aide — Comment faire un dépôt ou retrait\n` +
        `/agent — Contacter un agent humain\n` +
        `/tarifs — Tarifs et informations\n\n` +
        `Ou tapez votre numéro d'ordre directement.`
      );
      return json({ ok: true }, 200, headers);
    }

    // /aide
    if (t === "/aide" || t === "aide") {
      await sendSupport(chatId,
        `📖 <b>Comment utiliser Baki-Pay</b>\n\n` +
        `<b>🟢 Dépôt (recharger 1xBet) :</b>\n` +
        `1. Allez sur baki-pay.com\n` +
        `2. Entrez votre ID 1xBet, montant, Transfer ID Waafi\n` +
        `3. Cliquez "Soumettre"\n` +
        `4. Votre compte est crédité automatiquement\n\n` +
        `<b>🔴 Retrait (retirer de 1xBet) :</b>\n` +
        `1. Sur 1xBet, générez un code de retrait\n` +
        `2. Sur baki-pay.com, entrez le code + votre N° Waafi\n` +
        `3. Vous recevrez le montant sur votre Waafi\n\n` +
        `<b>⏱ Délais :</b> 5 à 15 minutes en général.`
      );
      return json({ ok: true }, 200, headers);
    }

    // /tarifs
    if (t === "/tarifs" || t === "tarifs") {
      await sendSupport(chatId,
        `💰 <b>Tarifs Baki-Pay</b>\n\n` +
        `Dépôt : <b>Gratuit</b>\n` +
        `Retrait : <b>Gratuit</b>\n\n` +
        `<b>Limites :</b>\n` +
        `• Minimum dépôt : 500 DJF\n` +
        `• Maximum dépôt : 200 000 DJF\n\n` +
        `Tous les transferts sont en DJF (Franc Djiboutien).`
      );
      return json({ ok: true }, 200, headers);
    }

    // /agent [message avec éventuellement un numéro d'ordre]
    if (t === "/agent" || t === "agent" || t.startsWith("/agent ") || t.startsWith("agent ")) {
      // Si un numéro d'ordre est fourni et correspond à un dépôt en échec
      // MobCash (echec_permanent/echec_max/echec), la session est routée vers
      // les agents "paiement" avec les infos de l'ordre déjà pré-remplies —
      // même logique que l'ancienne "Intervention équipe paiement". Sinon,
      // demande générale routée vers les agents "support".
      const ordreMatch = text.match(/(?:#\s*)?(\d{5,8})\b/);
      let sessionId = "s_" + chatId;
      let role: "support" | "paiement" = "support";
      let orderId: string | null = null;
      let montant = 0, id1xbet = "", tid = "", webhookStatus = "", webhookErr = "";

      if (ordreMatch) {
        const { data: depotRows } = await supabase.from("depot_orders")
          .select("order_id,status,montant,user_id_1xbet,id1x,waafi_transfert_id,hash,webhook_status,webhook_err")
          .eq("order_id", ordreMatch[1]).limit(1);
        const depot = depotRows && depotRows[0];
        if (depot && depot.status === "Paiement Reçu" &&
            ["echec_permanent", "echec_max", "echec"].includes(depot.webhook_status || "")) {
          role = "paiement";
          orderId = depot.order_id;
          sessionId = depot.order_id;
          montant = Number(depot.montant || 0);
          id1xbet = depot.user_id_1xbet || depot.id1x || "";
          tid = depot.waafi_transfert_id || depot.hash || "";
          webhookStatus = depot.webhook_status || "";
          webhookErr = depot.webhook_err || "";
        } else if (depot) {
          orderId = depot.order_id;
          montant = Number(depot.montant || 0);
        }
      }

      await supabase.from("support_sessions").upsert({
        id: sessionId, order_id: orderId, client_chat_id: chatId, client_name: senderName,
        montant, id_1xbet: id1xbet, tid, webhook_status: webhookStatus, webhook_err: webhookErr,
        role, agent_chat_id: null, agent_name: null, status: "pending",
        opened_at: new Date().toISOString(), taken_at: null, closed_at: null,
      }, { onConflict: "id" });

      const alertMsg = role === "paiement"
        ? `💳 <b>Intervention équipe paiement — Crédit échoué</b>\n👤 ${senderName} | Ordre <b>#${orderId}</b>\n` +
          `ID 1xBet : <code>${id1xbet || "?"}</code> | ${montant.toLocaleString()} DJF\n<code>${webhookErr || webhookStatus}</code>`
        : `🆘 <b>Demande d'agent humain</b>\n👤 ${senderName}${orderId ? ` | Ordre #${orderId}` : ""}\nMessage : ${text}`;
      const takeKb: { text: string; callback_data: string }[][] = [[{ text: "📞 Prendre en charge", callback_data: `agent_take_${sessionId}` }]];

      if (role === "paiement") {
        await notifyPaiementAgents(supportToken, alertMsg, takeKb).catch(() => {});
      } else {
        await notifySupportAgents(supportToken, alertMsg, takeKb).catch(() => {});
      }
      logAudit("support_demande_agent", { chatId, sessionId, role, orderId });

      await sendSupport(chatId,
        `👤 <b>Un agent va vous répondre</b>\n\n` +
        `Votre demande a été transmise à notre équipe${role === "paiement" ? " de paiement" : ""}.\n` +
        `💬 Écrivez ici vos informations en attendant — vous serez prévenu dès qu'un agent prend en charge.\n\n` +
        `Heures d'ouverture : 8h-22h (heure locale)`
      );
      return json({ ok: true }, 200, headers);
    }

    // /suivi ou numéro d'ordre
    const suiviMatch = text.match(/^(?:\/suivi\s+)?#?(\d{5,8})\b/i);
    if (suiviMatch || t === "/suivi") {
      if (!suiviMatch) {
        await sendSupport(chatId, `📲 Entrez votre numéro d'ordre :\nEx : <code>/suivi 082626</code>`);
        return json({ ok: true }, 200, headers);
      }

      const ordreId = suiviMatch[1];
      const [d, r] = await Promise.all([
        supabase.from("depot_orders").select("order_id,status,montant,flag_raison,created_at,webhook_status").eq("order_id", ordreId).limit(1),
        supabase.from("retrait_orders").select("order_id,status,montant,flag_raison,created_at").eq("order_id", ordreId).limit(1),
      ]);

      const ordre = (d.data && d.data[0]) || (r.data && r.data[0]);
      const type = d.data && d.data[0] ? "Dépôt" : "Retrait";

      if (!ordre) {
        await sendSupport(chatId, `❓ Ordre <b>#${ordreId}</b> introuvable.\nVérifiez le numéro et réessayez.`);
        return json({ ok: true }, 200, headers);
      }

      // echec_solde n'est jamais un problème du client (cashdesk à sec, admin
      // recharge puis relance) — le statut reste affiché comme "en cours",
      // exactement comme sur baki-pay.com (voir wbFail dans public/index.html,
      // qui exclut aussi echec_solde). Seuls echec_permanent/echec_max/echec
      // signalent un vrai blocage nécessitant une action du client.
      const wbFail = type === "Dépôt" &&
        ["echec_permanent", "echec_max", "echec"].includes((ordre as { webhook_status?: string }).webhook_status || "");

      const statusEmoji: Record<string, string> = {
        "En attente": "⏳",
        "Paiement Reçu": "💳",
        "Crédité avec succès": "✅",
        "Paiement Non Reçu": "❌",
        "Code Validé": "✅",
        "Code Invalide": "❌",
        "Payé": "✅",
        "Annulé": "🚫",
      };
      const emoji = (ordre.status === "Paiement Reçu" && wbFail) ? "🚨" : (statusEmoji[ordre.status] || "📋");

      let msg2 = `${emoji} <b>Ordre #${ordreId} — ${type}</b>\n\n`;
      msg2 += `Statut : <b>${ordre.status}</b>\n`;
      msg2 += `Montant : <b>${Number(ordre.montant || 0).toLocaleString()} DJF</b>\n`;
      if (ordre.flag_raison) msg2 += `\n⚠️ <i>${ordre.flag_raison}</i>\n`;

      if (ordre.status === "En attente") {
        msg2 += `\n⏳ Votre paiement est en cours de vérification.`;
      } else if (ordre.status === "Paiement Reçu" && type === "Dépôt" && wbFail) {
        const wStatus = (ordre as { webhook_status?: string }).webhook_status;
        msg2 += wStatus === "echec_permanent"
          ? `\n🚨 Crédit échoué — votre compte 1xBet semble être en devise étrangère (USD/EUR).\nTapez <code>/agent ${ordreId}</code> avec l'ID de votre compte 1xBet en DJF pour parler à un agent.`
          : `\n🚨 Le crédit de votre compte 1xBet a échoué.\nTapez <code>/agent ${ordreId}</code> pour parler à un agent.`;
      } else if (ordre.status === "Paiement Reçu") {
        msg2 += `\n💳 Paiement reçu — crédit 1xBet en cours...`;
      } else if (ordre.status === "Crédité avec succès") {
        msg2 += `\n✅ Votre compte 1xBet a été crédité avec succès !`;
      } else if (ordre.status === "Paiement Non Reçu") {
        msg2 += `\n❌ Paiement non reçu. Vérifiez votre Transfer ID Waafi.\nPour toute question, tapez /agent.`;
      } else if (ordre.status === "Code Validé") {
        msg2 += `\n⏳ Code validé — envoi Waafi en cours...`;
      } else if (ordre.status === "Payé") {
        msg2 += `\n✅ Retrait effectué — fonds transférés sur votre Waafi !`;
      } else if (ordre.status === "Code Invalide") {
        msg2 += `\n❌ Code invalide. Vérifiez votre code de retrait 1xBet.\nPour toute question, tapez /agent.`;
      } else if (ordre.status === "Annulé") {
        msg2 += `\n🚫 Ordre annulé.`;
      }

      await sendSupport(chatId, msg2);
      return json({ ok: true }, 200, headers);
    }

    // Message non reconnu
    await sendSupport(chatId,
      `Je n'ai pas compris votre message. Utilisez :\n` +
      `/suivi #NUMERO — Suivre un ordre\n` +
      `/aide — Comment utiliser Baki-Pay\n` +
      `/agent — Contacter le support humain`
    );

  } catch (e) {
    console.error("support-client crash:", (e as Error).message);
  }

  return json({ ok: true }, 200, headers);
});
