/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           KAFFI PAY — CLOUD FUNCTIONS v3.2                      ║
 * ║  • Confirmation automatique dépôts (Transfer ID)                ║
 * ║  • Fraude permanente (Transfer ID réutilisé)                    ║
 * ║  • Notifications Telegram admin                                 ║
 * ║  • Support client Telegram (Gemini AI)                         ║
 * ║  • Audit Gemini → admin après chaque interaction client         ║
 * ║  • Webhook MacroDroid SMS Waafi                                 ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest }                    = require("firebase-functions/v2/https");
const { defineSecret }                         = require("firebase-functions/params");
const { initializeApp }                        = require("firebase-admin/app");
const { getFirestore, FieldValue }             = require("firebase-admin/firestore");
const { VertexAI }                             = require("@google-cloud/vertexai");

initializeApp();
const db = getFirestore();

const REGION     = "europe-west1";
const PROJECT_ID = "kaffi-pay";
const AI_LOC     = "us-central1";

// ── Secrets ────────────────────────────────────────────────────────
const TELEGRAM_TOKEN    = defineSecret("TELEGRAM_TOKEN");
const TELEGRAM_ADMIN_ID = defineSecret("TELEGRAM_ADMIN_CHAT_ID");
const MACRO_WEBHOOK_URL = defineSecret("MACRODROID_WEBHOOK_URL");
const MACRO_SECRET      = defineSecret("MACRODROID_SECRET");
const SUPPORT_BOT_TOKEN = defineSecret("SUPPORT_BOT_TOKEN");

// ── Helpers ─────────────────────────────────────────────────────────

function getGemini() {
  return new VertexAI({ project: PROJECT_ID, location: AI_LOC })
    .getGenerativeModel({ model: "gemini-2.0-flash-001" });
}

async function sendTelegramToBot(token, chatId, text, opts = {}) {
  if (!token || !chatId) {
    console.warn("sendTelegramToBot: token or chatId manquant", { hasToken: !!token, chatId });
    return false;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...opts }),
      signal:  AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.warn("sendTelegramToBot API error:", resp.status, body.substring(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.warn("sendTelegramToBot failed:", e.message);
    return false;
  }
}

// Extrait le texte de la réponse Vertex AI
function aiText(result) {
  return result.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

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

    // ── 1a. Transfer ID déjà confirmé = fraude permanente ────────────
    // Peu importe la date — Transfer ID d'un ordre confirmé ne peut jamais
    // être réutilisé. Même un paiement confirmé il y a 1 an → fraude.
    if (transferId) {
      const confirmeSnap = await db.collection("orders")
        .where("waafitranfertID", "==", transferId)
        .where("status", "==", "Confirmé")
        .limit(1)
        .get();

      if (!confirmeSnap.empty) {
        const ancienOrdre = confirmeSnap.docs[0].data();
        const ancienRef   = ancienOrdre.orderId || confirmeSnap.docs[0].id;
        await db.collection("orders").doc(docId).update({
          status:     "Rejeté",
          flagRaison: `FRAUDE — Transfer ID ${transferId} déjà utilisé dans l'ordre confirmé #${ancienRef}`,
          flaggedAt:  FieldValue.serverTimestamp(),
        });
        await sendTelegram(
          TELEGRAM_TOKEN.value(),
          TELEGRAM_ADMIN_ID.value(),
          `🚨 <b>FRAUDE détectée</b>\n\n` +
          `Ordre <code>#${ref}</code> rejeté.\n` +
          `Transfer-ID <code>${transferId}</code> déjà utilisé\n` +
          `dans l'ordre confirmé <code>#${ancienRef}</code>.\n\n` +
          `⚠️ Tentative de réutilisation d'un ancien paiement.`
        );
        return;
      }

      // Vérifie aussi les waafi_notifications déjà matchées
      const waafiMatcheSnap = await db.collection("waafi_notifications")
        .where("transferId", "==", transferId)
        .where("status", "==", "matché")
        .limit(1)
        .get();

      if (!waafiMatcheSnap.empty) {
        const ancienWaafi = waafiMatcheSnap.docs[0].data();
        await db.collection("orders").doc(docId).update({
          status:     "Rejeté",
          flagRaison: `FRAUDE — Transfer ID ${transferId} déjà matché avec l'ordre #${ancienWaafi.ordreRef || "?"}`,
          flaggedAt:  FieldValue.serverTimestamp(),
        });
        await sendTelegram(
          TELEGRAM_TOKEN.value(),
          TELEGRAM_ADMIN_ID.value(),
          `🚨 <b>FRAUDE détectée</b>\n\n` +
          `Transfer-ID <code>${transferId}</code> déjà utilisé\n` +
          `pour confirmer l'ordre <code>#${ancienWaafi.ordreRef || "?"}</code>.\n\n` +
          `⚠️ Paiement Waafi réutilisé.`
        );
        return;
      }
    }

    // ── 1b. Transfer ID = seule vérité du paiement ───────────────────
    // Transfer ID trouvé → paiement réel → correction ordre + confirmation
    // Transfer ID introuvable → rejet immédiat
    if (isDepot) {
      const montantOrdre = Number(tx.montant || 0);

      let waafiDoc  = null;
      let waafiData = null;

      if (transferId) {
        const snap = await db.collection("waafi_notifications")
          .where("transferId", "==", transferId)
          .where("status", "==", "nouveau")
          .limit(1)
          .get();
        if (!snap.empty) {
          waafiDoc  = snap.docs[0];
          waafiData = waafiDoc.data();
        }
      }

      // ── Transfer ID trouvé → paiement confirmé ────────────────────
      if (waafiDoc) {
        const montantReel = waafiData.montant  || montantOrdre;
        const numReel     = waafiData.numClient || tx.numeroPayment || "";

        // Signale les corrections si montant ou numéro différents
        const corrections = [];
        if (waafiData.montant && Math.abs(montantOrdre - waafiData.montant) > 1) {
          corrections.push(`Montant corrigé: ${montantOrdre} → ${waafiData.montant} DJF`);
        }
        if (waafiData.numClient && tx.numeroPayment && waafiData.numClient !== tx.numeroPayment) {
          corrections.push(`N° corrigé: ${tx.numeroPayment} → ${waafiData.numClient}`);
        }

        const claimed = await claimOrder(
          db.collection("orders").doc(docId),
          "En attente", "Confirmé",
          {
            confirmedBy:       "auto_transfer_id",
            montant:           montantReel,
            montantRecu:       montantReel,
            numeroPayment:     numReel,
            expediteurRecu:    numReel,
            correctionApplied: corrections.length > 0,
            corrections:       corrections,
            confirmedAt:       FieldValue.serverTimestamp(),
          }
        );

        if (claimed) {
          await waafiDoc.ref.update({ status: "matché", ordreRef: ref });
          await sendTelegram(
            TELEGRAM_TOKEN.value(),
            TELEGRAM_ADMIN_ID.value(),
            `✅ <b>Dépôt confirmé</b>${corrections.length ? " ✏️ (corrigé)" : ""}\n\n` +
            `Réf: <b>#${ref}</b>\n` +
            `Montant: <b>${Number(montantReel).toLocaleString()} DJF</b>\n` +
            `ID 1xBet: <code>${tx.userId1xBet || "?"}</code>\n` +
            `Transfer-ID: <code>${transferId}</code>\n` +
            `Expéditeur: <code>${numReel}</code>\n` +
            (corrections.length ? `\n✏️ <i>${corrections.join(" | ")}</i>` : "") +
            `\n\n🤖 Transfer ID vérifié — confirmation automatique`
          );
          return;
        }
      }

      // ── Transfer ID introuvable → rejet ───────────────────────────
      await db.collection("orders").doc(docId).update({
        status:     "Rejeté",
        flagRaison: `Paiement non reçu — Transfer ID ${transferId || "(non fourni)"} introuvable dans les notifications Waafi`,
        flaggedAt:  FieldValue.serverTimestamp(),
      });
      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `❌ <b>Ordre rejeté — Paiement non reçu</b>\n\n` +
        `Réf: <code>#${ref}</code>\n` +
        `Transfer-ID soumis: <code>${transferId || "non fourni"}</code>\n` +
        `Montant: <b>${montantOrdre.toLocaleString()} DJF</b>\n` +
        `ID 1xBet: <code>${tx.userId1xBet || "?"}</code>\n\n` +
        `⚠️ Aucun paiement Waafi avec ce Transfer ID.`
      );
      return;
    }

    // ── 1c. Analyse fraude Gemini (Vertex AI) ─────────────────────
    let fraud = { score_fraude: 0, risque: "faible", raisons: [], action: "valider" };
    try {
      const model  = getGemini();
      const result = await model.generateContent({
        contents: [{
          role: "user",
          parts: [{ text: `
Tu es un système de détection de fraude pour Kaffi Pay (Djibouti, échange 1xBet↔Waafi).
Réponds UNIQUEMENT en JSON valide, sans texte autour.

{
  "score_fraude": 0-100,
  "risque": "faible"|"moyen"|"élevé",
  "raisons": ["raison1"],
  "action": "valider"|"vérifier"|"rejeter"
}

Transaction :
- Type: ${tx.type}
- Montant: ${tx.montant} DJF
- Transfer ID: ${transferId}
- N° Expéditeur: ${tx.numeroPayment || "?"}
Règles : montant > 50000 = suspect, Transfer ID < 6 chiffres = invalide, numéro ne commence pas par 77 = suspect.
Note : Kaffi Pay fonctionne 24h/24 7j/7 — l'heure de la transaction n'est jamais un facteur suspect.
` }]
        }]
      });
      fraud = JSON.parse(aiText(result).replace(/```json|```/g, "").trim());
    } catch (e) {
      console.error("Gemini fraud error:", e.message);
    }

    await db.collection("orders").doc(docId).update({
      ia_score_fraude: fraud.score_fraude,
      ia_risque:       fraud.risque,
      ia_raisons:      fraud.raisons,
      ia_action:       fraud.action,
      ia_analysedAt:   FieldValue.serverTimestamp(),
    });

    // ── 1d. Rejet auto si fraude élevée ───────────────────────────
    if (fraud.action === "rejeter" || fraud.risque === "élevé") {
      await db.collection("orders").doc(docId).update({
        status:     "Rejeté",
        flagRaison: "IA Fraude: " + fraud.raisons.join(", "),
      });
      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `🚨 <b>Ordre rejeté par IA</b>\n` +
        `Réf: <code>#${ref}</code>\n` +
        `Score: ${fraud.score_fraude}/100 — ${fraud.risque.toUpperCase()}\n` +
        `Raisons: ${fraud.raisons.join(", ")}`
      );
      return;
    }

    // ── 1e. Notification Telegram admin (paiement pas encore reçu) ──
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
      `${details}\n\n` +
      `Risque IA: <i>${fraud.risque} (${fraud.score_fraude}/100)</i>`
    );
  }
);

// ══════════════════════════════════════════════════════════════════
// 2. ORDRE MIS À JOUR → Notification Telegram admin
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
// 3. ANALYSE IA ADMIN (résumé + prédictions)
// ══════════════════════════════════════════════════════════════════
exports.geminiAnalyseAdmin = onCall(
  { region: REGION },
  async () => {
    const snap = await db.collection("orders")
      .orderBy("ts", "desc")
      .limit(100)
      .get();

    const txs       = snap.docs.map((d) => d.data());
    const confirmes = txs.filter((t) => t.status === "Confirmé");
    const attente   = txs.filter((t) => t.status === "En attente");
    const rejetes   = txs.filter((t) => t.status === "Rejeté");
    const volume    = confirmes.reduce((s, t) => s + Number(t.montant || 0), 0);
    const model     = getGemini();

    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [{ text: `
Tu es l'assistant IA de Kaffi Pay (Djibouti).
Réponds UNIQUEMENT en JSON valide.

Données (100 dernières transactions) :
- Confirmées: ${confirmes.length} — Volume: ${volume.toLocaleString()} DJF
- En attente: ${attente.length}
- Rejetées: ${rejetes.length}
- Taux confirmation: ${txs.length ? Math.round((confirmes.length / txs.length) * 100) : 0}%
- Montant moyen: ${confirmes.length ? Math.round(volume / confirmes.length) : 0} DJF

5 dernières:
${txs.slice(0, 5).map((t) => `• ${t.type} ${t.montant} DJF — ${t.status} — ${t.date}`).join("\n")}

{
  "resume": "résumé 2 phrases",
  "alerte": "problème urgent ou null",
  "conseil": "1 conseil",
  "prediction_demain": nombre_djf,
  "score_sante": 0-100
}
Note : Kaffi Pay est 24h/24 7j/7 — ne jamais mentionner les heures comme facteur d'analyse.
` }]
      }]
    });

    const txt = aiText(result).replace(/```json|```/g, "").trim();
    try {
      return {
        success: true,
        data:    JSON.parse(txt),
        stats:   { confirmes: confirmes.length, attente: attente.length, rejetes: rejetes.length, volume },
      };
    } catch {
      return { success: false, error: "Erreur parsing IA" };
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// 4. VÉRIFICATION PREUVE DE PAIEMENT (Gemini Vision)
// ══════════════════════════════════════════════════════════════════
exports.geminiVerifPreuve = onCall(
  { region: REGION },
  async (request) => {
    const { imageBase64, mimeType, ordreRef, montantAttendu, transferIdAttendu } = request.data;
    if (!imageBase64) throw new Error("Image requise");

    const model  = getGemini();
    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [
          { text: `Tu vérifies une preuve de paiement Waafi pour Kaffi Pay (Djibouti).
Réponds UNIQUEMENT en JSON valide.

Montant attendu: ${montantAttendu} DJF
Transfer ID attendu: ${transferIdAttendu}

{
  "est_valide": true|false,
  "transfer_id_detecte": "ID ou null",
  "montant_detecte": nombre ou null,
  "expediteur_detecte": "numéro ou null",
  "correspondance_montant": true|false,
  "correspondance_transfer_id": true|false,
  "confiance": 0-100,
  "raison": "explication courte"
}` },
          { inlineData: { data: imageBase64, mimeType: mimeType || "image/jpeg" } },
        ]
      }]
    });

    const txt = aiText(result).replace(/```json|```/g, "").trim();
    try {
      const parsed = JSON.parse(txt);
      if (ordreRef) {
        const snap = await db.collection("orders")
          .where("orderId", "==", ordreRef)
          .limit(1)
          .get();
        if (!snap.empty) {
          await snap.docs[0].ref.update({
            ia_preuve_valide:    parsed.est_valide,
            ia_preuve_confiance: parsed.confiance,
            ia_preuve_raison:    parsed.raison,
            ia_preuve_checkedAt: FieldValue.serverTimestamp(),
          });
        }
      }
      return { success: true, data: parsed };
    } catch {
      return { success: false, error: "Impossible d'analyser l'image" };
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// 5. AUTO-CONFIRMATION — SMS Waafi → Confirme l'ordre + Webhook
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

    if (sms.status === "traité" || sms.status === "en_cours") return;

    const expectedSecret = MACRO_SECRET.value() || "KaffiPay2026";
    if (sms.secret && sms.secret !== expectedSecret) {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "rejeté_secret_invalide",
      });
      return;
    }

    await db.collection("waafi_notifications").doc(docId).update({
      status:      "en_cours",
      processedAt: FieldValue.serverTimestamp(),
    });

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

    let ordreSnap = { empty: true };

    if (transferId) {
      ordreSnap = await db.collection("orders")
        .where("waafitranfertID", "==", transferId)
        .where("status", "==", "En attente")
        .limit(1)
        .get();
    }

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

    const claimed = await claimOrder(ordreDoc.ref, "En attente", "Argent Reçu", {
      confirmedBy:     "auto_waafi_sms",
      waafitranfertID: transferId || ordre.waafitranfertID,
      montantRecu:     mt,
      expediteurRecu:  numClient || "",
      argentRecuAt:    FieldValue.serverTimestamp(),
    });

    if (!claimed) {
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

    await new Promise((r) => setTimeout(r, 10000));

    await ordreDoc.ref.update({
      status:      "Confirmé",
      confirmedAt: FieldValue.serverTimestamp(),
    });

    await db.collection("waafi_notifications").doc(docId).update({
      status: "traité",
    });

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
// 6. WEBHOOK MACRODROID — Reçoit la notif Waafi → Firestore + Telegram
//
//  MacroDroid configure :
//    Trigger : Notification reçue (app Waafi)
//    Action  : HTTP POST vers cette URL
//    Body    : {"notification":"[not_body]","secret":"KaffiPay2026"}
// ══════════════════════════════════════════════════════════════════
exports.smsWebhook = onRequest(
  { region: REGION, secrets: [MACRO_SECRET, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST")    { res.status(405).send("Method Not Allowed"); return; }

    const body   = req.body || {};
    const notif  = body.notification || body.not_body || body.message || body.text || "";
    const secret = body.secret || "";

    const expectedSecret = MACRO_SECRET.value() || "KaffiPay2026";
    if (secret && secret !== expectedSecret) {
      res.status(403).json({ error: "Secret invalide" });
      return;
    }

    if (!notif) {
      res.status(400).json({ error: "Champ 'notification' requis" });
      return;
    }

    // Parse le SMS immédiatement pour faciliter la recherche
    const transferIdParsed = extractTransferId(notif);
    const montantParsed    = extractMontant(notif);
    const numClientParsed  = extractNumClient(notif);

    // Enregistre dans Firestore → déclenche autoConfirmation si ordre déjà là
    const docRef = await db.collection("waafi_notifications").add({
      notification: notif,
      transferId:   transferIdParsed,
      montant:      montantParsed,
      numClient:    numClientParsed,
      secret:       expectedSecret,
      source:       "macrodroid",
      status:       "nouveau",
      createdAt:    FieldValue.serverTimestamp(),
    });

    // Notifie immédiatement l'admin Telegram
    const transferId = transferIdParsed;
    const montant    = montantParsed;
    const numClient  = numClientParsed;

    await sendTelegram(
      TELEGRAM_TOKEN.value(),
      TELEGRAM_ADMIN_ID.value(),
      `📩 <b>SMS Waafi reçu</b>\n\n` +
      `Transfer-ID: <code>${transferId || "?"}</code>\n` +
      `Montant: <b>${montant ? Number(montant).toLocaleString() : "?"} DJF</b>\n` +
      `Expéditeur: <code>${numClient || "?"}</code>\n\n` +
      `<i>Traitement auto en cours…</i>`
    );

    res.json({ success: true, id: docRef.id });
  }
);

// ══════════════════════════════════════════════════════════════════
// 7. HEALTH CHECK
// ══════════════════════════════════════════════════════════════════
exports.healthCheck = onRequest(
  { region: REGION },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    try {
      const t0   = Date.now();
      await db.collection("orders").limit(1).get();
      const ms   = Date.now() - t0;

      res.json({
        status:    "ok",
        timestamp: new Date().toISOString(),
        region:    REGION,
        firestore: `connected (${ms}ms)`,
        version:   "3.2",
      });
    } catch (e) {
      res.status(500).json({ status: "error", message: e.message });
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// 8. SUPPORT CLIENT TELEGRAM — Gemini répond + audit admin
//
//  Flux :
//    Client envoie message au bot @kaffipay_support_bot
//    → Gemini analyse message + historique ordres client
//    → Gemini décide et répond au client
//    → Audit complet envoyé au bot admin
//
//  Setup webhook (une seule fois après déploiement) :
//    curl "https://api.telegram.org/botSUPPORT_TOKEN/setWebhook?url=URL_FONCTION"
// ══════════════════════════════════════════════════════════════════
exports.supportClient = onRequest(
  {
    region:         REGION,
    secrets:        [SUPPORT_BOT_TOKEN, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID],
    timeoutSeconds: 60,
  },
  async (req, res) => {
    // Toujours répondre 200 immédiatement à Telegram
    res.status(200).send("OK");

    try {
      const update = req.body || {};
      console.log("supportClient reçu:", JSON.stringify(update).substring(0, 300));

      const msg    = update.message || update.edited_message;
      if (!msg) { console.log("Pas de message dans l'update"); return; }

      const chatId    = msg.chat.id;
      const text      = (msg.text || "").trim();
      const fromUser  = msg.from || {};
      const firstName = fromUser.first_name || "Client";

      console.log(`Message de ${firstName} (${chatId}): "${text}"`);

      if (!text) return;

      const supportToken = SUPPORT_BOT_TOKEN.value();
      if (!supportToken) {
        console.error("SUPPORT_BOT_TOKEN vide — secret non configuré");
        return;
      }

      // ── Session client (sauvegarde numéro Waafi si fourni) ─────
      const sessionRef  = db.collection("support_sessions").doc(String(chatId));
      const sessionSnap = await sessionRef.get();
      const session     = sessionSnap.exists ? sessionSnap.data() : {};

      const cleanText = text.replace(/\s/g, "");
      const isPhone   = /^(77|78|70|71|21)\d{6}$/.test(cleanText);
      if (isPhone && !session.phone) {
        await sessionRef.set({ phone: cleanText, chatId, startedAt: FieldValue.serverTimestamp() }, { merge: true });
        session.phone = cleanText;
        console.log(`Numéro sauvegardé pour ${chatId}: ${cleanText}`);
      }

      // ── Historique ordres (si numéro connu) ─────────────────────
      let orders = [];
      if (session.phone) {
        try {
          const ordersSnap = await db.collection("orders")
            .where("numeroPayment", "==", session.phone)
            .orderBy("ts", "desc")
            .limit(10)
            .get();
          orders = ordersSnap.docs.map((d) => {
            const o = d.data();
            return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status} | ${o.flagRaison || ""}`;
          });
        } catch (e) {
          console.warn("Index manquant, fallback sans orderBy:", e.message);
          try {
            const ordersSnap = await db.collection("orders")
              .where("numeroPayment", "==", session.phone)
              .limit(10)
              .get();
            orders = ordersSnap.docs.map((d) => {
              const o = d.data();
              return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status} | ${o.flagRaison || ""}`;
            });
          } catch (e2) {
            console.warn("Fallback ordres échoué:", e2.message);
          }
        }
      }

      // ── Appel Gemini ────────────────────────────────────────────
      let geminiDecision = {
        reponse_client:   "Je n'ai pas pu traiter votre demande. Réessayez dans quelques instants.",
        decision:         "escalade",
        action_prise:     "Aucune action automatique",
        niveau_urgence:   "faible",
        resume_audit:     "Erreur Gemini",
      };

      try {
        const model  = getGemini();
        const result = await model.generateContent({
          contents: [{
            role: "user",
            parts: [{ text: `
Tu es l'assistant support de Kaffi-Pay (Djibouti) — plateforme d'échange 1xBet ↔ Waafi.
Tu réponds directement à ce que le client demande. Réponds UNIQUEMENT en JSON valide.

Message client : "${text}"
${session.phone ? `N° Waafi client : ${session.phone}` : "N° Waafi : non renseigné"}

Historique ordres :
${orders.length ? orders.join("\n") : "Aucun ordre trouvé"}

Règles :
- Réponds directement à la question, pas de blabla inutile
- Si le client mentionne un problème de paiement et le numéro Waafi n'est pas connu → demande son numéro Waafi
- Si numéro Waafi connu mais pas de numéro d'ordre → demande le numéro d'ordre (ex: #KFP-001)
- Si ordre rejeté "Paiement non reçu" et client dit avoir payé → demande le Transfer ID Waafi
- Si Transfer ID fourni → décision "escalade", admin vérifiera manuellement
- Si fraude confirmée → refuser poliment sans détails techniques
- Répondre en français, ton professionnel et concis
- Signer chaque réponse : "\n\n— <i>Support Kaffi-Pay</i>"

{
  "reponse_client": "message à envoyer au client (HTML Telegram ok)",
  "decision": "résolu" | "escalade" | "info_manquante" | "fraude_signalée",
  "action_prise": "description courte",
  "niveau_urgence": "faible" | "moyen" | "élevé",
  "resume_audit": "résumé pour l'admin en 1-2 phrases"
}
` }]
          }]
        });
        geminiDecision = JSON.parse(aiText(result).replace(/```json|```/g, "").trim());
        console.log("Gemini décision:", geminiDecision.decision);
      } catch (e) {
        console.error("Gemini support error:", e.message);
      }

      // ── Réponse au client ───────────────────────────────────────
      await sendTelegramToBot(supportToken, chatId, geminiDecision.reponse_client);

      // Sauvegarder l'interaction
      await db.collection("support_sessions").doc(String(chatId))
        .collection("messages").add({
          text,
          decision:      geminiDecision.decision,
          action:        geminiDecision.action_prise,
          urgence:       geminiDecision.niveau_urgence,
          ts:            FieldValue.serverTimestamp(),
        });

      // ── Audit Telegram admin ────────────────────────────────────
      const urgenceEmoji = {
        "faible":  "🟢",
        "moyen":   "🟡",
        "élevé":   "🔴",
      }[geminiDecision.niveau_urgence] || "⚪";

      const decisionEmoji = {
        "résolu":         "✅",
        "escalade":       "🆘",
        "info_manquante": "❓",
        "fraude_signalée":"🚨",
      }[geminiDecision.decision] || "ℹ️";

      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `${urgenceEmoji} <b>Support Client</b> ${decisionEmoji}\n\n` +
        `👤 ${firstName} | <code>${session.phone}</code>\n` +
        `💬 <i>"${text.substring(0, 100)}"</i>\n\n` +
        `🤖 <b>Décision Gemini :</b> ${geminiDecision.decision.toUpperCase()}\n` +
        `⚡ Action : ${geminiDecision.action_prise}\n\n` +
        `📋 ${geminiDecision.resume_audit}\n\n` +
        (geminiDecision.decision === "escalade"
          ? `⚠️ <b>Intervention manuelle requise.</b>` : "")
      );

    } catch (e) {
      console.error("supportClient crash:", e.message, e.stack);
    }
  }
);
