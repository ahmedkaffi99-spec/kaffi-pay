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
const { onSchedule }                           = require("firebase-functions/v2/scheduler");
const { defineSecret }                         = require("firebase-functions/params");
const { initializeApp }                        = require("firebase-admin/app");
const { getFirestore, FieldValue }             = require("firebase-admin/firestore");
const { genkit, z }                            = require("genkit");
const { googleAI, gemini20Flash }              = require("@genkit-ai/googleai");

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
4. Montant < 50 DJF → invalide`,
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
  { document: "orders/{docId}", region: "europe-west1", secrets: [GEMINI_KEY], minInstances: 1, concurrency: 80 },
  async (event) => {
    const tx         = event.data.data();
    const docId      = event.params.docId;
    const transferId = tx.waafitranfertID || tx.hash || "";

    // ── 1a+1b. Doublon + Fraude lancés en parallèle ───────────
    const { analyseFraude } = getFlows();

    const [existingSnap, fraud] = await Promise.all([
      transferId
        ? db.collection("orders").where("waafitranfertID","==",transferId).where("__name__","!=",docId).limit(1).get()
        : Promise.resolve({ empty: true }),
      analyseFraude({
        type:          tx.type || "?",
        montant:       Number(tx.montant || 0),
        transferId:    transferId,
        numeroPayment: tx.numeroPayment || "",
        heure:         new Date().getHours(),
      }).catch(() => ({ score_fraude:0, risque:"faible", raisons:[], action:"valider" })),
    ]);

    if (!existingSnap.empty) {
      await db.collection("orders").doc(docId).update({
        status:"Rejeté", flagRaison:"Doublon — Transfer ID déjà utilisé", flaggedAt:FieldValue.serverTimestamp(),
      });
      return;
    }

    const updates = { ia_score_fraude:fraud.score_fraude, ia_risque:fraud.risque, ia_raisons:fraud.raisons, ia_action:fraud.action, ia_analysedAt:FieldValue.serverTimestamp() };
    if (fraud.action === "rejeter" || fraud.risque === "élevé") {
      updates.status     = "Rejeté";
      updates.flagRaison = "IA Fraude: " + (fraud.raisons||[]).join(", ");
      await db.collection("orders").doc(docId).update(updates);
      return;
    }
    await db.collection("orders").doc(docId).update(updates);

    // ── 1c. Correspondance rétroactive — SMS déjà stocké avant l'ordre ──
    // Le client a envoyé l'argent Waafi avant de soumettre le formulaire.
    // On cherche un SMS non-matché des dernières 24h avec le même Transfer ID.
    if (!transferId) return;
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const smsSnap = await db.collection("waafi_notifications")
        .where("transferIdSMS", "==", transferId)
        .where("status", "==", "non_matché")
        .limit(5).get();

      for (const smsDoc of smsSnap.docs) {
        const smsData   = smsDoc.data();
        const createdAt = smsData.createdAt ? smsData.createdAt.toDate() : new Date(); // sans createdAt → traiter comme récent
        if (createdAt < cutoff) continue; // SMS trop ancien (> 24h)

        const montantSMS   = Number(smsData.montantSMS || 0);
        const montantOrdre = Number(tx.montant || 0);
        if (Math.abs(montantOrdre - montantSMS) > 5) continue; // montant incompatible

        // Vérifier expéditeur si disponible
        const numSMS    = smsData.numSMS || "";
        const numOrdre  = tx.numeroPayment || tx.waafiNumber || "";
        if (numSMS && numOrdre && numSMS !== numOrdre) continue; // expéditeur différent

        // ✅ Match rétroactif trouvé — confirmer l'ordre
        const ordreRef = tx.orderId || tx.ref || docId;
        const id1xbet  = tx.userId1xBet || tx.id1x || tx.idUser || "";

        await Promise.all([
          db.collection("orders").doc(docId).update({
            status:          "Confirmé",
            confirmedAt:     FieldValue.serverTimestamp(),
            confirmedBy:     "auto_waafi_retroactif",
            montantRecu:     montantSMS,
          }),
          smsDoc.ref.update({ status: "traité_retroactif", ordreRef }),
        ]);

        console.log(`[RetroMatch] ✅ Ordre ${ordreRef} confirmé via SMS ${smsDoc.id}`);

        if (id1xbet) {
          const url = `https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet?secret=f9f943cda999ac6771f5c600881b4f8aae2cf3af71dd86c2&id1xbet=${encodeURIComponent(id1xbet)}&montant=${montantSMS}&ref=${encodeURIComponent(ordreRef)}`;
          fetch(url, { signal: AbortSignal.timeout(8000) })
            .then(r => db.collection("orders").doc(docId).update({ webhookStatus: r.ok?"ok":"erreur_"+r.status, webhookAt: FieldValue.serverTimestamp() }))
            .catch(() => db.collection("orders").doc(docId).update({ webhookStatus:"erreur_timeout" }));
        }
        break; // Un seul match suffit
      }
    } catch(e) {
      console.error("[RetroMatch] erreur:", e.message);
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 2. ORDRE MODIFIÉ → Notification statut client
// ══════════════════════════════════════════════════════════════
exports.onOrdreUpdated = onDocumentUpdated(
  { document: "orders/{docId}", secrets: [] },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;
    const ref = after.orderId || after.ref || event.params.docId;
    console.log(`[onOrdreUpdated] Ordre ${ref} : ${before.status} → ${after.status}`);
  }
);

// ══════════════════════════════════════════════════════════════
// 3. GENKIT FLOW — Analyse admin (résumé + prédictions)
// ══════════════════════════════════════════════════════════════
exports.geminiAnalyseAdmin = onCall(
  { secrets: [GEMINI_KEY] },
  async () => {
    const snap = await db.collection("orders")
      .orderBy("createdAt", "desc").limit(100).get();

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
  { document: "waafi_notifications/{docId}", region: "europe-west1", secrets: [], minInstances: 1, concurrency: 80 },
  async (event) => {
    const sms   = event.data.data();
    const docId = event.params.docId;

    if (sms.status === "traité" || sms.status === "en_cours") return;

    await db.collection("waafi_notifications").doc(docId).update({
      status:      "en_cours",
      processedAt: FieldValue.serverTimestamp(),
      createdAt:   FieldValue.serverTimestamp(),
    });

    // ── Parser SMS Waafi ───────────────────────────────────────
    const notification = sms.notification || sms.notificationText || sms.not_body || sms.texte || sms.message || sms.sms_body || "";

    if (!notification || notification === "[notification]" || notification === "{notification}") {
      await db.collection("waafi_notifications").doc(docId).update({ status: "ignoré_format", createdAt: FieldValue.serverTimestamp() });
      return;
    }

    const isWaafi = notification.includes("Transfer-Id") || notification.includes("DJF") || notification.includes("Waafi");
    if (!isWaafi) {
      await db.collection("waafi_notifications").doc(docId).update({ status: "ignoré_non_waafi", createdAt: FieldValue.serverTimestamp() });
      return;
    }

    // ── Transfer ID ───────────────────────────────────────────────
    const transferMatch = notification.match(/Transfer-?Id[:\s]+(\d+)/i)
                       || notification.match(/Transfer\s*ID[:\s]+(\d+)/i)
                       || notification.match(/Ref[:\s#]+(\d{6,})/i);
    const transferId = transferMatch ? transferMatch[1].trim() : null;

    // ── Montant DJF — plusieurs formats Waafi ─────────────────────
    // "Received DJF 100" / "transferred DJF 1,000" / "DJF1,000"
    const montantMatch = notification.match(/(?:Received|transferred|reçu|sent)\s+DJF\s*([\d,. ]+)/i)
                      || notification.match(/DJF\s*([\d,. ]+)/i);
    const montantStr   = montantMatch ? montantMatch[1].trim().replace(/[\s,]/g, "") : null;
    const montantSMS   = montantStr ? Number(montantStr) : null;

    // ── Numéro expéditeur ─────────────────────────────────────────
    const numMatch  = notification.match(/\((\d{7,9})\)/);
    const numClient = numMatch ? numMatch[1] : null;

    console.log(`[AutoConfirm] SMS="${notification.substring(0,100)}" | TransferID=${transferId} | Montant=${montantSMS} | N°=${numClient}`);

    if (!transferId || !montantSMS) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:      "erreur_parsing",
        erreurMsg:   `Parsing échoué — TransferID=${transferId}, Montant=${montantSMS} | SMS: "${notification.substring(0,120)}"`,
        transferIdSMS: transferId || "non_extrait",
        montantSMS:  montantSMS || 0,
        createdAt:   FieldValue.serverTimestamp(),
      });
      return;
    }

    // ── Chercher l'ordre par Transfer ID — "En attente" d'abord ───
    let ordreSnap = await db.collection("orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();

    // ── Si pas trouvé en attente → chercher ordre auto-rejeté récent ─
    // L'auto-rejet arrive si le SMS MacroDroid est retardé > 10 min.
    // On réactive l'ordre si le SMS est valide et l'ordre < 30 min.
    if (ordreSnap.empty) {
      const cutoffRetro = new Date(Date.now() - 30 * 60 * 1000);
      const rejetSnap = await db.collection("orders")
        .where("waafitranfertID", "==", transferId)
        .where("rejetBy", "==", "auto_serveur")
        .limit(1).get();

      if (!rejetSnap.empty) {
        const ordreData = rejetSnap.docs[0].data();
        const createdAt = ordreData.createdAt ? ordreData.createdAt.toDate() : new Date(0);
        if (createdAt > cutoffRetro) {
          // Réactiver l'ordre rejeté par erreur
          ordreSnap = rejetSnap;
          console.log(`[AutoConfirm] ♻️ Ordre auto-rejeté réactivé : ${ordreData.orderId || rejetSnap.docs[0].id}`);
        }
      }
    }

    if (ordreSnap.empty) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:        "non_matché",
        erreurMsg:     `Aucun ordre soumis avec Transfer ID ${transferId}`,
        transferIdSMS: transferId,
        numSMS:        numClient,
        montantSMS,
        createdAt:     FieldValue.serverTimestamp(),
      });
      return;
    }

    const ordreDoc     = ordreSnap.docs[0];
    const ordre        = ordreDoc.data();
    const ordreRef     = ordre.orderId || ordre.ref || ordreDoc.id;
    const montantOrdre = Number(ordre.montant || 0);

    const numeroOrdre = ordre.numeroPayment || ordre.waafiNumber || "";
    if (numClient && numeroOrdre && numClient !== numeroOrdre) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "expediteur_mismatch",
        erreurMsg: `N° expéditeur SMS (${numClient}) ≠ N° ordre (${numeroOrdre}) — Transfer ID ${transferId}`,
        ordreRef,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    if (Math.abs(montantOrdre - montantSMS) > 5) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "montant_incorrect",
        erreurMsg: `Montant SMS (${montantSMS} DJF) ≠ Montant ordre (${montantOrdre} DJF)`,
        ordreRef,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    // ✅ 3/3 confirmé — Transfer ID + Montant + Numéro
    const id1xbet = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";
    await Promise.all([
      ordreDoc.ref.update({
        status:          "Confirmé",
        confirmedAt:     FieldValue.serverTimestamp(),
        confirmedBy:     "auto_waafi_sms",
        waafitranfertID: transferId,
        montantRecu:     montantSMS,
        rejetBy:         FieldValue.delete(),
        rejetRaison:     FieldValue.delete(),
      }),
      db.collection("waafi_notifications").doc(docId).update({
        status: "traité", ordreRef, createdAt: FieldValue.serverTimestamp(),
      }),
    ]);

    if (id1xbet) {
      const webhookUrl = `https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet?secret=f9f943cda999ac6771f5c600881b4f8aae2cf3af71dd86c2&id1xbet=${encodeURIComponent(id1xbet)}&montant=${montantSMS}&ref=${encodeURIComponent(ordreRef)}`;
      fetch(webhookUrl, { signal: AbortSignal.timeout(8000) })
        .then(r => ordreDoc.ref.update({ webhookStatus: r.ok ? "ok" : "erreur_"+r.status, webhookAt: FieldValue.serverTimestamp() }))
        .catch(() => ordreDoc.ref.update({ webhookStatus: "erreur_timeout" }));
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 6. AUTO-REJET SERVEUR — ordres En attente depuis > 20 min
// ══════════════════════════════════════════════════════════════
exports.autoRejetServeur = onSchedule(
  { schedule: "every 5 minutes", region: "europe-west1", timeoutSeconds: 60 },
  async () => {
    const cutoff = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes
    const snap   = await db.collection("orders")
      .where("status", "==", "En attente")
      .where("createdAt", "<", cutoff)
      .limit(20).get();

    if (snap.empty) return;

    const batch = db.batch();
    snap.docs.forEach(doc => {
      batch.update(doc.ref, {
        status:      "Rejeté",
        rejetRaison: "Paiement Waafi non reçu dans le délai imparti (20 minutes). Vérifiez votre Transfer ID et réessayez.",
        rejetedAt:   FieldValue.serverTimestamp(),
        rejetBy:     "auto_serveur",
      });
    });
    await batch.commit();
    console.log(`[AutoRejet] ${snap.size} ordre(s) rejeté(s) après 20 min sans paiement`);
  }
);

// ══════════════════════════════════════════════════════════════
// 7. ENDPOINT HTTP — MacroDroid envoie SMS ici
// Parse + Match + Confirme en une seule requête HTTP
// POST https://smswebhook-tqisrvjuka-ew.a.run.app
// Body : { notification: "texte SMS Waafi" }
// ══════════════════════════════════════════════════════════════
exports.smsWebhook = onRequest(
  { region: "europe-west1", cors: true, minInstances: 1, concurrency: 80 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Méthode non autorisée" });
      return;
    }

    // ── 1. Extraire le texte SMS (tous noms de champs MacroDroid) ──
    const body = req.body || {};
    const notification =
      body.notification || body.notificationText || body.not_body ||
      body.texte || body.message || body.sms_body || body.sms || body.text || "";

    if (!notification || notification === "[notification]" || notification === "{notification}") {
      res.status(400).json({ error: "SMS vide ou format invalide" });
      return;
    }

    // ── 2. Vérifier que c'est un SMS Waafi ────────────────────────
    const isWaafi = /Transfer-?Id|DJF|Waafi|WAAFI/i.test(notification);
    if (!isWaafi) {
      await db.collection("waafi_notifications").add({
        notification, source: "macrodroid_http",
        status: "ignoré_non_waafi", createdAt: FieldValue.serverTimestamp(),
      });
      res.json({ success: true, status: "ignoré_non_waafi" });
      return;
    }

    // ── 3. Parser le SMS ──────────────────────────────────────────
    const transferMatch = notification.match(/Transfer-?Id[:\s]+(\d+)/i)
                       || notification.match(/Transfer\s*ID[:\s]+(\d+)/i);
    const transferId = transferMatch ? transferMatch[1].trim() : null;

    const montantMatch = notification.match(/(?:Received|transferred|reçu|sent)\s+DJF\s*([\d,. ]+)/i)
                      || notification.match(/DJF\s*([\d,. ]+)/i);
    const montantStr = montantMatch ? montantMatch[1].trim().replace(/[\s,]/g, "") : null;
    const montantSMS = montantStr ? Number(montantStr) : null;

    const numMatch  = notification.match(/\((\d{7,9})\)/);
    const numClient = numMatch ? numMatch[1] : null;

    console.log(`[smsWebhook] SMS reçu | TransferID=${transferId} | Montant=${montantSMS} | N°=${numClient}`);

    // ── 4. Sauvegarder dans waafi_notifications ───────────────────
    const docRef = await db.collection("waafi_notifications").add({
      notification,
      not_title:     body.not_title || "Waafi SMS",
      source:        "macrodroid_http",
      transferIdSMS: transferId || null,
      montantSMS:    montantSMS || null,
      numClient:     numClient  || null,
      createdAt:     FieldValue.serverTimestamp(),
      status:        "en_cours",
    });

    // ── 5. Valider le parsing ─────────────────────────────────────
    if (!transferId || !montantSMS) {
      await docRef.update({
        status:    "erreur_parsing",
        erreurMsg: `TransferID=${transferId} | Montant=${montantSMS} | SMS: "${notification.substring(0, 120)}"`,
      });
      res.status(200).json({ success: false, status: "erreur_parsing", docId: docRef.id });
      return;
    }

    // ── 6. Chercher l'ordre ───────────────────────────────────────
    let ordreSnap = await db.collection("orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();

    // Matching rétroactif — ordre auto-rejeté < 30 min
    if (ordreSnap.empty) {
      const cutoff   = new Date(Date.now() - 30 * 60 * 1000);
      const rejetSnap = await db.collection("orders")
        .where("waafitranfertID", "==", transferId)
        .where("rejetBy", "==", "auto_serveur")
        .limit(1).get();
      if (!rejetSnap.empty) {
        const d = rejetSnap.docs[0].data();
        const createdAt = d.createdAt ? d.createdAt.toDate() : new Date(0);
        if (createdAt > cutoff) {
          ordreSnap = rejetSnap;
          console.log(`[smsWebhook] ♻️ Ordre auto-rejeté réactivé : ${d.orderId || rejetSnap.docs[0].id}`);
        }
      }
    }

    if (ordreSnap.empty) {
      await docRef.update({ status: "non_matché", erreurMsg: `Aucun ordre avec Transfer ID ${transferId}`, transferIdSMS: transferId });
      res.json({ success: false, status: "non_matché", transferId, docId: docRef.id });
      return;
    }

    const ordreDoc     = ordreSnap.docs[0];
    const ordre        = ordreDoc.data();
    const ordreRef     = ordre.orderId || ordre.ref || ordreDoc.id;
    const montantOrdre = Number(ordre.montant || 0);
    const numeroOrdre  = ordre.numeroPayment || ordre.waafiNumber || "";

    // ── 7. Vérifier numéro expéditeur ────────────────────────────
    if (numClient && numeroOrdre && numClient !== numeroOrdre) {
      await docRef.update({
        status:    "expediteur_mismatch",
        ordreRef,
        erreurMsg: `N° SMS (${numClient}) ≠ N° ordre (${numeroOrdre})`,
      });
      res.json({ success: false, status: "expediteur_mismatch", docId: docRef.id });
      return;
    }

    // ── 8. Vérifier montant (±5 DJF) ─────────────────────────────
    if (Math.abs(montantOrdre - montantSMS) > 5) {
      await docRef.update({
        status:    "montant_incorrect",
        ordreRef,
        erreurMsg: `Montant SMS ${montantSMS} DJF ≠ Montant ordre ${montantOrdre} DJF`,
      });
      res.json({ success: false, status: "montant_incorrect", docId: docRef.id });
      return;
    }

    // ── 9. ✅ 3/3 — Confirmer l'ordre ────────────────────────────
    const id1xbet = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";
    await Promise.all([
      ordreDoc.ref.update({
        status:          "Confirmé",
        confirmedAt:     FieldValue.serverTimestamp(),
        confirmedBy:     "auto_waafi_sms",
        waafitranfertID: transferId,
        montantRecu:     montantSMS,
        rejetBy:         FieldValue.delete(),
        rejetRaison:     FieldValue.delete(),
      }),
      docRef.update({ status: "traité", ordreRef }),
    ]);
    console.log(`[smsWebhook] ✅ Ordre ${ordreRef} CONFIRMÉ — ${montantSMS} DJF`);

    // ── 10. Déclencher MacroDroid → recharge 1xBet ───────────────
    if (id1xbet) {
      const webhookUrl = `https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet?secret=f9f943cda999ac6771f5c600881b4f8aae2cf3af71dd86c2&id1xbet=${encodeURIComponent(id1xbet)}&montant=${montantSMS}&ref=${encodeURIComponent(ordreRef)}`;
      fetch(webhookUrl, { signal: AbortSignal.timeout(8000) })
        .then(r => ordreDoc.ref.update({ webhookStatus: r.ok ? "ok" : "erreur_" + r.status, webhookAt: FieldValue.serverTimestamp() }))
        .catch(() => ordreDoc.ref.update({ webhookStatus: "erreur_timeout" }));
    }

    res.json({ success: true, status: "confirmé", ordreRef, montantSMS, transferId, docId: docRef.id });
  }
);

// ══════════════════════════════════════════════════════════════
// 7. CALLBACK MacroDroid → Résultat recharge 1xBet
// ══════════════════════════════════════════════════════════════
// MacroDroid lit l'écran MobCash et envoie le texte brut ici.
// Gemini analyse le texte et décide succes ou echec.
// POST https://europe-west1-kaffi-pay.cloudfunctions.net/rechargeCallback
// Body : { ref, resultat, id1xbet, montant }
// resultat = "succes" | "echec" | "inconnu"  (détecté par MacroDroid localement)
exports.rechargeCallback = onRequest(
  { region: "europe-west1", cors: true, secrets: [GEMINI_KEY], minInstances: 1, concurrency: 80 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Méthode non autorisée" });
      return;
    }

    const { ref, resultat, id1xbet, montant } = req.body;

    if (!ref) {
      res.status(400).json({ error: "Champ 'ref' requis" });
      return;
    }

    // ── Déterminer succès/échec ───────────────────────────────
    // Priorité 1 : ecran (texte écran MobCash) → Gemini analyse
    // Priorité 2 : resultat ("succes"|"echec") → utilisation directe
    // MacroDroid peut envoyer l'un ou l'autre ou les deux
    const texteEcran = req.body.ecran || "";
    let estSucces = false;
    let analyseIA = { statut: "inconnu", raison: "Non déterminé", confiance: 0 };

    if (texteEcran) {
      // ── Gemini analyse le texte écran MobCash (méthode principale) ──
      try {
        getFlows();
        const { output } = await _ai.generate({
          model: gemini20Flash,
          prompt: `Tu analyses le résultat d'une recharge 1xBet via MobCash (Djibouti).

Texte lu sur l'écran après la recharge :
"""
${texteEcran}
"""

Succès : "avec succès", "déposé avec succès", "Vous avez déposé", "Dépôt", success, credited, completed
Échec : "Fonds insuffisants", "Rechargez votre compte", "actualisez la page", failed, error, insufficient`,
          output: {
            schema: z.object({
              statut:    z.enum(["succes", "echec", "inconnu"]),
              raison:    z.string(),
              confiance: z.number().describe("0-100"),
            }),
          },
        });
        if (output) { analyseIA = output; estSucces = output.statut === "succes"; }
      } catch (e) {
        console.error("[rechargeCallback] Gemini error:", e.message);
        // Fallback mots-clés si Gemini indisponible
        const txt = texteEcran.toLowerCase();
        estSucces = /avec succ|déposé avec|vous avez déposé|dépôt|success|credited|completed|deposited/.test(txt);
        analyseIA = { statut: estSucces ? "succes" : "echec", raison: "Mots-clés MobCash (Gemini indisponible)", confiance: 70 };
      }
    } else if (resultat === "succes") {
      // Pas de texte écran — MacroDroid a détecté localement
      estSucces = true;
      analyseIA = { statut: "succes", raison: "Détecté par MacroDroid", confiance: 90 };
    } else if (resultat === "echec") {
      estSucces = false;
      analyseIA = { statut: "echec", raison: "Détecté par MacroDroid — Fonds insuffisants", confiance: 90 };
    }

    // ── Chercher l'ordre par ref ──────────────────────────────
    const snap = await db.collection("orders")
      .where("orderId", "==", ref)
      .limit(1).get();

    if (snap.empty) {
      res.status(404).json({ error: `Ordre ${ref} non trouvé` });
      return;
    }

    const ordreDoc = snap.docs[0];
    const ordre    = ordreDoc.data();
    const retries  = Number(ordre.rechargeRetries || 0);

    // ── CAS 1 : Succès ────────────────────────────────────────
    if (estSucces) {
      await ordreDoc.ref.update({
        status:             "Rechargé ✅",
        rechargeStatus:     "rechargé",
        rechargeAt:         FieldValue.serverTimestamp(),
        rechargeMessage:    resultat === "succes" ? "Recharge confirmée par MacroDroid" : (req.body.ecran || "Recharge effectuée"),
        rechargeId1xbet:    id1xbet || ordre.userId1xBet || "",
        rechargeMontant:    Number(montant || ordre.montant || 0),
        rechargeRetries:    retries,
        ia_ecran_statut:    analyseIA.statut,
        ia_ecran_raison:    analyseIA.raison,
        ia_ecran_confiance: analyseIA.confiance,
      });
      await db.collection("callbacks").add({
        ref, id1xbet: id1xbet || ordre.userId1xBet || "", montant: montant || ordre.montant || "",
        resultat: "succes", ia: analyseIA, recharge: "ok",
        tentative: retries + 1, createdAt: FieldValue.serverTimestamp(),
      });
      console.log(`[rechargeCallback] ✅ Ordre ${ref} → RECHARGÉ (tentative ${retries + 1})`);
      res.json({ success: true, ref, recharge: "ok", tentative: retries + 1, ia: analyseIA });
      return;
    }

    // ── CAS 2 : Échec < 3 tentatives → Retry MacroDroid ──────
    const nouvelleTentative = retries + 1;

    if (nouvelleTentative < 3) {
      await ordreDoc.ref.update({
        status:          `Recharge Retry ${nouvelleTentative}/3 ⏳`,
        rechargeStatus:  "retry",
        rechargeRetries: nouvelleTentative,
        rechargeMessage: "Échec recharge — retry automatique",
        ia_ecran_statut: analyseIA.statut,
        ia_ecran_raison: analyseIA.raison,
        lastRetryAt:     FieldValue.serverTimestamp(),
      });
      try {
        const id1xbetOrdre = id1xbet || ordre.userId1xBet || ordre.id1x || "";
        const retryUrl = `https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet?secret=f9f943cda999ac6771f5c600881b4f8aae2cf3af71dd86c2&id1xbet=${id1xbetOrdre}&montant=${montant || ordre.montant}&ref=${ref}&retry=${nouvelleTentative}`;
        await fetch(retryUrl, { signal: AbortSignal.timeout(8000) });
      } catch (e) {
        console.error("[rechargeCallback] Retry webhook erreur:", e.message);
      }
      await db.collection("callbacks").add({
        ref, id1xbet: id1xbet || ordre.userId1xBet || "", montant: montant || ordre.montant || "",
        resultat: "retry", ia: analyseIA, recharge: "retry",
        tentative: nouvelleTentative, createdAt: FieldValue.serverTimestamp(),
      });
      console.log(`[rechargeCallback] ⏳ Ordre ${ref} → RETRY ${nouvelleTentative}/3`);
      res.json({ success: true, ref, recharge: "retry", tentative: nouvelleTentative });
      return;
    }

    // ── CAS 3 : 3 échecs → Intervention manuelle 🚨 ──────────
    await ordreDoc.ref.update({
      status:          "Intervention Manuelle 🚨",
      rechargeStatus:  "manuel_requis",
      rechargeRetries: nouvelleTentative,
      rechargeMessage: "3 tentatives échouées",
      manuelRequis:    true,
      manuelRequsAt:   FieldValue.serverTimestamp(),
    });
    await db.collection("alertes_admin").add({
      type:      "recharge_echec_3x",
      ordreRef:  ref,
      id1xbet:   id1xbet || ordre.userId1xBet || "",
      montant:   montant || ordre.montant || "",
      message:   "3 tentatives échouées",
      createdAt: FieldValue.serverTimestamp(),
      traité:    false,
    });
    console.error(`[rechargeCallback] 🚨 Ordre ${ref} → INTERVENTION MANUELLE`);
    await db.collection("callbacks").add({
      ref, id1xbet: id1xbet || ordre.userId1xBet || "", montant: montant || ordre.montant || "",
      resultat: "echec", ia: analyseIA, recharge: "manuel_requis",
      tentative: nouvelleTentative, createdAt: FieldValue.serverTimestamp(),
    });
    res.json({ success: true, ref, recharge: "manuel_requis", tentative: nouvelleTentative });
  }
);


