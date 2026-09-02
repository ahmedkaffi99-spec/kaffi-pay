import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { supabase } from "../_shared/db.ts";
import { sendTelegram, notifyPaiementAgents } from "../_shared/telegram.ts";
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

  // Enregistrer dans waafi_notifications + Telegram en parallèle
  const insertPromise = supabase.from("waafi_notifications").insert({
    notification: notif, transfer_id: transferId, montant, num_client: numClient,
    source: "macrodroid", status: "reçu",
  }).select().single();

  let telegramPromise: Promise<unknown> = Promise.resolve();
  if (transferId || montant) {
    const msg =
      `📩 <b>SMS Waafi reçu — Paiement enregistré</b>\n\n` +
      `Transfer-ID: <code>${transferId || "?"}</code>\n` +
      `Montant: <b>${montant ? Number(montant).toLocaleString() : "?"} DJF</b>\n` +
      `Expéditeur: <code>${numClient || "?"}</code>\n\n` +
      `<i>✅ En attente de l'ordre client — confirmation automatique dès soumission.</i>`;
    telegramPromise = Promise.allSettled([
      sendTelegram(token, adminId, msg),
      notifyPaiementAgents(token, msg),
    ]);
  }

  // Attendre insert + Telegram avant de répondre à MacroDroid
  const [{ data: notifDoc, error: insertErr }] = await Promise.all([insertPromise, telegramPromise]);

  if (insertErr) {
    console.error("sms-webhook insertErr:", insertErr.message);
    return json({ error: insertErr.message }, 500, headers);
  }

  console.log("sms-webhook: inserted id=", notifDoc.id, "tid=", transferId, "montant=", montant, "num=", numClient);

  // Répondre à MacroDroid immédiatement
  const response = json({ success: true, id: notifDoc.id }, 200, headers);

  // Cas rare : ordre déjà soumis avant que le SMS arrive (matching inverse)
  if (transferId) {
    try {
      const { data: ordres } = await supabase.from("depot_orders")
        .select("*").eq("waafi_transfert_id", transferId).eq("status", "En attente").limit(1);

      if (ordres && ordres.length > 0) {
        const ordre = ordres[0];
        const ordreId = ordre.order_id as string;

        // Anti-doublon : TID déjà crédité ?
        const { data: dejaTraite } = await supabase.from("ordre_traite")
          .select("id").eq("transfer_id", transferId).eq("status", "credite").limit(1);
        if (!dejaTraite || dejaTraite.length === 0) {
          const { score, mismatches, decision } = scorerCorrespondance(ordre, notifDoc);

          if (decision === "confirmer") {
            // confirmerDepot → "Paiement Reçu" → MobCash → "Crédité avec succès"
            await confirmerDepot(ordre, notifDoc, token, adminId);
          } else {
            // Correspondance partielle → Paiement Non Reçu (comme Firebase, Telegram seulement)
            const raison = mismatchToRaison(mismatches);
            await supabase.from("depot_orders").update({
              status: "Paiement Non Reçu",
              flag_raison: raison,
              flagged_at: new Date().toISOString(),
              auto_notified: true,
            }).eq("id", ordre.id);
            const rejetMsg =
              `❌ <b>Dépôt rejeté (${score}/3) — ${raison}</b>\n` +
              `Ordre <code>#${ordreId}</code>\n` +
              mismatches.map((m: string) => `• ${m}`).join("\n");
            await sendTelegram(token, adminId, rejetMsg);
            await notifyPaiementAgents(token, rejetMsg).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error("sms-webhook matching error:", e);
    }
  }

  return response;
});
