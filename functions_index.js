/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           KAFFI PAY — CLOUD FUNCTIONS v3.0                      ║
 * ║  • Détection fraude & doublons                                  ║
 * ║  • Confirmation automatique SMS Waafi                           ║
 * ║  • Notifications Telegram admin                                 ║
 * ║  • Health check endpoint                                        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest }                    = require("firebase-functions/v2/https");
const { defineSecret }                         = require("firebase-functions/params");
const { initializeApp }                        = require("firebase-admin/app");
const { getFirestore, FieldValue }             = require("firebase-admin/firestore");
initializeApp();
const db = getFirestore();

const REGION = "europe-west1";

// ── Secrets ────────────────────────────────────────────────────────
const TELEGRAM_TOKEN    = defineSecret("TELEGRAM_TOKEN");
const TELEGRAM_ADMIN_ID = defineSecret("TELEGRAM_ADMIN_CHAT_ID");
const MACRO_WEBHOOK_URL = defineSecret("MACRODROID_WEBHOOK_URL");
const MACRO_SECRET      = defineSecret("MACRODROID_SECRET");

// ── Helpers ─────────────────────────────────────────────────────────

async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal:  AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.warn("Telegram error:", resp.status, body.substring(0, 200));
    }
  } catch (e) {
    console.warn("Telegram send failed:", e.message);
  }
}

// Evite double-traitement via transaction Firestore
async function claimOrder(docRef, expectedStatus, newStatus, extraFields = {}) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists || snap.data().status !== expectedStatus) return false;
    tx.update(docRef, { status: newStatus, ...extraFields });
    return true;
  });
}

function extractTransferId(text) {
  const m = text.match(/Transfer-?Id[:\s]+(\d+)/i);
  return m ? m[1].trim() : null;
}

function extractMontant(text) {
  const m =
    text.match(/Received\s+DJF\s+([\d,]+)/i) ||
    text.match(/transferred\s+DJF\s+([\d,]+)/i) ||
    text.match(/DJF\s*([\d,]+)/i);
  if (!m) return null;
  const val = parseFloat(m[1].replace(/,(?=\d{3})/g, "").replace(",", "."));
  return isNaN(val) ? null : val;
}

function extractNumClient(text, ownNumber = "77275572") {
  const matches = (text.match(/\((\d{8})\)/g) || []).map((s) => s.replace(/[()]/g, ""));
  const others  = matches.filter((n) => n !== ownNumber);
  if (others.length > 0) return others[0];
  const m = text.match(/from\s+(77\d{6})/i) || text.match(/de\s+(77\d{6})/i);
  return m ? m[1] : (matches[0] || null);
}

// ══════════════════════════════════════════════════════════════════
// 1. NOUVEL ORDRE → Fraude + Doublons + Alerte Telegram admin
// ══════════════════════════════════════════════════════════════════
exports.onNouvelOrdre = onDocumentCreated(
  {
    document:  "orders/{docId}",
    region:    REGION,
    secrets:   [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID],
    timeoutSeconds: 60,
  },
  async (event) => {
    const tx         = event.data.data();
    const docId      = event.params.docId;
    const ref        = tx.orderId || tx.ref || docId;
    const transferId = tx.waafitranfertID || tx.hash || "";
    const isDepot    = tx.type === "Dépôt";

    // ── 1a. Détection doublons (sans composite index) ──────────────
    if (transferId) {
      const existing = await db.collection("orders")
        .where("waafitranfertID", "==", transferId)
        .limit(5)
        .get();

      const dupes = existing.docs.filter((d) => d.id !== docId);
      if (dupes.length > 0) {
        await db.collection("orders").doc(docId).update({
          status:     "Rejeté",
          flagRaison: "Doublon — Transfer ID déjà utilisé",
          flaggedAt:  FieldValue.serverTimestamp(),
        });
        await sendTelegram(
          TELEGRAM_TOKEN.value(),
          TELEGRAM_ADMIN_ID.value(),
          `⚠️ <b>Doublon détecté</b>\n` +
          `Ordre <code>#${ref}</code> rejeté automatiquement.\n` +
          `Transfer ID <code>${transferId}</code> déjà utilisé.`
        );
        return;
      }
    }

    // ── 1b. Notification Telegram admin ───────────────────────────
    const details = isDepot
      ? `ID 1xBet: <code>${tx.userId1xBet || tx.id1x || "?"}</code>\n` +
        `Transfer ID: <code>${transferId || "?"}</code>\n` +
        `Expéditeur: <code>${tx.numeroPayment || "?"}</code>`
      : `Code retrait: <code>${tx.withdrawalCode || tx.code || "?"}</code>\n` +
        `Numéro Waafi: <code>${tx.waafiNumber || tx.tel || "?"}</code>`;

    await sendTelegram(
      TELEGRAM_TOKEN.value(),
      TELEGRAM_ADMIN_ID.value(),
      `${isDepot ? "📥" : "📤"} <b>Nouvel ordre ${tx.type}</b>\n\n` +
      `Réf: <b>#${ref}</b>\n` +
      `Montant: <b>${Number(tx.montant).toLocaleString()} DJF</b>\n` +
      `${details}`
    );
  }
);

// ══════════════════════════════════════════════════════════════════
// 2. ORDRE MIS À JOUR → Notification Telegram admin
//    IMPORTANT : écoute "orders/" (corrigé — était "transactions/")
// ══════════════════════════════════════════════════════════════════
exports.onOrdreUpdated = onDocumentUpdated(
  {
    document: "orders/{docId}",
    region:   REGION,
    secrets:  [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID],
  },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    // Ne rien faire si le statut n'a pas changé
    if (before.status === after.status) return;

    const ref     = after.orderId || after.ref || event.params.docId;
    const montant = Number(after.montant || 0).toLocaleString();
    const type    = after.type || "Ordre";

    let adminMsg = "";
    if (after.status === "Confirmé") {
      adminMsg =
        `✅ <b>${type} confirmé</b>\n` +
        `#${ref} — ${montant} DJF\n` +
        (after.confirmedBy === "auto_waafi_sms" ? "🤖 Auto-confirmation SMS" : "👤 Confirmé manuellement");
    } else if (after.status === "Rejeté") {
      adminMsg =
        `❌ <b>${type} rejeté</b>\n` +
        `#${ref} — ${after.flagRaison || "Raison inconnue"}`;
    } else if (after.status === "Argent Reçu") {
      adminMsg =
        `💳 <b>Paiement Waafi reçu</b>\n` +
        `#${ref} — ${montant} DJF\n` +
        `Crédit 1xBet en cours…`;
    } else if (after.status === "Correction") {
      adminMsg =
        `✏️ <b>Correction demandée</b>\n` +
        `#${ref}\n` +
        `Message: ${after.correctionMsg || ""}`;
    }

    if (adminMsg) {
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(), adminMsg);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// 3. AUTO-CONFIRMATION — SMS Waafi → Confirme l'ordre + Webhook
//
//  Flux :
//    MacroDroid détecte SMS Waafi
//    → écrit dans Firestore "waafi_notifications"
//    → cette fonction se déclenche
//    → cherche l'ordre (Transfer ID ou montant+numéro)
//    → transaction atomique pour éviter double-traitement
//    → "Argent Reçu" immédiat, "Confirmé" après 10s
//    → déclenche webhook MacroDroid pour recharge 1xBet
//    → notifie admin Telegram
// ══════════════════════════════════════════════════════════════════
exports.autoConfirmation = onDocumentCreated(
  {
    document:       "waafi_notifications/{docId}",
    region:         REGION,
    secrets:        [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, MACRO_WEBHOOK_URL, MACRO_SECRET],
    timeoutSeconds: 60,
  },
  async (event) => {
    const sms   = event.data.data();
    const docId = event.params.docId;

    // Ignorer si déjà traité
    if (sms.status === "traité" || sms.status === "en_cours") return;

    // Vérifier secret MacroDroid si fourni
    const expectedSecret = MACRO_SECRET.value() || "KaffiPay2026";
    if (sms.secret && sms.secret !== expectedSecret) {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "rejeté_secret_invalide",
      });
      return;
    }

    // Marquer "en cours" pour éviter double traitement
    await db.collection("waafi_notifications").doc(docId).update({
      status:      "en_cours",
      processedAt: FieldValue.serverTimestamp(),
    });

    // ── Parser le SMS Waafi ────────────────────────────────────────
    const notification =
      sms.notification || sms.not_body || sms.message ||
      sms.texte || sms.body || sms.text || "";

    const transferId = extractTransferId(notification);
    const montantSMS = extractMontant(notification);
    const numClient  = extractNumClient(notification);

    console.log(`SMS Waafi → TransferID: ${transferId}, Montant: ${montantSMS} DJF, N°: ${numClient}`);

    if (!transferId && !montantSMS) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "erreur_parsing",
        erreurMsg: "Impossible d'extraire Transfer ID ou Montant du SMS",
      });
      return;
    }

    // ── Chercher l'ordre correspondant ────────────────────────────
    let ordreSnap = { empty: true };

    // Stratégie 1 : Transfer ID exact
    if (transferId) {
      ordreSnap = await db.collection("orders")
        .where("waafitranfertID", "==", transferId)
        .where("status", "==", "En attente")
        .limit(1)
        .get();
    }

    // Stratégie 2 : montant + numéro client
    if (ordreSnap.empty && numClient && montantSMS) {
      ordreSnap = await db.collection("orders")
        .where("numeroPayment", "==", numClient)
        .where("montant", "==", montantSMS)
        .where("status", "==", "En attente")
        .limit(1)
        .get();
    }

    if (ordreSnap.empty) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "non_matché",
        erreurMsg: `Aucun ordre en attente — Transfer ID: ${transferId}, Montant: ${montantSMS} DJF`,
      });
      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>SMS Waafi sans correspondance</b>\n\n` +
        `Transfer-ID: <code>${transferId || "?"}</code>\n` +
        `Montant: <b>${montantSMS ? montantSMS.toLocaleString() : "?"} DJF</b>\n` +
        `Expéditeur: <code>${numClient || "?"}</code>\n\n` +
        `Vérifiez les ordres en attente — paiement manuel peut-être requis.`
      );
      return;
    }

    const ordreDoc     = ordreSnap.docs[0];
    const ordre        = ordreDoc.data();
    const ordreRef     = ordre.orderId || ordre.ref || ordreDoc.id;
    const montantOrdre = Number(ordre.montant || 0);
    const mt           = montantSMS || montantOrdre;

    // Vérification tolérance montant (±5 DJF pour arrondi)
    if (montantSMS && Math.abs(montantOrdre - montantSMS) > 5) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "montant_incorrect",
        erreurMsg: `Montant SMS (${montantSMS}) ≠ Montant ordre (${montantOrdre})`,
        ordreRef:  ordreRef,
      });
      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>Montant incorrect</b> pour #${ordreRef}\n` +
        `SMS: ${montantSMS} DJF / Ordre: ${montantOrdre} DJF\n` +
        `Vérification manuelle requise.`
      );
      return;
    }

    // ── Transaction atomique → "Argent Reçu" (évite double traitement) ──
    const claimed = await claimOrder(ordreDoc.ref, "En attente", "Argent Reçu", {
      confirmedBy:     "auto_waafi_sms",
      waafitranfertID: transferId || ordre.waafitranfertID,
      montantRecu:     mt,
      expediteurRecu:  numClient || "",
      argentRecuAt:    FieldValue.serverTimestamp(),
    });

    if (!claimed) {
      // Ordre déjà traité par le frontend ou une autre exécution
      await db.collection("waafi_notifications").doc(docId).update({
        status:   "déjà_traité",
        ordreRef: ordreRef,
      });
      return;
    }

    await db.collection("waafi_notifications").doc(docId).update({
      status:   "matché",
      ordreRef: ordreRef,
    });

    // ── Attente 10s puis "Confirmé" ───────────────────────────────
    await new Promise((r) => setTimeout(r, 10000));

    await ordreDoc.ref.update({
      status:      "Confirmé",
      confirmedAt: FieldValue.serverTimestamp(),
    });

    await db.collection("waafi_notifications").doc(docId).update({
      status: "traité",
    });

    // ── Webhook MacroDroid → Recharge 1xBet ──────────────────────
    const id1xbet = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";

    if (id1xbet) {
      const webhookBase = MACRO_WEBHOOK_URL.value() ||
        "https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet";
      try {
        const webhookUrl =
          `${webhookBase}?id1xbet=${encodeURIComponent(id1xbet)}` +
          `&montant=${encodeURIComponent(mt)}` +
          `&ref=${encodeURIComponent(ordreRef)}`;

        const resp = await fetch(webhookUrl, { signal: AbortSignal.timeout(10000) });

        await ordreDoc.ref.update({
          webhookStatus: resp.ok ? "ok" : "erreur_" + resp.status,
          webhookAt:     FieldValue.serverTimestamp(),
        });

        if (!resp.ok) {
          await sendTelegram(
            TELEGRAM_TOKEN.value(),
            TELEGRAM_ADMIN_ID.value(),
            `⚠️ <b>Webhook MacroDroid échoué</b>\n` +
            `Ordre #${ordreRef} — HTTP ${resp.status}\n` +
            `ID 1xBet: <code>${id1xbet}</code> — ${Number(mt).toLocaleString()} DJF\n` +
            `<b>Recharge manuelle requise.</b>`
          );
        }
      } catch (e) {
        await ordreDoc.ref.update({ webhookStatus: "erreur_timeout" });
        await sendTelegram(
          TELEGRAM_TOKEN.value(),
          TELEGRAM_ADMIN_ID.value(),
          `⚠️ <b>MacroDroid injoignable</b>\n` +
          `Ordre #${ordreRef} — ${e.name === "AbortError" ? "Timeout 10s" : e.message}\n` +
          `ID 1xBet: <code>${id1xbet}</code> — ${Number(mt).toLocaleString()} DJF\n` +
          `<b>Recharge manuelle requise.</b>`
        );
      }
    } else {
      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>ID 1xBet manquant</b> — Ordre #${ordreRef}\n` +
        `${Number(mt).toLocaleString()} DJF reçu — <b>Recharge manuelle requise.</b>`
      );
    }

    // ── Notification finale ───────────────────────────────────────
    await sendTelegram(
      TELEGRAM_TOKEN.value(),
      TELEGRAM_ADMIN_ID.value(),
      `✅ <b>Dépôt auto-confirmé</b>\n` +
      `#${ordreRef} — ${Number(mt).toLocaleString()} DJF\n` +
      `ID 1xBet: <code>${id1xbet || "?"}</code>\n` +
      (transferId ? `Transfer-ID: <code>${transferId}</code>` : "")
    );
  }
);

// ══════════════════════════════════════════════════════════════════
// 4. HEALTH CHECK — Vérifier que le backend fonctionne
// ══════════════════════════════════════════════════════════════════
exports.healthCheck = onRequest(
  { region: REGION },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    try {
      const t0   = Date.now();
      const snap = await db.collection("orders").limit(1).get();
      const ms   = Date.now() - t0;

      res.json({
        status:    "ok",
        timestamp: new Date().toISOString(),
        region:    REGION,
        firestore: `connected (${ms}ms)`,
        version:   "3.0",
      });
    } catch (e) {
      res.status(500).json({ status: "error", message: e.message });
    }
  }
);
