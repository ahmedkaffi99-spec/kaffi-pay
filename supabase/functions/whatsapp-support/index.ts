import { supabase } from "../_shared/db.ts";
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import { json, cors, logAudit } from "../_shared/utils.ts";

// Reçoit les webhooks entrants Green API (typeWebhook: "incomingMessageReceived")
// et répond automatiquement — FAQ + suivi de statut d'ordre. Pas d'escalade
// vers un agent humain ici (contrairement au bot support Telegram) : le client
// qui veut un agent est déjà redirigé vers Telegram (voir menu de bienvenue).
Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ ok: true }, 200, headers);

  const body = await req.json().catch(() => ({}));

  try {
    if (body.typeWebhook !== "incomingMessageReceived") {
      return json({ ok: true }, 200, headers);
    }

    const chatId = body.senderData?.chatId || "";
    const senderName = body.senderData?.senderName || body.senderData?.chatName || "Client";
    if (!chatId || !chatId.endsWith("@c.us")) return json({ ok: true }, 200, headers);

    const phone = chatId.replace("@c.us", "");
    const text = (
      body.messageData?.textMessageData?.textMessage ||
      body.messageData?.extendedTextMessageData?.text ||
      ""
    ).trim();
    if (!text) return json({ ok: true }, 200, headers);

    const t = text.toLowerCase().trim();
    logAudit("whatsapp_support_message", { phone, text: text.substring(0, 200) });

    // Numéro d'ordre (5-8 chiffres, avec ou sans "suivi"/"#")
    const suiviMatch = text.match(/(?:suivi\s+)?#?(\d{5,8})\b/i);

    if (suiviMatch) {
      const ordreId = suiviMatch[1];
      const [d, r] = await Promise.all([
        supabase.from("depot_orders").select("order_id,status,montant,flag_raison,webhook_status").eq("order_id", ordreId).limit(1),
        supabase.from("retrait_orders").select("order_id,status,montant,flag_raison").eq("order_id", ordreId).limit(1),
      ]);
      const ordre = (d.data && d.data[0]) || (r.data && r.data[0]);
      const type = d.data && d.data[0] ? "Dépôt" : "Retrait";

      if (!ordre) {
        await sendWhatsApp(phone, `❓ Ordre *#${ordreId}* introuvable.\nVérifiez le numéro et réessayez.`);
        return json({ ok: true }, 200, headers);
      }

      const wbFail = type === "Dépôt" &&
        ["echec_permanent", "echec_max", "echec"].includes((ordre as { webhook_status?: string }).webhook_status || "");

      const statusEmoji: Record<string, string> = {
        "En attente": "⏳", "Paiement Reçu": "💳", "Crédité avec succès": "✅",
        "Paiement Non Reçu": "❌", "Code Validé": "✅", "Code Invalide": "❌",
        "Payé": "✅", "Annulé": "🚫",
      };
      const emoji = (ordre.status === "Paiement Reçu" && wbFail) ? "🚨" : (statusEmoji[ordre.status] || "📋");

      let msg = `${emoji} *Ordre #${ordreId} — ${type}*\n\n`;
      msg += `Statut : *${ordre.status}*\n`;
      msg += `Montant : *${Number(ordre.montant || 0).toLocaleString()} DJF*\n`;
      if (ordre.flag_raison) msg += `\n⚠️ _${ordre.flag_raison}_\n`;

      if (ordre.status === "En attente") {
        msg += `\n⏳ Votre paiement est en cours de vérification.`;
      } else if (ordre.status === "Paiement Reçu" && type === "Dépôt" && wbFail) {
        msg += `\n🚨 Le crédit de votre compte 1xBet a échoué. Contactez le support sur Telegram : @BakiPaySupportBot`;
      } else if (ordre.status === "Paiement Reçu") {
        msg += `\n💳 Paiement reçu — crédit 1xBet en cours...`;
      } else if (ordre.status === "Crédité avec succès") {
        msg += `\n✅ Votre compte 1xBet a été crédité avec succès !`;
      } else if (ordre.status === "Paiement Non Reçu") {
        msg += `\n❌ Paiement non reçu. Vérifiez votre Transfer ID Waafi.`;
      } else if (ordre.status === "Code Validé") {
        msg += `\n⏳ Code validé — envoi Waafi en cours...`;
      } else if (ordre.status === "Payé") {
        msg += `\n✅ Retrait effectué — fonds transférés sur votre Waafi !`;
      } else if (ordre.status === "Code Invalide") {
        msg += `\n❌ Code invalide. Vérifiez votre code de retrait 1xBet.`;
      } else if (ordre.status === "Annulé") {
        msg += `\n🚫 Ordre annulé.`;
      }

      await sendWhatsApp(phone, msg);
      return json({ ok: true }, 200, headers);
    }

    if (t === "aide" || t === "/aide" || t.includes("comment")) {
      await sendWhatsApp(phone,
        `📖 *Comment utiliser Baki-Pay*\n\n` +
        `🟢 *Dépôt (recharger 1xBet) :*\n` +
        `1. Allez sur baki-pay.com\n` +
        `2. Entrez votre ID 1xBet, montant, Transfer ID Waafi\n` +
        `3. Cliquez "Soumettre"\n` +
        `4. Votre compte est crédité automatiquement\n\n` +
        `🔴 *Retrait (retirer de 1xBet) :*\n` +
        `1. Sur 1xBet, générez un code de retrait\n` +
        `2. Sur baki-pay.com, entrez le code + votre N° Waafi\n` +
        `3. Vous recevrez le montant sur votre Waafi\n\n` +
        `⏱ Délais : 5 à 15 minutes en général.`
      );
      return json({ ok: true }, 200, headers);
    }

    if (t === "tarifs" || t === "/tarifs" || t.includes("tarif") || t.includes("prix")) {
      await sendWhatsApp(phone,
        `💰 *Tarifs Baki-Pay*\n\n` +
        `Dépôt : *Gratuit*\n` +
        `Retrait : *Gratuit*\n\n` +
        `*Limites :*\n` +
        `• Minimum dépôt : 500 DJF\n` +
        `• Maximum dépôt : 200 000 DJF\n\n` +
        `Tous les transferts sont en DJF.`
      );
      return json({ ok: true }, 200, headers);
    }

    // Salutation / message non reconnu → menu
    await sendWhatsApp(phone,
      `👋 *Bienvenue sur Baki-Pay Support*${senderName ? `, ${senderName}` : ""}\n\n` +
      `Je suis votre assistant automatique pour les dépôts et retraits 1xBet via Waafi.\n\n` +
      `Écrivez :\n` +
      `• Votre *numéro d'ordre* (ex: 082626) — pour suivre son statut\n` +
      `• *aide* — comment faire un dépôt ou retrait\n` +
      `• *tarifs* — tarifs et limites\n\n` +
      `Pour parler à un agent humain, contactez-nous sur Telegram : @BakiPaySupportBot`
    );
  } catch (e) {
    console.error("whatsapp-support crash:", (e as Error).message);
  }

  return json({ ok: true }, 200, headers);
});
