/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         KAFFI PAY — CLOUD FUNCTIONS v3.0 (Genkit 100%)      ║
 * ║  • Genkit flows avec output structuré (Zod schemas)         ║
 * ║  • Détection fraude & doublons (Gemini 2.0 Flash)           ║
 * ║  • Validation automatique des ordres                        ║
 * ║  • Analyse admin (résumé, prédictions, score santé)         ║
 * ║  • Vérification preuves paiement (Gemini Vision)            ║
 * ║  • Auto-confirmation SMS Waafi → MacroDroid 1xBet           ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall }                               = require("firebase-functions/v2/https");
const { defineSecret }                         = require("firebase-functions/params");
const { initializeApp }                        = require("firebase-admin/app");
const { getFirestore, FieldValue }             = require("firebase-admin/firestore");
const { genkit, z }                            = require("genkit");
const { googleAI, gemini20Flash }              = require("@genkit-ai/googleai");

initializeApp();
const db = getFirestore();

// ── Secret Firebase ────────────────────────────────────────────
const GEMINI_KEY = defineSecret("GEMINI_KEY");

// ── Instance Genkit — initialisée au premier appel runtime ────
let _ai = null;
function getAI() {
  if (!_ai) {
    _ai = genkit({
      plugins: [googleAI({ apiKey: GEMINI_KEY.value() })],
      model: gemini20Flash,
    });
  }
  return _ai;
}

// ══════════════════════════════════════════════════════════════
// SCHEMAS ZOD — Output structuré garanti par Genkit
// ══════════════════════════════════════════════════════════════

const FraudeSchema = z.object({
  score_fraude: z.number().describe("Score de fraude de 0 à 100"),
  risque:       z.enum(["faible", "moyen", "élevé"]),
  raisons:      z.array(z.string()).describe("Liste des raisons du score"),
  action:       z.enum(["valider", "vérifier", "rejeter"]),
});

const AnalyseAdminSchema = z.object({
  resume:             z.string().describe("Résumé en 2 phrases"),
  alerte:             z.string().nullable().describe("Problème urgent ou null"),
  conseil:            z.string().describe("1 conseil actionnable"),
  prediction_demain:  z.number().describe("Volume prédit en DJF"),
  heure_pic:          z.string().describe("Heure de pointe ex: 14h-16h"),
  score_sante:        z.number().describe("Score santé de 0 à 100"),
});

const PreuveSchema = z.object({
  est_valide:                  z.boolean(),
  transfer_id_detecte:         z.string().nullable(),
  montant_detecte:             z.number().nullable(),
  expediteur_detecte:          z.string().nullable(),
  correspondance_montant:      z.boolean(),
  correspondance_transfer_id:  z.boolean(),
  confiance:                   z.number().describe("Niveau de confiance 0 à 100"),
  raison:                      z.string().describe("Explication courte"),
});

// ══════════════════════════════════════════════════════════════
// FLOWS GENKIT — Logique AI réutilisable et observable
// ══════════════════════════════════════════════════════════════

async function flowAnalyseFraude(ai, tx, transferId) {
  const { output } = await ai.generate({
    model: gemini20Flash,
    prompt: `Tu es un système de détection de fraude pour Kaffi Pay (Djibouti, échange 1xBet↔Waafi).

Transaction à analyser :
- Type: ${tx.type || "?"}
- Montant: ${tx.montant} DJF
- Transfer ID: ${transferId || "?"}
- N° Expéditeur: ${tx.numeroPayment || "?"}
- Heure soumission: ${new Date().getHours()}h

Règles strictes :
1. Montant > 50 000 DJF → suspect
2. Transfer ID < 6 chiffres → invalide
3. Numéro ne commence pas par 77 → suspect
4. Montant < 50 DJF → invalide
5. Soumission entre 00h et 05h → risque élevé`,
    output: { schema: FraudeSchema },
  });
  return output || { score_fraude: 0, risque: "faible", raisons: [], action: "valider" };
}

async function flowAnalyseAdmin(ai, stats, derniersTx) {
  const { output } = await ai.generate({
    model: gemini20Flash,
    prompt: `Tu es l'assistant IA de Kaffi Pay (Djibouti, plateforme d'échange 1xBet↔Waafi).

Données des 100 dernières transactions :
- Confirmées: ${stats.confirmes} — Volume: ${stats.volume.toLocaleString()} DJF
- En attente: ${stats.attente}
- Rejetées: ${stats.rejetes}
- Taux confirmation: ${stats.taux}%
- Montant moyen: ${stats.moyennne} DJF

5 dernières transactions :
${derniersTx.map((t) => `• ${t.type} ${t.montant} DJF — ${t.status} — ${t.date}`).join("\n")}

Analyse la situation et donne des insights actionnables.`,
    output: { schema: AnalyseAdminSchema },
  });
  return output;
}

async function flowVerifPreuve(ai, imageBase64, mimeType, montantAttendu, transferIdAttendu) {
  const { output } = await ai.generate({
    model: gemini20Flash,
    prompt: [
      {
        text: `Tu vérifies une capture d'écran de paiement Waafi pour Kaffi Pay (Djibouti).

Montant attendu: ${montantAttendu} DJF
Transfer ID attendu: ${transferIdAttendu}

Analyse l'image et vérifie si le paiement correspond.`,
      },
      {
        media: { url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` },
      },
    ],
    output: { schema: PreuveSchema },
  });
  return output;
}

// ══════════════════════════════════════════════════════════════
// 1. NOUVEL ORDRE → Fraude + Doublons
// ══════════════════════════════════════════════════════════════
exports.onNouvelOrdre = onDocumentCreated(
  { document: "orders/{docId}", region: "europe-west1", secrets: [GEMINI_KEY] },
  async (event) => {
    const tx         = event.data.data();
    const docId      = event.params.docId;
    const transferId = tx.waafitranfertID || tx.hash || "";

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
        return;
      }
    }

    // ── 1b. Flow Genkit — Analyse fraude ──────────────────────
    const ai = getAI();
    let fraud = { score_fraude: 0, risque: "faible", raisons: [], action: "valider" };
    try {
      fraud = await flowAnalyseFraude(ai, tx, transferId);
    } catch (e) {
      console.error("[Genkit] flowAnalyseFraude error:", e.message);
    }

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
        flagRaison: "IA Fraude: " + (fraud.raisons || []).join(", "),
      });
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 2. ORDRE MODIFIÉ → Notification statut client
// ══════════════════════════════════════════════════════════════
exports.onOrdreUpdated = onDocumentUpdated(
  { document: "transactions/{docId}", secrets: [] },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;

    const ref     = after.orderId || after.ref || event.params.docId;
    const montant = Number(after.montant || 0).toLocaleString();
    const tel     = after.waafiNumber || after.tel || after.numeroPayment || "";

    let msg = "";
    if (after.status === "Confirmé") {
      msg = `✅ *Kaffi-Pay* — Ordre Confirmé !\n\nRéf: ${ref}\nMontant: ${montant} DJF\n\nVotre compte 1xBet a été crédité. Merci 🙏`;
    } else if (after.status === "Rejeté") {
      msg = `❌ *Kaffi-Pay* — Ordre Rejeté\n\nRéf: ${ref}\n${after.flagRaison || ""}\n\nContactez le support pour aide.`;
    } else if (after.status === "Correction") {
      msg = `✏️ *Kaffi-Pay* — Correction Requise\n\nRéf: ${ref}\n${after.correctionMsg || "Veuillez corriger votre ordre."}`;
    } else if (after.status === "Argent Reçu") {
      msg = `💰 *Kaffi-Pay* — Paiement Reçu !\n\nRéf: ${ref}\nMontant: ${montant} DJF\nCrédit en cours...`;
    }

    if (!msg || !tel) return;
    console.log(`[Notification] ${tel} → ${after.status}`);
  }
);

// ══════════════════════════════════════════════════════════════
// 3. GENKIT FLOW — Analyse admin (résumé + prédictions)
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
    const taux      = txs.length ? Math.round((confirmes.length / txs.length) * 100) : 0;
    const moyennne  = confirmes.length ? Math.round(volume / confirmes.length) : 0;

    const ai = getAI();
    try {
      const data = await flowAnalyseAdmin(
        ai,
        { confirmes: confirmes.length, attente: attente.length, rejetes: rejetes.length, volume, taux, moyennne },
        txs.slice(0, 5)
      );
      return {
        success: true,
        data,
        stats: { confirmes: confirmes.length, attente: attente.length, rejetes: rejetes.length, volume },
      };
    } catch (e) {
      console.error("[Genkit] flowAnalyseAdmin error:", e.message);
      return { success: false, error: "Erreur analyse IA" };
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 4. GENKIT VISION — Vérification preuve paiement (image)
// ══════════════════════════════════════════════════════════════
exports.geminiVerifPreuve = onCall(
  { secrets: [GEMINI_KEY] },
  async (request) => {
    const { imageBase64, mimeType, ordreRef, montantAttendu, transferIdAttendu } = request.data;
    if (!imageBase64) throw new Error("Image requise");

    const ai = getAI();
    try {
      const parsed = await flowVerifPreuve(ai, imageBase64, mimeType, montantAttendu, transferIdAttendu);

      if (ordreRef && parsed) {
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
    } catch (e) {
      console.error("[Genkit] flowVerifPreuve error:", e.message);
      return { success: false, error: "Impossible d'analyser l'image" };
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 5. AUTO-CONFIRMATION — SMS Waafi → Ordre confirmé → 1xBet
// ══════════════════════════════════════════════════════════════
exports.autoConfirmation = onDocumentCreated(
  { document: "waafi_notifications/{docId}", region: "europe-west1", secrets: [] },
  async (event) => {
    const sms   = event.data.data();
    const docId = event.params.docId;

    if (sms.status === "traité" || sms.status === "en_cours") return;

    // ── Vérifier secret ────────────────────────────────────────
    if (sms.secret && sms.secret !== "f9f943cda999ac6771f5c600881b4f8aae2cf3af71dd86c2") {
      await db.collection("waafi_notifications").doc(docId).update({ status: "rejeté_secret_invalide" });
      return;
    }

    await db.collection("waafi_notifications").doc(docId).update({
      status:      "en_cours",
      processedAt: FieldValue.serverTimestamp(),
    });

    // ── Parser SMS Waafi ───────────────────────────────────────
    const notification = sms.notification || sms.not_body || "";

    const transferMatch = notification.match(/Transfer-?Id[:\s]+(\d+)/i);
    const transferId    = transferMatch ? transferMatch[1].trim() : null;

    const montantMatch = notification.match(/Received\s+DJF\s+([\d,]+)/i);
    const montantSMS   = montantMatch ? Number(montantMatch[1].replace(/,/g, "")) : null;

    const numMatch  = notification.match(/\((\d{8})\)/);
    const numClient = numMatch ? numMatch[1] : null;

    console.log(`[AutoConfirm] TransferID: ${transferId}, Montant: ${montantSMS} DJF, N°: ${numClient}`);

    if (!transferId || !montantSMS) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "erreur_parsing",
        erreurMsg: "Impossible d'extraire Transfer ID ou Montant du SMS",
      });
      return;
    }

    // ── Chercher l'ordre correspondant ────────────────────────
    let ordreSnap = await db.collection("orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();

    if (ordreSnap.empty && numClient) {
      ordreSnap = await db.collection("orders")
        .where("numeroPayment", "==", numClient)
        .where("status", "==", "En attente")
        .limit(1).get();
    }

    if (ordreSnap.empty) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "non_matché",
        erreurMsg: `Aucun ordre en attente pour Transfer ID ${transferId} / ${montantSMS} DJF`,
      });
      return;
    }

    // ── Vérifier montant (±5 DJF tolérance) ──────────────────
    const ordreDoc     = ordreSnap.docs[0];
    const ordre        = ordreDoc.data();
    const ordreRef     = ordre.orderId || ordre.ref || ordreDoc.id;
    const montantOrdre = Number(ordre.montant || 0);

    if (Math.abs(montantOrdre - montantSMS) > 5) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "montant_incorrect",
        erreurMsg: `Montant SMS (${montantSMS}) ≠ Montant ordre (${montantOrdre})`,
        ordreRef,
      });
      return;
    }

    // ✅ Confirmer automatiquement ─────────────────────────────
    await ordreDoc.ref.update({
      status:          "Confirmé",
      confirmedAt:     FieldValue.serverTimestamp(),
      confirmedBy:     "auto_waafi_sms",
      waafitranfertID: transferId,
      montantRecu:     montantSMS,
    });

    await db.collection("waafi_notifications").doc(docId).update({
      status:   "traité",
      ordreRef,
    });

    // ── Déclencher MacroDroid → Recharge 1xBet ────────────────
    const id1xbet = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";
    if (id1xbet) {
      try {
        const webhookUrl = `https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet?secret=f9f943cda999ac6771f5c600881b4f8aae2cf3af71dd86c2&id1xbet=${id1xbet}&montant=${montantSMS}&ref=${ordreRef}`;
        const resp = await fetch(webhookUrl, { signal: AbortSignal.timeout(10000) });
        await ordreDoc.ref.update({
          webhookStatus: resp.ok ? "ok" : "erreur_" + resp.status,
          webhookAt:     FieldValue.serverTimestamp(),
        });
        console.log(`[MacroDroid] webhook ${resp.ok ? "OK" : "ERREUR " + resp.status}`);
      } catch (e) {
        await ordreDoc.ref.update({ webhookStatus: "erreur_timeout" });
        console.error("[MacroDroid] timeout:", e.message);
      }
    }
  }
);
