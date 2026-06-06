/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║       KAFFI PAY — CLOUD FUNCTIONS v4.0                      ║
 * ║  • Gemini AI direct (@google/generative-ai)                 ║
 * ║  • Auto-confirmation SMS Waafi → MacroDroid 1xBet           ║
 * ║  • Realtime DB dashboard live                               ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest }                    = require("firebase-functions/v2/https");
const { defineSecret }                         = require("firebase-functions/params");
const { initializeApp }                        = require("firebase-admin/app");
const { getFirestore, FieldValue }             = require("firebase-admin/firestore");
const { getDatabase }                          = require("firebase-admin/database");
const { GoogleGenerativeAI }                   = require("@google/generative-ai");

initializeApp();
const db   = getFirestore();
const rtdb = getDatabase();

const MACRO_DEPOT_URL = "https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet?secret=f9f943cda999ac6771f5c600881b4f8aae2cf3af71dd86c2";
const GEMINI_KEY      = defineSecret("GEMINI_KEY");

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

const REGLES = {
  depot:   { min: 50,  max: 500000 },
  retrait: { min: 250, max: 100000 },
};

function validerReglesDor(tx) {
  const erreurs    = [];
  const montant    = Number(tx.montant || 0);
  const type       = (tx.type || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const transferId = String(tx.waafitranfertID || tx.transferId || "").trim();
  const numero     = String(tx.numeroPayment || tx.waafiNumber || "").trim();
  const id1xbet    = tx.userId1xBet || tx.id1x || tx.idUser || "";

  if (type === "depot" || type === "depot") {
    if (montant < REGLES.depot.min) erreurs.push(`Minimum dépôt: ${REGLES.depot.min} DJF`);
    if (montant > REGLES.depot.max) erreurs.push(`Maximum dépôt: ${REGLES.depot.max.toLocaleString()} DJF`);
  } else if (type === "retrait") {
    if (montant < REGLES.retrait.min) erreurs.push(`Minimum retrait: ${REGLES.retrait.min} DJF`);
    if (montant > REGLES.retrait.max) erreurs.push(`Maximum retrait: ${REGLES.retrait.max.toLocaleString()} DJF`);
  }
  if (!transferId || transferId.replace(/\D/g, "").length < 6)
    erreurs.push("Transfer ID invalide (min 6 chiffres)");
  if (!numero || !/^77\d{6}$/.test(numero))
    erreurs.push("Numéro Waafi invalide (77xxxxxx, 8 chiffres)");
  if (!id1xbet)
    erreurs.push("ID 1xBet requis");

  return erreurs;
}

function parseSmsWaafi(notification) {
  const transferMatch = notification.match(/Transfer-?Id[:\s]+(\d+)/i)
                     || notification.match(/Transfer\s*ID[:\s]+(\d+)/i)
                     || notification.match(/Ref[:\s#]+(\d{6,})/i);
  const transferId = transferMatch ? transferMatch[1].trim() : null;

  const montantMatch = notification.match(/(?:Received|transferred|reçu|sent)\s+DJF\s*([\d,. ]+)/i)
                    || notification.match(/DJF\s*([\d,. ]+)/i);
  const montantStr = montantMatch ? montantMatch[1].trim().replace(/[\s,. ]/g, "") : null;
  const montantSMS = montantStr ? Number(montantStr) : null;

  const numMatch  = notification.match(/\((\d{7,9})\)/);
  const numClient = numMatch ? numMatch[1] : null;

  return { transferId, montantSMS, numClient };
}

async function rtdbUpdateStatus(ordreRef, status, extra = {}) {
  try {
    await rtdb.ref(`orders/${ordreRef}`).update({ status, updatedAt: Date.now(), ...extra });
  } catch (e) {
    console.error("[RTDB]", e.message);
  }
}

function getGemini() {
  return new GoogleGenerativeAI(GEMINI_KEY.value())
    .getGenerativeModel({ model: "gemini-2.0-flash" });
}

async function geminiJson(prompt, systemInstruction) {
  const model = new GoogleGenerativeAI(GEMINI_KEY.value()).getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction,
    generationConfig: { responseMimeType: "application/json" },
  });
  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text());
}

// ══════════════════════════════════════════════════════════════
// 0. VALIDER ORDRE — feedback UI avant écriture Firestore
//    Retourne des erreurs pour l'affichage, ne rejette pas l'ordre.
// ══════════════════════════════════════════════════════════════
exports.validerOrdre = onRequest(
  { region: "europe-west1", cors: true },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "POST requis" }); return; }
    const erreurs = validerReglesDor(req.body || {});
    res.json({ valide: erreurs.length === 0, erreurs });
  }
);

// ══════════════════════════════════════════════════════════════
// 1. NOUVEL ORDRE → Gemini fraude + Rétroactif SMS
//    Seul Gemini peut rejeter. Tout le reste = sauvegarder + transférer.
// ══════════════════════════════════════════════════════════════
exports.onNouvelOrdre = onDocumentCreated(
  { document: "orders/{docId}", region: "europe-west1", secrets: [GEMINI_KEY], minInstances: 1, concurrency: 80 },
  async (event) => {
    const tx         = event.data.data();
    const docId      = event.params.docId;
    const transferId = tx.waafitranfertID || tx.hash || "";
    const ordreRef   = tx.orderId || tx.ref || docId;

    // Enregistrer dans Realtime DB pour dashboard live
    await rtdbUpdateStatus(ordreRef, tx.status || "En attente", { montant: Number(tx.montant || 0), type: tx.type });

    // ── Gemini fraude — seul juge autorisé à rejeter ──────────
    try {
      const fraud = await geminiJson(
        `Transaction à analyser :
- Type: ${tx.type || "?"}
- Montant: ${Number(tx.montant || 0)} DJF
- Transfer ID: ${transferId || "?"}
- N° Expéditeur: ${tx.numeroPayment || "?"}
- Heure: ${new Date().getHours()}h

Réponds en JSON : {"score_fraude":0-100,"risque":"faible|moyen|élevé","action":"valider|vérifier|rejeter","raisons":[]}`,
        `Tu es le seul système autorisé à rejeter des transactions sur Kaffi Pay (Djibouti, 1xBet↔Waafi).
Ne rejette que les fraudes évidentes : montant irréaliste, Transfer ID incohérent, pattern d'arnaque.
En cas de doute, valide — le SMS Waafi confirmera ou non le paiement.`
      );

      // Sauvegarder le score IA sur l'ordre (transfert de données)
      const updates = { ia_score_fraude: fraud.score_fraude, ia_risque: fraud.risque, ia_raisons: fraud.raisons, ia_action: fraud.action, ia_analysedAt: FieldValue.serverTimestamp() };
      if (fraud.action === "rejeter") {
        updates.status     = "Rejeté";
        updates.flagRaison = "IA Fraude: " + (fraud.raisons || []).join(", ");
        updates.rejetedAt  = FieldValue.serverTimestamp();
      }
      await db.collection("orders").doc(docId).update(updates);
      if (fraud.action === "rejeter") return;
    } catch (e) {
      console.error("[onNouvelOrdre] Gemini erreur (ordre conservé En attente):", e.message);
    }

    // ── Correspondance rétroactive — SMS déjà arrivé avant l'ordre ──
    if (!transferId) return;
    try {
      const cutoff  = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const smsSnap = await db.collection("waafi_notifications")
        .where("transferIdSMS", "==", transferId).limit(5).get();

      for (const smsDoc of smsSnap.docs) {
        const smsData   = smsDoc.data();
        const createdAt = smsData.createdAt ? smsData.createdAt.toDate() : new Date();
        if (createdAt < cutoff) continue;

        const montantSMS   = Number(smsData.montantSMS || 0);
        const montantOrdre = Number(tx.montant || 0);
        if (Math.abs(montantOrdre - montantSMS) > 5) continue;

        const numSMS   = smsData.numClient || "";
        const numOrdre = tx.numeroPayment || tx.waafiNumber || "";
        if (numSMS && numOrdre && numSMS !== numOrdre) continue;

        const id1xbet = tx.userId1xBet || tx.id1x || tx.idUser || "";
        await db.collection("orders").doc(docId).update({
          status: "Confirmé", confirmedAt: FieldValue.serverTimestamp(),
          confirmedBy: "auto_waafi_retroactif", montantRecu: montantSMS,
        });
        console.log(`[RetroMatch] ✅ Ordre ${ordreRef} confirmé via SMS ${smsDoc.id}`);
        if (id1xbet) {
          const url = `${MACRO_DEPOT_URL}&id1xbet=${encodeURIComponent(id1xbet)}&montant=${montantSMS}&ref=${encodeURIComponent(ordreRef)}`;
          fetch(url, { signal: AbortSignal.timeout(8000) })
            .then(r => db.collection("orders").doc(docId).update({ webhookStatus: r.ok ? "ok" : "erreur_"+r.status, webhookAt: FieldValue.serverTimestamp() }))
            .catch(() => db.collection("orders").doc(docId).update({ webhookStatus: "erreur_timeout" }));
        }
        break;
      }
    } catch (e) {
      console.error("[RetroMatch] erreur:", e.message);
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 2. ORDRE MODIFIÉ → Realtime DB live
// ══════════════════════════════════════════════════════════════
exports.onOrdreUpdated = onDocumentUpdated(
  { document: "orders/{docId}", region: "europe-west1", secrets: [] },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;
    const ref = after.orderId || after.ref || event.params.docId;
    console.log(`[onOrdreUpdated] Ordre ${ref} : ${before.status} → ${after.status}`);
    await rtdbUpdateStatus(ref, after.status, { montant: Number(after.montant || 0) });
  }
);

// ══════════════════════════════════════════════════════════════
// 3. GEMINI ANALYSE ADMIN — résumé + prédictions
// ══════════════════════════════════════════════════════════════
exports.geminiAnalyseAdmin = onCall(
  { region: "europe-west1", secrets: [GEMINI_KEY] },
  async () => {
    const snap = await db.collection("orders").orderBy("createdAt", "desc").limit(100).get();
    const txs       = snap.docs.map(d => d.data());
    const confirmes = txs.filter(t => t.status === "Confirmé");
    const attente   = txs.filter(t => t.status === "En attente");
    const rejetes   = txs.filter(t => t.status === "Rejeté");
    const volume    = confirmes.reduce((s, t) => s + Number(t.montant || 0), 0);
    const taux      = txs.length ? Math.round((confirmes.length / txs.length) * 100) : 0;
    const moyenne   = confirmes.length ? Math.round(volume / confirmes.length) : 0;

    const derniers = txs.slice(0, 5).map(t => {
      const date = t.createdAt ? t.createdAt.toDate().toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "?";
      return `• ${t.type || "?"} ${Number(t.montant || 0)} DJF — ${t.status || "?"} — ${date}`;
    }).join("\n");

    try {
      const data = await geminiJson(
        `Données des 100 dernières transactions :
- Confirmées: ${confirmes.length} — Volume: ${volume.toLocaleString()} DJF
- En attente: ${attente.length}
- Rejetées: ${rejetes.length}
- Taux confirmation: ${taux}%
- Montant moyen: ${moyenne} DJF

5 dernières transactions :
${derniers}

Réponds en JSON : {"resume":"...","alerte":null,"conseil":"...","prediction_demain":0,"heure_pic":"?","score_sante":0-100}`,
        `Tu es le conseiller IA de la direction de Kaffi Pay (Djibouti, 1xBet↔Waafi).
Analyse les performances, identifie les anomalies, donne des recommandations concrètes en DJF.`
      );
      return { success: true, data, stats: { confirmes: confirmes.length, attente: attente.length, rejetes: rejetes.length, volume } };
    } catch (e) {
      console.error("[geminiAnalyseAdmin] erreur:", e.message);
      return { success: false, error: "Erreur analyse IA" };
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 4. AUTO-CONFIRMATION — SMS Waafi écrit directement en Firestore
//    (backup pour docs sans source=macrodroid_http)
// ══════════════════════════════════════════════════════════════
exports.autoConfirmation = onDocumentCreated(
  { document: "waafi_notifications/{docId}", region: "europe-west1", secrets: [], minInstances: 1, concurrency: 80 },
  async (event) => {
    const sms = event.data.data();
    if (sms.source === "macrodroid_http") return; // smsWebhook gère déjà

    const notification = sms.notification || sms.notificationText || sms.not_body || sms.texte || sms.message || sms.sms_body || "";
    if (!notification || notification === "[notification]" || notification === "{notification}") return;
    if (!/Transfer-?Id|DJF|Waafi|WAAFI/i.test(notification)) return;

    const { transferId, montantSMS, numClient } = parseSmsWaafi(notification);
    console.log(`[AutoConfirm] TransferID=${transferId} | Montant=${montantSMS} | N°=${numClient}`);
    if (!transferId || !montantSMS) return;

    const ordreSnap = await db.collection("orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();

    if (ordreSnap.empty) {
      console.log(`[AutoConfirm] Aucun ordre pour Transfer ID ${transferId}`);
      return;
    }

    const ordreDoc     = ordreSnap.docs[0];
    const ordre        = ordreDoc.data();
    const ordreRef     = ordre.orderId || ordre.ref || ordreDoc.id;
    const montantOrdre = Number(ordre.montant || 0);
    const numeroOrdre  = ordre.numeroPayment || ordre.waafiNumber || "";

    if (numClient && numeroOrdre && numClient !== numeroOrdre) {
      console.warn(`[AutoConfirm] N° SMS (${numClient}) ≠ N° ordre (${numeroOrdre})`);
      return;
    }
    if (Math.abs(montantOrdre - montantSMS) > 5) {
      console.warn(`[AutoConfirm] Montant SMS ${montantSMS} ≠ Ordre ${montantOrdre} DJF`);
      return;
    }

    const id1xbet = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";
    await ordreDoc.ref.update({
      status: "Confirmé", confirmedAt: FieldValue.serverTimestamp(),
      confirmedBy: "auto_waafi_sms", waafitranfertID: transferId,
      montantRecu: montantSMS, rejetBy: FieldValue.delete(), rejetRaison: FieldValue.delete(),
    });
    if (id1xbet) {
      const url = `${MACRO_DEPOT_URL}&id1xbet=${encodeURIComponent(id1xbet)}&montant=${montantSMS}&ref=${encodeURIComponent(ordreRef)}`;
      fetch(url, { signal: AbortSignal.timeout(8000) })
        .then(r => ordreDoc.ref.update({ webhookStatus: r.ok ? "ok" : "erreur_"+r.status, webhookAt: FieldValue.serverTimestamp() }))
        .catch(() => ordreDoc.ref.update({ webhookStatus: "erreur_timeout" }));
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 5. SMS WEBHOOK — MacroDroid → Parse + Match + Confirme
// POST body: { notification: "texte SMS Waafi" }
// ══════════════════════════════════════════════════════════════
exports.smsWebhook = onRequest(
  { region: "europe-west1", cors: true, minInstances: 1, concurrency: 80 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Méthode non autorisée" }); return; }

    const body         = req.body || {};
    const notification = body.notification || body.notificationText || body.not_body || body.texte || body.message || body.sms_body || body.sms || body.text || "";

    if (!notification || notification === "[notification]" || notification === "{notification}") {
      res.status(400).json({ error: "SMS vide ou format invalide" });
      return;
    }

    if (!/Transfer-?Id|DJF|Waafi|WAAFI/i.test(notification)) {
      res.json({ success: true, status: "ignoré_non_waafi" });
      return;
    }

    const { transferId, montantSMS, numClient } = parseSmsWaafi(notification);
    console.log(`[smsWebhook] TransferID=${transferId} | Montant=${montantSMS} | N°=${numClient}`);

    // Sauvegarder brut dans waafi_notifications
    const docRef = await db.collection("waafi_notifications").add({
      notification, source: "macrodroid_http",
      transferIdSMS: transferId || null, montantSMS: montantSMS || null,
      numClient: numClient || null, createdAt: FieldValue.serverTimestamp(),
    });

    if (!transferId || !montantSMS) {
      console.warn(`[smsWebhook] Parsing échoué | "${notification.substring(0, 80)}"`);
      res.json({ success: false, status: "erreur_parsing", docId: docRef.id });
      return;
    }

    const ordreSnap = await db.collection("orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();

    if (ordreSnap.empty) {
      console.log(`[smsWebhook] Aucun ordre pour ${transferId} — SMS stocké, attente ordre client`);
      res.json({ success: false, status: "non_matché", transferId, docId: docRef.id });
      return;
    }

    const ordreDoc     = ordreSnap.docs[0];
    const ordre        = ordreDoc.data();
    const ordreRef     = ordre.orderId || ordre.ref || ordreDoc.id;
    const montantOrdre = Number(ordre.montant || 0);
    const numeroOrdre  = ordre.numeroPayment || ordre.waafiNumber || "";

    if (numClient && numeroOrdre && numClient !== numeroOrdre) {
      console.warn(`[smsWebhook] N° SMS (${numClient}) ≠ N° ordre (${numeroOrdre})`);
      res.json({ success: false, status: "expediteur_mismatch", docId: docRef.id });
      return;
    }
    if (Math.abs(montantOrdre - montantSMS) > 5) {
      console.warn(`[smsWebhook] Montant SMS ${montantSMS} ≠ Ordre ${montantOrdre} DJF`);
      res.json({ success: false, status: "montant_incorrect", docId: docRef.id });
      return;
    }

    const id1xbet = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";
    await ordreDoc.ref.update({
      status: "Confirmé", confirmedAt: FieldValue.serverTimestamp(),
      confirmedBy: "auto_waafi_sms", waafitranfertID: transferId,
      montantRecu: montantSMS, rejetBy: FieldValue.delete(), rejetRaison: FieldValue.delete(),
    });
    console.log(`[smsWebhook] ✅ Ordre ${ordreRef} CONFIRMÉ — ${montantSMS} DJF`);

    if (id1xbet) {
      const url = `${MACRO_DEPOT_URL}&id1xbet=${encodeURIComponent(id1xbet)}&montant=${montantSMS}&ref=${encodeURIComponent(ordreRef)}`;
      fetch(url, { signal: AbortSignal.timeout(8000) })
        .then(r => ordreDoc.ref.update({ webhookStatus: r.ok ? "ok" : "erreur_"+r.status, webhookAt: FieldValue.serverTimestamp() }))
        .catch(() => ordreDoc.ref.update({ webhookStatus: "erreur_timeout" }));
    }
    res.json({ success: true, status: "confirmé", ordreRef, montantSMS, transferId, docId: docRef.id });
  }
);

// ══════════════════════════════════════════════════════════════
// 6. RECHARGE CALLBACK — MacroDroid → résultat recharge 1xBet
// POST body: { ref, resultat, id1xbet, montant, ecran? }
// ══════════════════════════════════════════════════════════════
exports.rechargeCallback = onRequest(
  { region: "europe-west1", cors: true, secrets: [GEMINI_KEY], minInstances: 1, concurrency: 80 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Méthode non autorisée" }); return; }

    const { ref, resultat, id1xbet, montant } = req.body || {};
    if (!ref) { res.status(400).json({ error: "Champ 'ref' requis" }); return; }

    const texteEcran = req.body.ecran || "";
    let estSucces = false;
    let analyseIA = { statut: "inconnu", raison: "Non déterminé", confiance: 0 };

    if (texteEcran) {
      try {
        const result = await geminiJson(
          `Texte écran MobCash après recharge :
"""
${texteEcran}
"""
Succès : "avec succès", "déposé avec", "Vous avez déposé", success, credited, completed
Échec : "Fonds insuffisants", "Rechargez", "actualisez", failed, error, insufficient
Réponds en JSON : {"statut":"succes|echec|inconnu","raison":"...","confiance":0-100}`,
          `Tu es le système de vérification de recharge 1xBet pour Kaffi Pay (Djibouti).
Tu analyses le texte MobCash. En cas d'ambiguïté, réponds "inconnu".`
        );
        analyseIA = result;
        estSucces  = result.statut === "succes";
      } catch (e) {
        console.error("[rechargeCallback] Gemini erreur:", e.message);
        const txt = texteEcran.toLowerCase();
        estSucces = /avec succ|déposé avec|vous avez déposé|dépôt|success|credited|completed|deposited/.test(txt);
        analyseIA = { statut: estSucces ? "succes" : "echec", raison: "Mots-clés (Gemini indisponible)", confiance: 70 };
      }
    } else if (resultat === "succes") {
      estSucces = true;
      analyseIA = { statut: "succes", raison: "Détecté par MacroDroid", confiance: 90 };
    } else if (resultat === "echec") {
      analyseIA = { statut: "echec", raison: "Détecté par MacroDroid — Fonds insuffisants", confiance: 90 };
    }

    const snap = await db.collection("orders").where("orderId", "==", ref).limit(1).get();
    if (snap.empty) { res.status(404).json({ error: `Ordre ${ref} non trouvé` }); return; }

    const ordreDoc = snap.docs[0];
    const ordre    = ordreDoc.data();
    const retries  = Number(ordre.rechargeRetries || 0);

    if (estSucces) {
      await ordreDoc.ref.update({
        status: "Rechargé ✅", rechargeStatus: "rechargé",
        rechargeAt: FieldValue.serverTimestamp(),
        rechargeMessage: texteEcran || "Recharge confirmée",
        rechargeId1xbet: id1xbet || ordre.userId1xBet || "",
        rechargeMontant: Number(montant || ordre.montant || 0),
        rechargeRetries: retries,
        ia_ecran_statut: analyseIA.statut, ia_ecran_raison: analyseIA.raison, ia_ecran_confiance: analyseIA.confiance,
      });
      console.log(`[rechargeCallback] ✅ Ordre ${ref} → RECHARGÉ (tentative ${retries + 1})`);
      res.json({ success: true, ref, recharge: "ok", tentative: retries + 1, ia: analyseIA });
      return;
    }

    const nouvelleTentative = retries + 1;
    if (nouvelleTentative < 3) {
      await ordreDoc.ref.update({
        status: `Recharge Retry ${nouvelleTentative}/3 ⏳`, rechargeStatus: "retry",
        rechargeRetries: nouvelleTentative, rechargeMessage: "Échec recharge — retry automatique",
        ia_ecran_statut: analyseIA.statut, ia_ecran_raison: analyseIA.raison,
        lastRetryAt: FieldValue.serverTimestamp(),
      });
      try {
        const retryUrl = `${MACRO_DEPOT_URL}&id1xbet=${encodeURIComponent(id1xbet || ordre.userId1xBet || "")}&montant=${montant || ordre.montant}&ref=${ref}&retry=${nouvelleTentative}`;
        await fetch(retryUrl, { signal: AbortSignal.timeout(8000) });
      } catch (e) { console.error("[rechargeCallback] Retry erreur:", e.message); }
      console.log(`[rechargeCallback] ⏳ Ordre ${ref} → RETRY ${nouvelleTentative}/3`);
      res.json({ success: true, ref, recharge: "retry", tentative: nouvelleTentative });
      return;
    }

    await ordreDoc.ref.update({
      status: "Intervention Manuelle 🚨", rechargeStatus: "manuel_requis",
      rechargeRetries: nouvelleTentative, rechargeMessage: "3 tentatives échouées",
      manuelRequis: true, manuelRequsAt: FieldValue.serverTimestamp(),
    });
    await db.collection("alertes_admin").add({
      type: "recharge_echec_3x", ordreRef: ref,
      id1xbet: id1xbet || ordre.userId1xBet || "",
      montant: montant || ordre.montant || "",
      message: "3 tentatives échouées",
      createdAt: FieldValue.serverTimestamp(), traité: false,
    });
    console.error(`[rechargeCallback] 🚨 Ordre ${ref} → INTERVENTION MANUELLE`);
    res.json({ success: true, ref, recharge: "manuel_requis", tentative: nouvelleTentative });
  }
);
