import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { supabase } from "../_shared/db.ts";
import { sendTelegram, notifySupportAgents } from "../_shared/telegram.ts";
import { json, cors } from "../_shared/utils.ts";

const SUPPORT_BOT_TOKEN_KEY = "SUPPORT_BOT_TOKEN";

async function sendSupport(chatId: string, text: string) {
  const token = Deno.env.get(SUPPORT_BOT_TOKEN_KEY)!;
  return sendTelegram(token, chatId, text);
}

serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405, headers);

  const body = await req.json().catch(() => ({}));
  const msg = body.message || body.edited_message;
  if (!msg) return json({ ok: true }, 200, headers);

  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  const t = text.toLowerCase().trim();

  if (!text) return json({ ok: true }, 200, headers);

  try {
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

    // /agent
    if (t === "/agent" || t === "agent") {
      const adminToken = Deno.env.get("TELEGRAM_TOKEN")!;
      await notifySupportAgents(adminToken,
        `🆘 <b>Demande d'agent humain</b>\n\nUtilisateur : <code>${chatId}</code>\nMessage : ${text}`
      ).catch(() => {});
      await sendSupport(chatId,
        `👤 <b>Un agent va vous contacter</b>\n\n` +
        `Votre demande a été transmise à notre équipe support.\n` +
        `Vous serez contacté dans les plus brefs délais.\n\n` +
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
        supabase.from("depot_orders").select("order_id,status,montant,flag_raison,created_at").eq("order_id", ordreId).limit(1),
        supabase.from("retrait_orders").select("order_id,status,montant,flag_raison,created_at").eq("order_id", ordreId).limit(1),
      ]);

      const ordre = (d.data && d.data[0]) || (r.data && r.data[0]);
      const type = d.data && d.data[0] ? "Dépôt" : "Retrait";

      if (!ordre) {
        await sendSupport(chatId, `❓ Ordre <b>#${ordreId}</b> introuvable.\nVérifiez le numéro et réessayez.`);
        return json({ ok: true }, 200, headers);
      }

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
      const emoji = statusEmoji[ordre.status] || "📋";

      let msg2 = `${emoji} <b>Ordre #${ordreId} — ${type}</b>\n\n`;
      msg2 += `Statut : <b>${ordre.status}</b>\n`;
      msg2 += `Montant : <b>${Number(ordre.montant || 0).toLocaleString()} DJF</b>\n`;
      if (ordre.flag_raison) msg2 += `\n⚠️ <i>${ordre.flag_raison}</i>\n`;

      if (ordre.status === "En attente") {
        msg2 += `\n⏳ Votre paiement est en cours de vérification.`;
      } else if (ordre.status === "Paiement Reçu") {
        msg2 += `\n💳 Paiement reçu — crédit 1xBet en cours...`;
      } else if (ordre.status === "Crédité avec succès") {
        msg2 += `\n✅ Votre compte 1xBet a été crédité avec succès !`;
      } else if (ordre.status === "Paiement Non Reçu") {
        msg2 += `\n❌ Paiement non reçu. Vérifiez votre Transfer ID Waafi.\nPour toute question, tapez /agent.`;
      } else if (ordre.status === "Payé") {
        msg2 += `\n✅ Retrait effectué — fonds transférés sur votre Waafi !`;
      } else if (ordre.status === "Code Invalide") {
        msg2 += `\n❌ Code invalide. Vérifiez votre code de retrait 1xBet.\nPour toute question, tapez /agent.`;
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
