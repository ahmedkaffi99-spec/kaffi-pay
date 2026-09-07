import { supabase } from "../_shared/db.ts";
import { sendWhatsAppToChatId } from "../_shared/whatsapp.ts";
import { json, cors, logAudit } from "../_shared/utils.ts";

// Modèles gratuits OpenRouter, en cascade — même liste et même ordre que dans le
// projet paris sportifs d'Ahmed (analyser_et_envoyer.py), déjà validée en usage réel.
const OPENROUTER_MODELS = ["openrouter/free", "cohere/north-mini-code:free", "poolside/laguna-xs-2.1:free"];

// sendWhatsAppToChatId() renvoie {ok, reason} sans jamais lever d'exception —
// un appel non vérifié laisse un échec Green API (session déconnectée, quota,
// numéro mal formé...) totalement invisible : le client ne reçoit rien et
// rien ne le signale nulle part.
//
// IMPORTANT : `phone` ici est TOUJOURS le numéro complet avec son vrai
// indicatif pays (extrait du chatId Green API réel — 253 pour Djibouti, mais
// aussi 251 Éthiopie, etc., n'importe qui peut écrire au numéro business).
// sendWhatsApp() (la fonction "normale", utilisée pour les clients du
// formulaire dépôt/retrait) suppose au contraire un numéro LOCAL djiboutien à
// 8 chiffres et lui colle 253 devant — ce qui cassait les réponses aux
// numéros étrangers (ex: 251726087929 → envoyé vers 253251726087929, chatId
// invalide). On reconstruit ici le chatId d'origine tel quel, sans y toucher.
async function envoyer(phone: string, message: string) {
  const res = await sendWhatsAppToChatId(`${phone}@c.us`, message);
  if (!res.ok) {
    console.error("whatsapp-support: envoi échoué vers", phone, "-", res.reason);
  }
  return res;
}

function menuBienvenue(senderName: string): string {
  return `👋 *Bienvenue sur Baki-Pay Support*${senderName ? `, ${senderName}` : ""}\n\n` +
    `Comment pouvons-nous vous aider pour votre dépôt ou retrait 1xBet via Waafi ?\n\n` +
    `Écrivez :\n` +
    `• Votre *numéro d'ordre* (ex: 082626) — pour suivre son statut\n` +
    `• *aide* — comment faire un dépôt ou retrait\n` +
    `• *tarifs* — tarifs et limites\n` +
    `• ou posez votre question directement, en langage naturel\n\n` +
    `Pour parler à un agent humain, contactez-nous sur Telegram : @BakiPaySupportBot`;
}

// Répond en langage naturel via Claude — pour tout ce que les commandes fixes
// (numéro d'ordre exact, "aide", "tarifs") ne couvrent pas, ex: "où en est
// mon dépôt d'hier ?". Ne reçoit que les ordres récents de CE numéro comme
// contexte : jamais de données d'autres clients, jamais d'invention.
async function repondreIA(phone: string, senderName: string, text: string): Promise<string> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return menuBienvenue(senderName);

  const localPhone = phone.replace(/^253/, "");
  const [d, r] = await Promise.all([
    supabase.from("depot_orders").select("order_id,status,montant,created_at")
      .or(`numero_payment.eq.${localPhone},whatsapp.eq.${localPhone}`)
      .order("created_at", { ascending: false }).limit(5),
    supabase.from("retrait_orders").select("order_id,status,montant,created_at")
      .or(`numero_waafi.eq.${localPhone},whatsapp.eq.${localPhone}`)
      .order("created_at", { ascending: false }).limit(5),
  ]);
  const orders = [
    ...(d.data || []).map((o) => ({ ...o, type: "Dépôt" })),
    ...(r.data || []).map((o) => ({ ...o, type: "Retrait" })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 5);

  const ordersContext = orders.length
    ? orders.map((o) => `#${o.order_id} — ${o.type} — ${Number(o.montant).toLocaleString()} DJF — ${o.status} — ${o.created_at}`).join("\n")
    : "Aucun ordre récent trouvé pour ce numéro.";

  const systemPrompt =
    "Tu es l'agent support officiel de Baki-Pay, service de dépôt/retrait 1xBet via Waafi à Djibouti. " +
    "Tu représentes la marque sur WhatsApp — un client peut te contacter à tout moment, traite chaque échange avec le même soin qu'un conseiller clientèle premium.\n\n" +
    "TON ET STYLE :\n" +
    "- Professionnel, chaleureux et rassurant — jamais familier, jamais robotique.\n" +
    "- Ne te présente JAMAIS comme un 'assistant automatique', un 'bot' ou une IA — parle simplement au nom de Baki-Pay, comme le ferait un membre de l'équipe support.\n" +
    "- Réponds en français, de façon concise (message WhatsApp, pas un email) mais jamais sec.\n" +
    "- Structure avec des emojis sobres et des puces quand ça aide à la lisibilité, sans surcharger.\n" +
    "- Une seule question à la fois si tu dois demander une précision — ne submerge jamais le client.\n" +
    "- Termine par une ouverture (proposer la suite, ou inviter à revenir vers toi) plutôt que couper court.\n\n" +
    "CE QUE TU DOIS SAVOIR :\n" +
    "- Dépôt : gratuit, min 500 DJF, max 200 000 DJF, délai 5-15 min. Retrait : gratuit, même délai.\n" +
    "- Pour faire un dépôt : aller sur baki-pay.com, entrer ID 1xBet + montant + Transfer ID Waafi.\n" +
    "- Pour un retrait : générer un code sur 1xBet, puis l'entrer sur baki-pay.com avec le N° Waafi.\n\n" +
    "RÈGLES ABSOLUES :\n" +
    "- Utilise UNIQUEMENT les ordres listés ci-dessous pour répondre sur le statut d'un ordre — n'invente JAMAIS de numéro d'ordre, de montant ou de statut, et ne mentionne jamais d'ordre qui n'y figure pas.\n" +
    "- Si tu ne peux pas résoudre la demande toi-même (litige, erreur non couverte, remboursement...), oriente avec assurance vers un agent humain sur Telegram : @BakiPaySupportBot — présente ça comme un service, pas un échec.\n" +
    "- Ne donne jamais d'information sur d'autres clients ni sur les finances internes de l'entreprise.\n\n" +
    `Ordres récents de ce client (numéro ${localPhone}) :\n${ordersContext}`;

  // Essaie chaque modèle gratuit en cascade (2 tentatives chacun) — un modèle
  // gratuit OpenRouter peut être temporairement saturé/indisponible.
  for (const modele of OPENROUTER_MODELS) {
    for (let tentative = 0; tentative < 2; tentative++) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": "https://baki-pay.com",
            "X-Title": "Baki-Pay Support",
          },
          body: JSON.stringify({
            model: modele,
            max_tokens: 400,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: text },
            ],
          }),
          signal: AbortSignal.timeout(20000),
        });
        const data = await res.json().catch(() => ({}));
        const reply = data.choices?.[0]?.message?.content;
        if (res.ok && reply) return reply;
        console.warn("whatsapp-support OpenRouter", modele, "réponse invalide:", res.status, JSON.stringify(data).substring(0, 200));
      } catch (e) {
        console.warn("whatsapp-support OpenRouter", modele, "échoué:", (e as Error).message);
      }
    }
  }

  console.error("whatsapp-support: tous les modèles OpenRouter ont échoué");
  return menuBienvenue(senderName);
}

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
        await envoyer(phone, `❓ Ordre *#${ordreId}* introuvable.\nVérifiez le numéro et réessayez.`);
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

      await envoyer(phone, msg);
      return json({ ok: true }, 200, headers);
    }

    if (t === "aide" || t === "/aide" || t.includes("comment")) {
      await envoyer(phone,
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
      await envoyer(phone,
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

    // Salutation simple → menu direct (pas besoin d'IA pour ça)
    if (["bonjour", "salut", "bonsoir", "hello", "hi", "start", "/start"].includes(t)) {
      await envoyer(phone, menuBienvenue(senderName));
      return json({ ok: true }, 200, headers);
    }

    // Tout le reste (question en langage naturel, ex: "où en est mon dépôt
    // d'hier ?") → réponse IA avec les ordres récents de ce numéro en contexte.
    const reponse = await repondreIA(phone, senderName, text);
    await envoyer(phone, reponse);
  } catch (e) {
    console.error("whatsapp-support crash:", (e as Error).message);
  }

  return json({ ok: true }, 200, headers);
});
