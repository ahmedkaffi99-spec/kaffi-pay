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

  _flows = { analyseFraude, analyseAdmin };
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
        status:      "Rejeté",
        rejetRaison: "Transfer ID déjà utilisé dans un ordre précédent.",
        flagRaison:  "Doublon — Transfer ID déjà utilisé",
        flaggedAt:   FieldValue.serverTimestamp(),
      });
      return;
    }

    // IA fraude : FLAG uniquement — jamais de rejet automatique
    const updates = { ia_score_fraude:fraud.score_fraude, ia_risque:fraud.risque, ia_raisons:fraud.raisons, ia_action:fraud.action, ia_analysedAt:FieldValue.serverTimestamp() };
    if (fraud.action === "rejeter" || fraud.risque === "élevé") {
      updates.flagRaison = "IA Fraude (à vérifier): " + (fraud.raisons||[]).join(", ");
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
        const createdAt = smsData.createdAt ? smsData.createdAt.toDate() : new Date();
        if (createdAt < cutoff) continue;

        const montantSMS   = Number(smsData.montantSMS || 0);
        const montantOrdre = Number(tx.montant || 0);
        const numSMS       = smsData.numSMS || "";
        const numOrdre     = tx.numeroPayment || tx.waafiNumber || "";

        // Règle 3/3 : Transfer ID ✓ (déjà filtré) + Montant + Numéro
        const matchMontant = montantSMS && Math.abs(montantOrdre - montantSMS) <= 5;
        const matchNumero  = numSMS && numOrdre && numSMS === numOrdre;
        if (!matchMontant || !matchNumero) continue; // 2/3 → bloqué

        // ✅ Match rétroactif 3/3 trouvé
        const ordreRef = tx.orderId || tx.ref || docId;
        const id1xbet  = tx.userId1xBet || tx.id1x || tx.idUser || "";

        await Promise.all([
          db.collection("orders").doc(docId).update({
            status:         "Argent Reçu",
            paiementRecuAt: FieldValue.serverTimestamp(),
            confirmedBy:    "auto_waafi_retroactif",
            montantRecu:    montantSMS,
          }),
          smsDoc.ref.update({ status: "matché", ordreRef, matchType: "retroactif" }),
        ]);

        console.log(`[RetroMatch] ✅ Ordre ${ordreRef} matché via SMS ${smsDoc.id}`);

        if (id1xbet) {
          const url = `https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet?id1xbet=${encodeURIComponent(id1xbet)}&montant=${montantSMS}&ref=${encodeURIComponent(ordreRef)}`;
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
// 2. ORDRE MODIFIÉ → Notification statut client (temps réel)
// ══════════════════════════════════════════════════════════════
exports.onOrdreUpdated = onDocumentUpdated(
  { document: "orders/{docId}", region: "europe-west1", secrets: [] },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;

    const ref     = after.orderId || after.ref || event.params.docId;
    const montant = Number(after.montant || 0).toLocaleString();
    const tel     = after.waafiNumber || after.tel || after.numeroPayment || "";
    const newStatus = after.status;

    let msg = "";
    let type = "";

    if (newStatus === "Argent Reçu") {
      type = "paiement_recu";
      msg  = `💰 *Kaffi-Pay* — Paiement reçu !\n\nOrdre #${ref}\nMontant: ${montant} DJF\n\nVotre compte 1xBet est en cours de recharge...`;
    } else if (newStatus === "Rechargé ✅" || newStatus === "Confirmé") {
      type = "ordre_confirme";
      msg  = `✅ *Kaffi-Pay* — Ordre confirmé !\n\nOrdre #${ref}\nMontant: ${montant} DJF\n\nVotre compte 1xBet a été crédité avec succès. Merci 🙏`;
    } else if (newStatus === "Rejeté") {
      type = "ordre_rejete";
      const raison = after.rejetRaison || after.flagRaison || "";
      msg  = `❌ *Kaffi-Pay* — Ordre rejeté\n\nOrdre #${ref}\n${raison ? "Motif: "+raison : "Contactez le support pour assistance."}`;
    } else if (newStatus === "Correction") {
      type = "correction_requise";
      msg  = `✏️ *Kaffi-Pay* — Correction requise\n\nOrdre #${ref}\n${after.correctionMsg || "Veuillez corriger les informations de votre ordre."}`;
    } else if (newStatus === "Intervention Manuelle 🚨") {
      type = "intervention_manuelle";
      msg  = `🚨 *Kaffi-Pay* — Intervention requise\n\nOrdre #${ref}\nVotre paiement a été reçu mais la recharge a échoué. Notre équipe intervient.`;
    }

    if (!msg) return;

    // Écrire dans Firestore pour que MacroDroid/client puisse lire
    await db.collection("notifications_client").add({
      ref, tel, type, msg,
      status:    newStatus,
      montant:   Number(after.montant || 0),
      createdAt: FieldValue.serverTimestamp(),
      envoyé:    false,
    });

    console.log(`[Notification] ${ref} → ${newStatus} | tel: ${tel || "inconnu"}`);
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
// 5. AUTO-CONFIRMATION — SMS Waafi → Ordre confirmé → 1xBet
//    Logique identique à indexfinal22 (version qui marchait parfaitement)
// ══════════════════════════════════════════════════════════════
const OWN_NUMBER = "77275572"; // numéro Kaffi-Pay à exclure lors extraction expéditeur

function extraireTransferId(texte) {
  const m = texte.match(/Transfer-Id:\s*([0-9]+)/i);
  return m ? m[1].trim() : null;
}

function extraireMontant(texte) {
  const m = texte.match(/(?:transferred|received|transfer|amount|reçu)\s+DJF\s*([0-9][0-9,\.]*)/i);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

function extraireNumeroExp(texte) {
  // Trouver tous les numéros 8 chiffres, exclure le numéro propre
  const all = texte.match(/\(?\b(\d{8})\b\)?/g) || [];
  const nums = all.map(s => s.replace(/[()]/g, ""));
  const others = nums.filter(n => n !== OWN_NUMBER);
  return others.length > 0 ? others[0] : (nums[0] || null);
}

exports.autoConfirmation = onDocumentCreated(
  { document: "waafi_notifications/{docId}", region: "europe-west1", secrets: [], minInstances: 1, concurrency: 80 },
  async (event) => {
    const sms   = event.data.data();
    const docId = event.params.docId;

    if (sms.status === "traité" || sms.status === "en_cours" || sms.status === "matché") return;

    await db.collection("waafi_notifications").doc(docId).update({
      status:      "en_cours",
      processedAt: FieldValue.serverTimestamp(),
    });

    // ── Parser SMS Waafi (même logique que indexfinal22) ──────────
    const texte = sms.notification || sms.not_body || sms.texte || sms.message || sms.sms_body || "";

    if (!texte || texte === "{not_title}{notification}") {
      await db.collection("waafi_notifications").doc(docId).update({ status: "ignoré_format" });
      return;
    }

    // Vérifier que c'est bien un SMS Waafi
    const isWaafi = texte.includes("Transfer-Id") || texte.includes("DJF")
                 || texte.includes("Waafi")        || texte.includes("transferred")
                 || texte.includes("received")     || texte.includes("Evc-Plus");
    if (!isWaafi) {
      await db.collection("waafi_notifications").doc(docId).update({ status: "ignoré_non_waafi" });
      return;
    }

    const transferId = extraireTransferId(texte);
    const montantSMS = extraireMontant(texte);
    const numClient  = extraireNumeroExp(texte);

    console.log(`[AutoConfirm] TransferID: ${transferId}, Montant: ${montantSMS} DJF, N°: ${numClient}`);

    // Les 3 champs sont obligatoires dans le SMS
    const champsManquants = [];
    if (!transferId) champsManquants.push("Transfer ID");
    if (!montantSMS) champsManquants.push("Montant");
    if (!numClient)  champsManquants.push("Numéro expéditeur");

    if (champsManquants.length > 0) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "ignoré_champs_manquants",
        erreurMsg: `Champs absents du SMS : ${champsManquants.join(", ")}`,
        transferIdSMS: transferId,
        montantSMS,
        numSMS:    numClient,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    // ── Chercher ordre par Transfer ID ───────────────────────────
    const snap = await db.collection("orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();

    if (snap.empty) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:        "non_matché",
        erreurMsg:     `Aucun ordre En attente pour Transfer-Id ${transferId}`,
        transferIdSMS: transferId,
        numSMS:        numClient,
        montantSMS,
        createdAt:     FieldValue.serverTimestamp(),
      });
      return;
    }

    const ordreDoc     = snap.docs[0];
    const ordre        = ordreDoc.data();
    const ordreRef     = ordre.orderId || ordre.ref || ordreDoc.id;
    const montantOrdre = Number(ordre.montant || 0);
    const numOrdre     = ordre.numeroPayment || ordre.waafiNumber || "";
    const id1xbet      = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";

    // ── Vérification 3/3 : Transfer ID ✓ + Montant + Numéro expéditeur ──
    const matchTransferId = true; // déjà confirmé par la requête Firestore
    const matchMontant    = Math.abs(montantOrdre - montantSMS) <= 5;
    const matchNumero     = numOrdre && numClient === numOrdre;

    const score = [matchTransferId, matchMontant, matchNumero].filter(Boolean).length;

    if (score < 3) {
      const raisons = [];
      if (!matchMontant) raisons.push(`Montant SMS ${montantSMS} DJF ≠ Ordre ${montantOrdre} DJF`);
      if (!matchNumero)  raisons.push(`Numéro SMS ${numClient} ≠ Ordre ${numOrdre || "absent"}`);
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "bloqué_2sur3",
        erreurMsg: `Match incomplet (${score}/3) : ${raisons.join(" | ")}`,
        transferIdSMS: transferId,
        montantSMS,
        numSMS:    numClient,
        ordreRef,
        createdAt: FieldValue.serverTimestamp(),
      });
      console.warn(`[AutoConfirm] ⛔ Bloqué ${score}/3 — Ordre ${ordreRef} : ${raisons.join(" | ")}`);
      return;
    }

    // ✅ 3/3 confirmé
    const matchType = "transferId_3sur3";
    console.log(`[AutoConfirm] ✅ 3/3 Match — Ordre ${ordreRef} · ${montantSMS} DJF · ${numClient}`);

    await Promise.all([
      ordreDoc.ref.update({
        status:          "Argent Reçu",
        paiementRecuAt:  FieldValue.serverTimestamp(),
        confirmedBy:     "auto_waafi_sms",
        matchType,
        waafitranfertID: transferId || ordre.waafitranfertID,
        montantRecu:     montantSMS,
        numSMSConfirme:  numClient,
      }),
      db.collection("waafi_notifications").doc(docId).update({
        status: "matché", ordreRef, matchType,
      }),
    ]);

    // ── Déclencher MacroDroid → Recharge 1xBet ───────────────────
    if (!id1xbet) {
      console.warn(`[AutoConfirm] ⚠️ ID 1xBet absent pour ordre ${ordreRef} — recharge manuelle`);
      await ordreDoc.ref.update({ webhookStatus: "manque_id1xbet" });
      return;
    }

    const webhookUrl = `https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet`
      + `?id1xbet=${encodeURIComponent(id1xbet)}`
      + `&montant=${montantSMS}`
      + `&ref=${encodeURIComponent(ordreRef)}`;

    fetch(webhookUrl, { signal: AbortSignal.timeout(15000) })
      .then(r => {
        ordreDoc.ref.update({ webhookStatus: r.ok ? "ok" : "erreur_"+r.status, webhookAt: FieldValue.serverTimestamp() });
        if (r.ok) console.log(`[AutoConfirm] 🤖 MacroDroid déclenché — ${id1xbet} · ${montantSMS} DJF`);
        else      console.warn(`[AutoConfirm] ⚠️ MacroDroid HTTP ${r.status}`);
      })
      .catch(e => {
        ordreDoc.ref.update({ webhookStatus: "erreur_timeout" });
        console.error(`[AutoConfirm] ❌ MacroDroid injoignable: ${e.message}`);
      });
  }
);

// ══════════════════════════════════════════════════════════════
// 6. ENDPOINT HTTP — MacroDroid envoie SMS ici
// ══════════════════════════════════════════════════════════════
// MacroDroid appelle : POST https://europe-west1-kaffi-pay.cloudfunctions.net/smsWebhook
// Body JSON : { secret, notification, not_title }
exports.smsWebhook = onRequest(
  { region: "europe-west1", cors: true, minInstances: 1, concurrency: 80 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Méthode non autorisée" });
      return;
    }

    const { notification, not_title } = req.body;

    if (!notification) {
      res.status(400).json({ error: "Champ 'notification' requis" });
      return;
    }

    // Écrire dans Firestore → déclenche autoConfirmation automatiquement
    const docRef = await db.collection("waafi_notifications").add({
      notification,
      not_title:  not_title || "Waafi SMS",
      source:     "macrodroid_http",
      createdAt:  FieldValue.serverTimestamp(),
      status:     "nouveau",
    });

    console.log(`[smsWebhook] SMS reçu → doc ${docRef.id}`);
    res.json({ success: true, docId: docRef.id });
  }
);

// ══════════════════════════════════════════════════════════════
// 7. AUTO-REJET SERVEUR — Ordres "En attente" depuis > 3 min
// ══════════════════════════════════════════════════════════════
exports.autoRejetServeur = onSchedule(
  { schedule: "every 5 minutes", region: "europe-west1", timeoutSeconds: 60 },
  async () => {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes
    const snap   = await db.collection("orders")
      .where("status", "==", "En attente")
      .where("createdAt", "<", cutoff)
      .limit(20)
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    snap.docs.forEach(doc => {
      batch.update(doc.ref, {
        status:      "Rejeté",
        rejetRaison: "Paiement Waafi non reçu dans le délai imparti (10 minutes). Vérifiez votre Transfer ID et réessayez.",
        rejetedAt:   FieldValue.serverTimestamp(),
        rejetBy:     "auto_serveur",
      });
    });
    await batch.commit();
    console.log(`[AutoRejet] ${snap.size} ordre(s) rejeté(s) après 10 min sans paiement`);
  }
);

// ══════════════════════════════════════════════════════════════
// 8. CALLBACK MacroDroid → Résultat recharge 1xBet
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
        const retryUrl = `https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet?id1xbet=${id1xbetOrdre}&montant=${montant || ordre.montant}&ref=${ref}&retry=${nouvelleTentative}`;
        await fetch(retryUrl, { signal: AbortSignal.timeout(8000) });
      } catch (e) {
        console.error("[rechargeCallback] Retry webhook erreur:", e.message);
      }
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
    res.json({ success: true, ref, recharge: "manuel_requis", tentative: nouvelleTentative });
  }
);

