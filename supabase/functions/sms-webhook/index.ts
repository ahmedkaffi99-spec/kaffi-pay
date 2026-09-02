import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { supabase } from "../_shared/db.ts";
import { sendTelegram, notifyPaiementAgents } from "../_shared/telegram.ts";
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import { extractTransferId, extractMontant, extractNumClient } from "../_shared/parser.ts";
import { scorerCorrespondance, mismatchToRaison } from "../_shared/scoring.ts";
import { json, cors } from "../_shared/utils.ts";
import { confirmerDepot } from "../_shared/confirmer.ts";

serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405, headers);

  const body = await req.json().catch(() => ({}));
  const notif = body.notification || body.not_body || body.message || body.text || "";
  const secret = (body.secret || "").toLowerCase();
  const expected = (Deno.env.get("MACRODROID_SECRET") || "Kafia&77105640").toLowerCase();

  console.log("sms-webhook: secret_ok=", secret === expected, "notif_len=", notif.length, "fields=", Object.keys(body).join(","));

  if (!secret || secret !== expected) return json({ error: "Secret invalide", debug: "secret_mismatch" }, 403, headers);
  if (!notif) return json({ error: "Champ 'notification' requis" }, 400, headers);

  const transferId = extractTransferId(notif);
  const montant = extractMontant(notif);
  const numClient = extractNumClient(notif);
  const token = Deno.env.get("TELEGRAM_TOKEN")!;
  const adminId = Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")!;

  // Enregistrer dans waafi_notifications
  const { data: notifDoc, error: insertErr } = await supabase.from("waafi_notifications").insert({
    notification: notif, transfer_id: transferId, montant, num_client: numClient,
    source: "macrodroid", status: "reçu",
  }).select().single();

  if (insertErr) {
    console.error("sms-webhook insertErr:", insertErr.message);
    return json({ error: insertErr.message }, 500, headers);
  }

  console.log("sms-webhook: inserted id=", notifDoc.id, "tid=", transferId, "montant=", montant, "num=", numClient);

  // Notification Telegram admin
  if (transferId || montant) {
    const msg =
      `📩 <b>SMS Waafi reçu — Paiement enregistré</b>\n\n` +
      `Transfer-ID: <code>${transferId || "?"}</code>\n` +
      `Montant: <b>${montant ? Number(montant).toLocaleString() : "?"} DJF</b>\n` +
      `Expéditeur: <code>${numClient || "?"}</code>\n\n` +
      `<i>✅ En attente de l'ordre client.</i>`;
    await Promise.allSettled([
      sendTelegram(token, adminId, msg),
      notifyPaiementAgents(token, msg),
    ]);
  }

  // Répondre à MacroDroid immédiatement
  const response = json({ success: true, id: notifDoc.id }, 200, headers);

  // Matching inverse : chercher un ordre "En attente" avec ce TID
  if (transferId) {
    try {
      const { data: ordres } = await supabase.from("depot_orders")
        .select("*").eq("waafi_transfert_id", transferId).eq("status", "En attente").limit(1);

      if (ordres && ordres.length > 0) {
        const ordre = ordres[0];
        const whatsapp = (ordre.whatsapp || "") as string;
        const vt = ordre.view_token ? `-${ordre.view_token}` : "";
        const ordreId = ordre.order_id as string;

        // Anti-doublon : TID déjà crédité ?
        const { data: dejaTraite } = await supabase.from("ordre_traite")
          .select("id").eq("transfer_id", transferId).eq("status", "credite").limit(1);

        if (!dejaTraite || dejaTraite.length === 0) {
          const { score, mismatches, decision } = scorerCorrespondance(ordre, notifDoc);

          if (decision === "confirmer") {
            // confirmerDepot appelle MobCash, envoie Telegram + WhatsApp
            await confirmerDepot(ordre, notifDoc, token, adminId);
          } else {
            // Correspondance partielle — laisser "En attente" pour vérification manuelle
            const raison = mismatchToRaison(mismatches);
            await sendTelegram(token, adminId,
              `⚠️ <b>SMS reçu — Correspondance partielle (${score}/3) — #${ordreId}</b>\n` +
              `${mismatches.map((m: string) => `• ${m}`).join("\n")}\n` +
              `<i>Ordre laissé En attente pour vérification manuelle.</i>`);
          }
        }
      }
    } catch (e) {
      console.error("sms-webhook matching error:", e);
    }
  }

  return response;
});
