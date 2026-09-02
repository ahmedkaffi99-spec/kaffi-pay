import { supabase } from "../_shared/db.ts";
import { sendTelegram, notifyPaiementAgents, sendTelegramKeyboard } from "../_shared/telegram.ts";
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import { callMobcash } from "../_shared/mobcash.ts";
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
  const withdrawalCode = (body.withdrawal_code || "").trim();
  const waafiNum = (body.numero_waafi || body.tel || body.whatsapp || "")
    .replace(/\s/g, "").replace(/^\+?253/, "");
  const userId1xbet = (body.user_id_1xbet || body.id1x || "").trim();
  const whatsapp = (body.whatsapp || "").trim();
  const viewToken = (body.view_token || genToken()) as string;

  if (!ordreId || !montant) return json({ error: "order_id et montant requis" }, 400, headers);

  // Insérer l'ordre en base
  const { data: ordre, error: insertErr } = await supabase.from("retrait_orders").insert({
    order_id: ordreId,
    status: "En attente",
    montant,
    user_id_1xbet: userId1xbet || null,
    id1x: userId1xbet || null,
    withdrawal_code: withdrawalCode || null,
    numero_waafi: waafiNum || null,
    whatsapp: whatsapp || null,
    view_token: viewToken,
  }).select().single();

  if (insertErr) return json({ error: insertErr.message }, 500, headers);

  logAudit("nouvel_retrait", { ordreId, montant, waafiNum });

  // Répondre au client immédiatement
  const response = json({ success: true, order_id: ordreId, view_token: viewToken }, 200, headers);

  // Traitement asynchrone
  (async () => {
    // Telegram admin — accusé de réception
    await sendTelegram(token, adminId,
      `📤 <b>Nouvel ordre Retrait</b> — <code>#${ordreId}</code>\n\n` +
      `Montant : <b>${montant.toLocaleString()} DJF</b>\n` +
      `N° Waafi : <code>${waafiNum || "—"}</code>\n` +
      `Code retrait : <code>${withdrawalCode || "—"}</code>\n` +
      `ID 1xBet : <code>${userId1xbet || "—"}</code>\n\n` +
      `<i>⏳ Appel MobCash en cours...</i>`
    ).catch(() => {});

    // WhatsApp — accusé de réception
    if (whatsapp) {
      await sendWhatsApp(whatsapp,
        `🧾 *Baki-Pay — Retrait reçu*\n\n` +
        `Ordre *#${ordreId}* — *${montant.toLocaleString()} DJF*\n\n` +
        `📝 *Statut : En attente*\n` +
        `Note : Traitement en cours. Veuillez ne pas annuler le code sur votre application 1xbet.\n\n` +
        `📲 baki-pay.com/#suivi-${ordreId}-${viewToken}`
      ).catch(() => {});
    }

    if (!waafiNum) {
      await supabase.from("retrait_orders").update({
        status: "Code Invalide",
        flag_raison: "Numéro Waafi manquant",
        flagged_at: new Date().toISOString(),
        auto_notified: true,
      }).eq("id", ordre.id);
      await sendTelegram(token, adminId,
        `⚠️ <b>Retrait sans numéro Waafi</b> — #${ordreId}\nNuméro Waafi manquant, impossible de composer le USSD.`);
      return;
    }

    if (!withdrawalCode) {
      await sendTelegram(token, adminId,
        `⚠️ <b>Retrait sans code</b> — #${ordreId}\nCode retrait manquant, intervention manuelle requise.`);
      return;
    }

    if (!userId1xbet) {
      await sendTelegram(token, adminId,
        `⚠️ <b>Retrait sans ID 1xBet</b> — #${ordreId}\nID compte 1xBet manquant, intervention manuelle requise.`);
      return;
    }

    try {
      const mobcashData = await callMobcash("Retrait", userId1xbet, montant, withdrawalCode);
      const montantMobcash = Math.abs(Number(
        mobcashData.Summa ?? mobcashData.summa ?? mobcashData.amount ?? mobcashData.sum ?? montant
      ));

      if (montantMobcash !== montant) {
        const note = "Montant incorrect. Le montant saisi ne correspond pas à la valeur du code sur 1xbet.";
        await supabase.from("retrait_orders").update({
          status: "Code Invalide",
          flag_raison: note,
          montant_mobcash: montantMobcash,
          flagged_at: new Date().toISOString(),
          auto_notified: true,
        }).eq("id", ordre.id);
        await sendTelegram(token, adminId,
          `❌ <b>Retrait — Code Invalide</b>\nOrdre : <code>#${ordreId}</code>\n${note}\n` +
          `Soumis : ${montant.toLocaleString()} DJF | MobCash : ${montantMobcash.toLocaleString()} DJF`);
        if (whatsapp) {
          await sendWhatsApp(whatsapp,
            `❌ *Baki-Pay — Code Invalide*\n\nOrdre *#${ordreId}* :\n\n📝 ${note}\n\n📲 baki-pay.com/#suivi-${ordreId}-${viewToken}`
          ).catch(() => {});
        }
        logAudit("retrait_montant_incorrect", { ordreId, montant, montantMobcash });
        return;
      }

      // Succès MobCash → Code Validé
      await supabase.from("retrait_orders").update({
        status: "Code Validé",
        mobcash_at: new Date().toISOString(),
        montant_mobcash: montantMobcash,
      }).eq("id", ordre.id);

      if (whatsapp) {
        await sendWhatsApp(whatsapp,
          `✅ *Baki-Pay — Code Validé*\n\nOrdre *#${ordreId}* — *${montantMobcash.toLocaleString()} DJF*\n\n` +
          `📝 *Statut : Code Validé*\n` +
          `Note : Fonds retirés avec succès depuis 1xbet. Votre transfert Waafi arrive dans un instant.\n\n` +
          `📲 baki-pay.com/#suivi-${ordreId}-${viewToken}`
        ).catch(() => {});
      }

      const ussd = `*200*${waafiNum}*${montantMobcash}#`;
      const retraitMsg =
        `📤 <b>Retrait à payer — #${ordreId}</b>\n\n` +
        `Montant : <b>${montantMobcash.toLocaleString()} DJF</b>\n` +
        `N° Waafi : <code>${waafiNum}</code>\n` +
        `Code retrait : <code>${withdrawalCode}</code>\n\n` +
        `📱 USSD : <code>${ussd}</code>\n\n` +
        `<i>1. Copiez le USSD → 2. Composez → 3. Confirmez → 4. Cliquez Terminer.</i>`;
      const retraitKb = [[{ text: "✅ Paiement Waafi effectué — Terminer", callback_data: `terminer_${ordreId}` }]];
      await sendTelegramKeyboard(token, adminId, retraitMsg, retraitKb);
      await notifyPaiementAgents(token, retraitMsg, retraitKb).catch(() => {});
      logAudit("retrait_code_valide", { ordreId, waafiNum, montantMobcash });

    } catch (e: unknown) {
      const err = e as Error & { rawData?: unknown };
      const msg = (err.message || "").toLowerCase();
      let note: string;
      if (/expir|expired/.test(msg))
        note = "Code expiré. Les codes de retrait 1xbet ont une durée de validité limitée.";
      else if (/already|used|cancelled|annul|duplicate/.test(msg))
        note = "Code déjà utilisé ou annulé sur 1xbet.";
      else if (/amount|montant|sum|incorrect/.test(msg))
        note = "Montant incorrect. Le montant saisi ne correspond pas à la valeur du code sur 1xbet.";
      else
        note = "Code inexistant. Veuillez vérifier les caractères et réessayer.";

      await supabase.from("retrait_orders").update({
        status: "Code Invalide",
        flag_raison: note,
        flagged_at: new Date().toISOString(),
        auto_notified: true,
      }).eq("id", ordre.id);
      await sendTelegram(token, adminId,
        `❌ <b>Retrait — Code Invalide</b> — #${ordreId}\n${note}\n<code>${err.message}</code>`);
      if (whatsapp) {
        await sendWhatsApp(whatsapp,
          `❌ *Baki-Pay — Code Invalide*\n\nOrdre *#${ordreId}* :\n\n📝 ${note}\n\n📲 baki-pay.com/#suivi-${ordreId}-${viewToken}`
        ).catch(() => {});
      }
      logAudit("retrait_code_invalide", { ordreId, error: err.message });
    }
  })().catch((e) => console.error("submit-retrait async error:", e));

  return response;
});
