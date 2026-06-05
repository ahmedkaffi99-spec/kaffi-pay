/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║      KAFFI PAY — CLOUD FUNCTIONS v3.1 (Genkit + Firebase)   ║
 * ║  • Genkit flows nommés → visibles dans Firebase Console     ║
 * ║  • Télémétrie Firebase → traces + logs dans le dashboard    ║
 * ║  • Output structuré Zod (fraude, admin, vision)             ║
 * ║  • Auto-confirmation SMS Waafi → MacroDroid 1xBet           ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest }                    = require("firebase-functions/v2/https");
const { defineSecret }                         = require("firebase-functions/params");
const { initializeApp }                        = require("firebase-admin/app");
const { getFirestore, FieldValue }             = require("firebase-admin/firestore");
const { genkit, z }                            = require("genkit");
const { googleAI, gemini20Flash }              = require("@genkit-ai/googleai");
const { enableFirebaseTelemetry }              = require("@genkit-ai/firebase");

// ── Télémétrie Firebase — active les traces dans Firebase Console → Genkit
enableFirebaseTelemetry();

initializeApp();
const db = getFirestore();

// ── Secret Firebase ────────────────────────────────────────────
const GEMINI_KEY = defineSecret("GEMINI_KEY");

// ── Instance Genkit + Flows — initialisés au premier appel ────
let _ai    = null;
let _flows = null;

function getFlows() {
  if (_ai && _flows) return _flows;

  _ai = genkit({
    plugins: [googleAI({ apiKey: GEMINI_KEY.value() })],
    model: gemini20Flash,
  });

  // ── Schemas Zod ───────────────────────────────────────────────
  const FraudeSchema = z.object({
    score_fraude: z.number().describe("Score de fraude 0-100"),
    risque:       z.enum(["faible", "moyen", "élevé"]),
    raisons:      z.array(z.string()),
    action:       z.enum(["valider", "vérifier", "rejeter"]),
  });

  const AnalyseAdminSchema = z.object({
    resume:            z.string(),
    alerte:            z.string().nullable(),
    conseil:           z.string(),
    prediction_demain: z.number(),
    heure_pic:         z.string(),
    score_sante:       z.number(),
  });

  const PreuveSchema = z.object({
    est_valide:                 z.boolean(),
    transfer_id_detecte:        z.string().nullable(),
    montant_detecte:            z.number().nullable(),
    expediteur_detecte:         z.string().nullable(),
    correspondance_montant:     z.boolean(),
    correspondance_transfer_id: z.boolean(),
    confiance:                  z.number(),
    raison:                     z.string(),
  });

  const InputFraudeSchema = z.object({
    type:          z.string(),
    montant:       z.number(),
    transferId:    z.string(),
    numeroPayment: z.string(),
    heure:         z.number(),
  });

  const InputAdminSchema = z.object({
    confirmes: z.number(),
    attente:   z.number(),
    rejetes:   z.number(),
    volume:    z.number(),
    taux:      z.number(),
    moyenne:   z.number(),
    derniersTx: z.array(z.object({
      type:    z.string(),
      montant: z.number(),
      status:  z.string(),
      date:    z.string(),
    })),
  });

  const InputPreuveSchema = z.object({
    imageBase64:         z.string(),
    mimeType:            z.string(),
    montantAttendu:      z.number(),
    transferIdAttendu:   z.string(),
  });

  // ── Flow 1 : Analyse Fraude ────────────────────────────────────
  const analyseFraude = _ai.defineFlow(
    {
      name:         "analyseFraude",
      inputSchema:  InputFraudeSchema,
      outputSchema: FraudeSchema,
    },
    async (input) => {
      const { output } = await _ai.generate({
        model: gemini20Flash,
        prompt: `Tu es un système de détection de fraude pour Kaffi Pay (Djibouti, échange 1xBet↔Waafi).

Transaction à analyser :
- Type: ${input.type}
- Montant: ${input.montant} DJF
- Transfer ID: ${input.transferId || "?"}
- N° Expéditeur: ${input.numeroPayment || "?"}
- Heure soumission: ${input.heure}h

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
  );

  // ── Flow 2 : Analyse Admin ─────────────────────────────────────
  const analyseAdmin = _ai.defineFlow(
    {
      name:         "analyseAdmin",
      inputSchema:  InputAdminSchema,
      outputSchema: AnalyseAdminSchema,
    },
    async (input) => {
      const { output } = await _ai.generate({
        model: gemini20Flash,
        prompt: `Tu es l'assistant IA de Kaffi Pay (Djibouti, plateforme 1xBet↔Waafi).

Données des 100 dernières transactions :
- Confirmées: ${input.confirmes} — Volume: ${input.volume.toLocaleString()} DJF
- En attente: ${input.attente}
- Rejetées: ${input.rejetes}
- Taux confirmation: ${input.taux}%
- Montant moyen: ${input.moyenne} DJF

5 dernières transactions :
${input.derniersTx.map((t) => `• ${t.type} ${t.montant} DJF — ${t.status} — ${t.date}`).join("\n")}

Donne un résumé, une alerte si nécessaire, un conseil et des prédictions.`,
        output: { schema: AnalyseAdminSchema },
      });
      return output;
    }
  );

  // ── Flow 3 : Vérification Preuve (Vision) ─────────────────────
  const verifPreuve = _ai.defineFlow(
    {
      name:         "verifPreuve",
      inputSchema:  InputPreuveSchema,
      outputSchema: PreuveSchema,
    },
    async (input) => {
      const { output } = await _ai.generate({
        model: gemini20Flash,
        prompt: [
          {
            text: `Tu vérifies une capture d'écran de paiement Waafi pour Kaffi Pay (Djibouti).

Montant attendu: ${input.montantAttendu} DJF
Transfer ID attendu: ${input.transferIdAttendu}

Analyse l'image et vérifie si le paiement correspond exactement.`,
          },
          {
            media: { url: `data:${input.mimeType};base64,${input.imageBase64}` },
          },
        ],
        output: { schema: PreuveSchema },
      });
      return output;
    }
  );

  _flows = { analyseFraude, analyseAdmin, verifPreuve };
  return _flows;
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
    const { analyseFraude } = getFlows();
    let fraud = { score_fraude: 0, risque: "faible", raisons: [], action: "valider" };
    try {
      fraud = await analyseFraude({
        type:          tx.type || "?",
        montant:       Number(tx.montant || 0),
        transferId:    transferId,
        numeroPayment: tx.numeroPayment || "",
        heure:         new Date().getHours(),
      });
    } catch (e) {
      console.error("[Genkit] analyseFraude error:", e.message);
    }

    await db.collection("orders").doc(docId).update({
      ia_score_fraude: fraud.score_fraude,
      ia_risque:       fraud.risque,
      ia_raisons:      fraud.raisons,
      ia_action:       fraud.action,
      ia_analysedAt:   FieldValue.serverTimestamp(),
    });

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
    console.log(`[Notification] ${tel} → ${after.status}: ${msg.substring(0, 60)}`);
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
    const moyenne   = confirmes.length ? Math.round(volume / confirmes.length) : 0;

    const { analyseAdmin } = getFlows();
    try {
      const data = await analyseAdmin({
        confirmes: confirmes.length,
        attente:   attente.length,
        rejetes:   rejetes.length,
        volume,
        taux,
        moyenne,
        derniersTx: txs.slice(0, 5).map((t) => ({
          type:    t.type || "?",
          montant: Number(t.montant || 0),
          status:  t.status || "?",
          date:    t.date || "?",
        })),
      });
      return {
        success: true,
        data,
        stats: { confirmes: confirmes.length, attente: attente.length, rejetes: rejetes.length, volume },
      };
    } catch (e) {
      console.error("[Genkit] analyseAdmin error:", e.message);
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

    const { verifPreuve } = getFlows();
    try {
      const parsed = await verifPreuve({
        imageBase64,
        mimeType:          mimeType || "image/jpeg",
        montantAttendu:    Number(montantAttendu || 0),
        transferIdAttendu: transferIdAttendu || "",
      });

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
      console.error("[Genkit] verifPreuve error:", e.message);
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

// ══════════════════════════════════════════════════════════════
// 6. ENDPOINT HTTP — MacroDroid envoie SMS ici
// ══════════════════════════════════════════════════════════════
// MacroDroid appelle : POST https://europe-west1-kaffi-pay.cloudfunctions.net/smsWebhook
// Body JSON : { secret, notification, not_title }
exports.smsWebhook = onRequest(
  { region: "europe-west1", cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Méthode non autorisée" });
      return;
    }

    const { secret, notification, not_title } = req.body;

    // Vérifier secret
    if (secret !== "f9f943cda999ac6771f5c600881b4f8aae2cf3af71dd86c2") {
      console.warn("[smsWebhook] Secret invalide");
      res.status(401).json({ error: "Secret invalide" });
      return;
    }

    if (!notification) {
      res.status(400).json({ error: "Champ 'notification' requis" });
      return;
    }

    // Écrire dans Firestore → déclenche autoConfirmation automatiquement
    const docRef = await db.collection("waafi_notifications").add({
      notification,
      not_title:  not_title || "Waafi SMS",
      source:     "macrodroid_http",
      secret,
      createdAt:  FieldValue.serverTimestamp(),
      status:     "nouveau",
    });

    console.log(`[smsWebhook] SMS reçu → doc ${docRef.id}`);
    res.json({ success: true, docId: docRef.id });
  }
);

// ══════════════════════════════════════════════════════════════
// 7. CALLBACK MacroDroid → Résultat recharge 1xBet
// ══════════════════════════════════════════════════════════════
// MacroDroid appelle après succès ou échec de la recharge :
// POST https://europe-west1-kaffi-pay.cloudfunctions.net/rechargeCallback
// Body : { secret, ref, statut, id1xbet, montant, message }
exports.rechargeCallback = onRequest(
  { region: "europe-west1", cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Méthode non autorisée" });
      return;
    }

    const { secret, ref, statut, id1xbet, montant, message } = req.body;

    // Vérifier secret
    if (secret !== "f9f943cda999ac6771f5c600881b4f8aae2cf3af71dd86c2") {
      res.status(401).json({ error: "Secret invalide" });
      return;
    }

    if (!ref || !statut) {
      res.status(400).json({ error: "Champs 'ref' et 'statut' requis" });
      return;
    }

    // Chercher l'ordre par ref
    const snap = await db.collection("orders")
      .where("orderId", "==", ref)
      .limit(1).get();

    if (snap.empty) {
      res.status(404).json({ error: `Ordre ${ref} non trouvé` });
      return;
    }

    const ordreDoc = snap.docs[0];
    const estSucces = statut === "succes" || statut === "success" || statut === "ok";

    // Mise à jour Firestore selon résultat
    await ordreDoc.ref.update({
      rechargeStatus:  estSucces ? "rechargé" : "erreur_recharge",
      rechargeAt:      FieldValue.serverTimestamp(),
      rechargeMessage: message || "",
      rechargeId1xbet: id1xbet || "",
      rechargeMontant: Number(montant || 0),
      // Statut final visible sur le site
      status: estSucces ? "Rechargé ✅" : "Erreur Recharge ❌",
    });

    console.log(`[rechargeCallback] Ordre ${ref} → ${estSucces ? "SUCCÈS" : "ÉCHEC"}: ${message}`);
    res.json({ success: true, ref, recharge: estSucces ? "ok" : "erreur" });
  }
);
