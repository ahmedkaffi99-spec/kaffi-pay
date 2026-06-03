/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           KAFFI PAY — CLOUD FUNCTIONS v2.1                  ║
 * ║  • Détection fraude & doublons (Gemini AI)                  ║
 * ║  • Validation automatique des ordres                        ║
 * ║  • Notification WhatsApp admin (alertes fraude only)        ║
 * ║  • WhatsApp Bot clients (Gemini)                            ║
 * ║  • Analyse admin Gemini (résumé, prédictions)               ║
 * ║  • Vérification preuves paiement (Gemini Vision)            ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest }                    = require("firebase-functions/v2/https");
const { defineSecret }                         = require("firebase-functions/params");
const { initializeApp }                        = require("firebase-admin/app");
const { getFirestore, FieldValue }             = require("firebase-admin/firestore");
const { GoogleGenerativeAI }                   = require("@google/generative-ai");

initializeApp();
const db = getFirestore();

// ── Secrets ───────────────────────────────────────────────────
const TWILIO_SID   = defineSecret("TWILIO_SID");
const TWILIO_TOKEN = defineSecret("TWILIO_TOKEN");
const TWILIO_FROM  = defineSecret("TWILIO_FROM");
const WHATSAPP_TO  = defineSecret("WHATSAPP_TO");  // votre numéro admin
const GEMINI_KEY   = defineSecret("GEMINI_KEY");

// ══════════════════════════════════════════════════════════════
// HELPER — Envoyer WhatsApp via Twilio
// ══════════════════════════════════════════════════════════════
async function sendWhatsApp(sid, token, from, to, message) {
  const fetch = (await import("node-fetch")).default;
  const url   = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body  = new URLSearchParams({
    From: `whatsapp:${from}`,
    To:   `whatsapp:${to}`,
    Body: message,
  });
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
    },
    body: body.toString(),
  });
}

function getGemini(key) {
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
}

// ══════════════════════════════════════════════════════════════
// 1. NOUVEL ORDRE → Fraude + Doublons + Alerte WhatsApp admin
// ══════════════════════════════════════════════════════════════
exports.onNouvelOrdre = onDocumentCreated(
  { document: "orders/{docId}", region: "europe-west1", secrets: [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, WHATSAPP_TO, GEMINI_KEY] },
  async (event) => {
    const tx        = event.data.data();
    const docId     = event.params.docId;
    const ref       = tx.orderId || tx.ref || docId;
    const transferId= tx.waafitranfertID || tx.hash || "";
    const model     = getGemini(GEMINI_KEY.value());

    // ── 1a. Détection doublons ─────────────────────────────────
    if (transferId) {
      const existing = await db.collection("orders")
        .where("waafitranfertID", "==", transferId)
        .where("__name__", "!=", docId)
        .limit(1).get();

      if (!existing.empty) {
        await db.collection("orders").doc(docId).update({
          status:     "Rejeté",
          flagRaison: "Doublon — Transfer ID déjà utilisé",
          flaggedAt:  FieldValue.serverTimestamp(),
        });

        // Alerte WhatsApp admin
        await sendWhatsApp(
          TWILIO_SID.value(), TWILIO_TOKEN.value(),
          TWILIO_FROM.value(), WHATSAPP_TO.value(),
          `🚨 *DOUBLON DÉTECTÉ*\nOrdre: ${ref}\nTransfer ID: ${transferId}\nMontant: ${tx.montant} DJF\n→ Rejeté automatiquement`
        );
        return;
      }
    }

    // ── 1b. Analyse fraude Gemini ──────────────────────────────
    const fraudPrompt = `
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
- Heure: ${new Date().getHours()}h

Règles : montant > 50000 = suspect, Transfer ID < 6 chiffres = invalide, numéro ne commence pas par 77 = suspect.
`;

    let fraud = { score_fraude: 0, risque: "faible", raisons: [], action: "valider" };
    try {
      const aiResp = await model.generateContent(fraudPrompt);
      const txt    = aiResp.response.text().replace(/```json|```/g, "").trim();
      fraud        = JSON.parse(txt);
    } catch (e) {
      console.error("Gemini fraud error:", e);
    }

    // Sauvegarder analyse IA
    await db.collection("orders").doc(docId).update({
      ia_score_fraude: fraud.score_fraude,
      ia_risque:       fraud.risque,
      ia_raisons:      fraud.raisons,
      ia_action:       fraud.action,
      ia_analysedAt:   FieldValue.serverTimestamp(),
    });

    // ── 1c. Rejet auto si fraude élevée ───────────────────────
    if (fraud.action === "rejeter" || fraud.risque === "élevé") {
      await db.collection("orders").doc(docId).update({
        status:     "Rejeté",
        flagRaison: "IA Fraude: " + fraud.raisons.join(", "),
      });

      await sendWhatsApp(
        TWILIO_SID.value(), TWILIO_TOKEN.value(),
        TWILIO_FROM.value(), WHATSAPP_TO.value(),
        `🤖 *FRAUDE DÉTECTÉE — IA*\nOrdre: ${ref}\nScore: ${fraud.score_fraude}/100\nRisque: ${fraud.risque.toUpperCase()}\nRaisons: ${fraud.raisons.join(" | ")}\n→ Rejeté automatiquement`
      );
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 2. ORDRE CONFIRMÉ → Notification WhatsApp client
// ══════════════════════════════════════════════════════════════
exports.onOrdreUpdated = onDocumentUpdated(
  { document: "transactions/{docId}", secrets: [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM] },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;

    const ref     = after.orderId || after.ref || event.params.docId;
    const montant = Number(after.montant || 0).toLocaleString();
    const tel     = after.waafiNumber || after.tel || after.numeroPayment || "";

    let msg = "";
    if (after.status === "Confirmé") {
      msg = `✅ *Kaffi Pay* — Ordre Confirmé !\n\nRéf: ${ref}\nMontant: ${montant} DJF\n\nVotre compte 1xBet a été crédité. Merci 🙏`;
    } else if (after.status === "Rejeté") {
      msg = `❌ *Kaffi Pay* — Ordre Rejeté\n\nRéf: ${ref}\n${after.flagRaison || ""}\n\nContactez le support WhatsApp pour aide.`;
    } else if (after.status === "Correction") {
      msg = `✏️ *Kaffi Pay* — Correction Requise\n\nRéf: ${ref}\n${after.correctionMsg || "Veuillez corriger votre ordre."}\n\nRépondez à ce message pour aide.`;
    } else if (after.status === "Argent Reçu") {
      msg = `💰 *Kaffi Pay* — Paiement Reçu !\n\nRéf: ${ref}\nMontant: ${montant} DJF\nCrédit en cours... quelques instants.`;
    }

    if (!msg || !tel) return;

    try {
      const clientTel = tel.startsWith("+") ? tel : `+253${tel}`;
      await sendWhatsApp(
        TWILIO_SID.value(), TWILIO_TOKEN.value(),
        TWILIO_FROM.value(), clientTel, msg
      );
    } catch (e) {
      console.warn("WhatsApp client error:", e.message);
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 3. WHATSAPP BOT — Réponses auto clients (Gemini)
// ══════════════════════════════════════════════════════════════
exports.whatsappWebhook = onRequest(
  { region: "europe-west1", secrets: [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, GEMINI_KEY] },
  async (req, res) => {
    const from  = req.body.From?.replace("whatsapp:", "") || "";
    const body  = req.body.Body?.trim() || "";
    const model = getGemini(GEMINI_KEY.value());

    // Chercher le dernier ordre du client
    const snap = await db.collection("orders")
      .where("numeroPayment", "==", from.replace("+253", ""))
      .orderBy("date", "desc")
      .limit(1).get();

    const dernierOrdre = snap.empty ? null : snap.docs[0].data();

    const prompt = `
Tu es l'assistant WhatsApp de Kaffi Pay (plateforme d'échange 1xBet↔Waafi à Djibouti).
Réponds en français, court et professionnel (max 3 phrases).
Ne divulgue JAMAIS d'infos sur d'autres clients.

Client: ${from}
Dernier ordre: ${dernierOrdre
  ? `${dernierOrdre.type} — ${dernierOrdre.montant} DJF — Statut: ${dernierOrdre.status}`
  : "Aucun ordre trouvé"}
Message: "${body}"
`;

    const aiResp = await model.generateContent(prompt);
    const reply  = aiResp.response.text().trim();

    await sendWhatsApp(
      TWILIO_SID.value(), TWILIO_TOKEN.value(),
      TWILIO_FROM.value(), from, reply
    );

    res.sendStatus(200);
  }
);

// ══════════════════════════════════════════════════════════════
// 4. GEMINI — Analyse admin (résumé + prédictions)
// ══════════════════════════════════════════════════════════════
exports.geminiAnalyseAdmin = onCall(
  { secrets: [GEMINI_KEY] },
  async () => {
    const snap = await db.collection("orders")
      .orderBy("date", "desc").limit(100).get();

    const txs       = snap.docs.map((d) => d.data());
    const confirmes = txs.filter((t) => t.status === "Confirmé");
    const attente   = txs.filter((t) => t.status === "En attente");
    const rejetes   = txs.filter((t) => t.status === "Rejeté");
    const volume    = confirmes.reduce((s, t) => s + Number(t.montant || 0), 0);
    const model     = getGemini(GEMINI_KEY.value());

    const prompt = `
Tu es l'assistant IA de Kaffi Pay (Djibouti).
Réponds UNIQUEMENT en JSON valide.

Données (100 dernières transactions) :
- Confirmées: ${confirmes.length} — Volume: ${volume.toLocaleString()} DJF
- En attente: ${attente.length}
- Rejetées: ${rejetes.length}
- Taux confirmation: ${txs.length ? Math.round((confirmes.length/txs.length)*100) : 0}%
- Montant moyen: ${confirmes.length ? Math.round(volume/confirmes.length) : 0} DJF

5 dernières:
${txs.slice(0, 5).map((t) => `• ${t.type} ${t.montant} DJF — ${t.status} — ${t.date}`).join("\n")}

{
  "resume": "résumé 2 phrases",
  "alerte": "problème urgent ou null",
  "conseil": "1 conseil",
  "prediction_demain": nombre_djf,
  "heure_pic": "ex: 14h-16h",
  "score_sante": 0-100
}
`;

    const aiResp = await model.generateContent(prompt);
    const txt    = aiResp.response.text().replace(/```json|```/g, "").trim();

    try {
      return { success: true, data: JSON.parse(txt), stats: { confirmes: confirmes.length, attente: attente.length, rejetes: rejetes.length, volume } };
    } catch {
      return { success: false, error: "Erreur parsing IA" };
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 5. GEMINI VISION — Vérification preuve paiement
// ══════════════════════════════════════════════════════════════
exports.geminiVerifPreuve = onCall(
  { secrets: [GEMINI_KEY] },
  async (request) => {
    const { imageBase64, mimeType, ordreRef, montantAttendu, transferIdAttendu } = request.data;
    if (!imageBase64) throw new Error("Image requise");

    const model = getGemini(GEMINI_KEY.value());

    const prompt = `
Tu vérifies une preuve de paiement Waafi pour Kaffi Pay (Djibouti).
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
}
`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: imageBase64, mimeType: mimeType || "image/jpeg" } },
    ]);

    const txt = result.response.text().replace(/```json|```/g, "").trim();
    try {
      const parsed = JSON.parse(txt);
      if (ordreRef) {
        const snap = await db.collection("orders")
          .where("orderId", "==", ordreRef).limit(1).get();
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

// ══════════════════════════════════════════════════════════════
// 6. AUTO-CONFIRMATION — SMS Waafi reçu → Ordre confirmé auto
// ══════════════════════════════════════════════════════════════
//
// Flux :
//   MacroDroid détecte SMS Waafi
//   → écrit dans Firestore collection "waafi_notifications"
//   → cette fonction se déclenche automatiquement
//   → cherche l'ordre correspondant (Transfer ID + Montant)
//   → confirme l'ordre si correspondance trouvée
//   → envoie WhatsApp au client
//
exports.autoConfirmation = onDocumentCreated(
  { document: "waafi_notifications/{docId}", region: "europe-west1", secrets: [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, WHATSAPP_TO] },
  async (event) => {
    const sms   = event.data.data();
    const docId = event.params.docId;

    // Ignorer si déjà traité
    if (sms.status === "traité" || sms.status === "en_cours") return;

    // ── Vérifier secret si présent ──────────────────────────────
    if (sms.secret && sms.secret !== "KaffiPay2026") {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "rejeté_secret_invalide",
      });
      return;
    }

    // Marquer comme "en cours" pour éviter double traitement
    await db.collection("waafi_notifications").doc(docId).update({
      status: "en_cours",
      processedAt: FieldValue.serverTimestamp(),
    });

    // ── Parser le SMS Waafi ────────────────────────────────────
    // Format SMS Waafi :
    // "Transfer-Id: 75973739, You have Received DJF 1000 from Client(77043065), Your Balance is: DJF XXXX."
    const notification = sms.notification || sms.not_body || "";
    const title        = sms.not_title || "";

    // Extraire Transfer ID
    const transferMatch = notification.match(/Transfer-?Id[:\s]+(\d+)/i);
    const transferId    = transferMatch ? transferMatch[1].trim() : null;

    // Extraire Montant
    const montantMatch = notification.match(/Received\s+DJF\s+([\d,]+)/i);
    const montantSMS   = montantMatch
      ? Number(montantMatch[1].replace(/,/g, ""))
      : null;

    // Extraire Numéro expéditeur
    const numMatch  = notification.match(/\((\d{8})\)/);
    const numClient = numMatch ? numMatch[1] : null;

    console.log(`SMS Waafi → TransferID: ${transferId}, Montant: ${montantSMS} DJF, N°: ${numClient}`);

    if (!transferId || !montantSMS) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:      "erreur_parsing",
        erreurMsg:   "Impossible d'extraire Transfer ID ou Montant du SMS",
      });
      return;
    }

    // ── Chercher l'ordre correspondant ────────────────────────
    // Stratégie 1 : par Transfer ID exact
    let ordreSnap = await db.collection("orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();

    // Stratégie 2 : par montant + numéro si Transfer ID pas trouvé
    if (ordreSnap.empty && numClient) {
      ordreSnap = await db.collection("orders")
        .where("numeroPayment", "==", numClient)
        .where("status", "==", "En attente")
        .limit(1).get();
    }

    // Stratégie 3 supprimée — trop risquée (faux positifs)

    if (ordreSnap.empty) {
      // Aucun ordre trouvé — alerter l'admin
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "non_matché",
        erreurMsg: `Aucun ordre en attente pour Transfer ID ${transferId} / ${montantSMS} DJF`,
      });

      try {
        await sendWhatsApp(
          TWILIO_SID.value(), TWILIO_TOKEN.value(),
          TWILIO_FROM.value(), WHATSAPP_TO.value(),
          `⚠️ *Kaffi Pay — Paiement Non Matché*\n\nTransfer ID: ${transferId}\nMontant: ${montantSMS} DJF\nExpéditeur: ${numClient || "?"}\n\nAucun ordre trouvé — vérifiez manuellement.`
        );
      } catch (e) { console.warn("WhatsApp error:", e.message); }
      return;
    }

    // ── Ordre trouvé → Confirmer ───────────────────────────────
    const ordreDoc  = ordreSnap.docs[0];
    const ordre     = ordreDoc.data();
    const ordreRef  = ordre.orderId || ordre.ref || ordreDoc.id;
    const montantOrdre = Number(ordre.montant || 0);

    // Vérification tolérance montant (±5 DJF pour arrondi)
    const diff = Math.abs(montantOrdre - montantSMS);
    if (diff > 5) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "montant_incorrect",
        erreurMsg: `Montant SMS (${montantSMS}) ≠ Montant ordre (${montantOrdre})`,
        ordreRef:  ordreRef,
      });

      try {
        await sendWhatsApp(
          TWILIO_SID.value(), TWILIO_TOKEN.value(),
          TWILIO_FROM.value(), WHATSAPP_TO.value(),
          `⚠️ *Kaffi Pay — Montant Incorrect*\n\nOrdre: ${ordreRef}\nMontant attendu: ${montantOrdre} DJF\nMontant reçu: ${montantSMS} DJF\nDifférence: ${diff} DJF\n\nVérifiez manuellement.`
        );
      } catch (e) { console.warn("WhatsApp error:", e.message); }
      return;
    }

    // ✅ Tout correspond → Confirmer automatiquement
    await ordreDoc.ref.update({
      status:          "Confirmé",
      confirmedAt:     FieldValue.serverTimestamp(),
      confirmedBy:     "auto_waafi_sms",
      waafitranfertID: transferId,
      montantRecu:     montantSMS,
    });

    // Marquer SMS comme traité
    await db.collection("waafi_notifications").doc(docId).update({
      status:   "traité",
      ordreRef: ordreRef,
    });

    // ── Déclencher webhook MacroDroid → Recharge 1xBet ──────────
    const id1xbet = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";
    if (id1xbet) {
      try {
        const fetch = (await import("node-fetch")).default;
        const webhookUrl = `https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet?secret=KaffiPay2026&id1xbet=${id1xbet}&montant=${montantSMS}&ref=${ordreRef}`;
        const resp = await fetch(webhookUrl, { signal: AbortSignal.timeout(10000) });
        await ordreDoc.ref.update({
          webhookStatus: resp.ok ? "ok" : "erreur_" + resp.status,
          webhookAt:     FieldValue.serverTimestamp(),
        });
      } catch (e) {
        await ordreDoc.ref.update({ webhookStatus: "erreur_timeout" });
      }
    }

    // WhatsApp client
    const tel = ordre.waafiNumber || ordre.tel || ordre.numeroPayment || numClient || "";
    if (tel) {
      try {
        const clientTel = tel.startsWith("+") ? tel : `+253${tel}`;
        await sendWhatsApp(
          TWILIO_SID.value(), TWILIO_TOKEN.value(),
          TWILIO_FROM.value(), clientTel,
          `✅ *Kaffi Pay — Ordre Confirmé !*\n\nRéf: ${ordreRef}\nMontant: ${montantSMS.toLocaleString()} DJF\n\nVotre compte 1xBet va être crédité dans quelques instants. Merci 🙏`
        );
      } catch (e) { console.warn("WhatsApp client error:", e.message); }
    }
  }
);
