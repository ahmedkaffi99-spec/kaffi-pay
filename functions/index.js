/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║       KAFFI PAY — CLOUD FUNCTIONS v5.0                      ║
 * ║  Flux principal : SMS Waafi arrive AVANT l'ordre            ║
 * ║  Seul Gemini confirme (+ crédite 1xBet) ou rejette          ║
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

function parseSmsWaafi(text) {
  const transferMatch = text.match(/Transfer-?Id[:\s]+(\d+)/i)
                     || text.match(/Transfer\s*ID[:\s]+(\d+)/i)
                     || text.match(/Ref[:\s#]+(\d{6,})/i);
  const transferId = transferMatch ? transferMatch[1].trim() : null;

  const montantMatch = text.match(/(?:Received|transferred|reçu|sent)\s+DJF\s*([\d,. ]+)/i)
                    || text.match(/DJF\s*([\d,. ]+)/i);
  const montantStr = montantMatch ? montantMatch[1].trim().replace(/[\s,. ]/g, "") : null;
  const montantSMS = montantStr ? Number(montantStr) : null;

  const numMatch  = text.match(/\((\d{7,9})\)/);
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

async function geminiJson(prompt, systemInstruction) {
  const model = new GoogleGenerativeAI(GEMINI_KEY.value()).getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction,
    generationConfig: { responseMimeType: "application/json" },
  });
  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text());
}

// Gemini décide : confirmer (+ créditer 1xBet) | rejeter | attendre
async function geminiDecider(ordre, sms) {
  return await geminiJson(
    `Ordre client :
- Type : ${ordre.type || "?"}
- Montant attendu : ${Number(ordre.montant || 0)} DJF
- Transfer ID ordre : ${ordre.waafitranfertID || "?"}
- N° Waafi client : ${ordre.numeroPayment || ordre.waafiNumber || "?"}

SMS Waafi reçu :
- Transfer ID SMS : ${sms.transferIdSMS || "?"}
- Montant SMS : ${sms.montantSMS || 0} DJF
- N° expéditeur : ${sms.numClient || "non disponible"}
- Texte brut : "${(sms.notification || "").substring(0, 200)}"

Réponds en JSON : {"decision":"confirmer|rejeter|attendre","raison":"..."}`,
    `Tu es le moteur de décision de Kaffi Pay (Djibouti, plateforme 1xBet↔Waafi).
Tu as DEUX responsabilités :
1. Confirmer le paiement et créditer le compte 1xBet (decision="confirmer")
2. Rejeter les fraudes et arnaques (decision="rejeter")

Règles de décision :
- confirmer : Transfer ID identique ET montant correspondant (tolérance ±10 DJF) → paiement valide, créditer
- rejeter : Transfer ID différent OU montant très différent (>50 DJF) OU fraude évidente
- attendre : données SMS incomplètes ou insuffisantes pour décider

En cas de doute léger, confirme — le Transfer ID est la clé principale.`
  );
}

// Créditer 1xBet via MacroDroid après confirmation Gemini
function declencherMacro(ordreDoc, ordreRef, id1xbet, montant) {
  if (!id1xbet) return;
  const url = `${MACRO_DEPOT_URL}&id1xbet=${encodeURIComponent(id1xbet)}&montant=${montant}&ref=${encodeURIComponent(ordreRef)}`;
  fetch(url, { signal: AbortSignal.timeout(8000) })
    .then(r => ordreDoc.ref.update({ webhookStatus: r.ok ? "ok" : "erreur_"+r.status, webhookAt: FieldValue.serverTimestamp() }))
    .catch(() => ordreDoc.ref.update({ webhookStatus: "erreur_timeout" }));
}

// ══════════════════════════════════════════════════════════════
// 0. VALIDER ORDRE — feedback UI uniquement (n'écrit rien)
// ══════════════════════════════════════════════════════════════
const REGLES = { depot: { min: 50, max: 500000 }, retrait: { min: 250, max: 100000 } };

function validerReglesDor(tx) {
  const erreurs    = [];
  const montant    = Number(tx.montant || 0);
  const type       = (tx.type || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const transferId = String(tx.waafitranfertID || tx.transferId || "").trim();
  const numero     = String(tx.numeroPayment || tx.waafiNumber || "").trim();
  if (type === "depot" || type === "depot") {
    if (montant < REGLES.depot.min) erreurs.push(`Minimum dépôt: ${REGLES.depot.min} DJF`);
    if (montant > REGLES.depot.max) erreurs.push(`Maximum dépôt: ${REGLES.depot.max.toLocaleString()} DJF`);
  } else if (type === "retrait") {
    if (montant < REGLES.retrait.min) erreurs.push(`Minimum retrait: ${REGLES.retrait.min} DJF`);
    if (montant > REGLES.retrait.max) erreurs.push(`Maximum retrait: ${REGLES.retrait.max.toLocaleString()} DJF`);
  }
  if (!transferId || transferId.replace(/\D/g, "").length < 6) erreurs.push("Transfer ID invalide");
  if (!numero || !/^77\d{6}$/.test(numero)) erreurs.push("Numéro Waafi invalide (77xxxxxx)");
  if (!(tx.userId1xBet || tx.id1x || tx.idUser)) erreurs.push("ID 1xBet requis");
  return erreurs;
}

exports.validerOrdre = onRequest(
  { region: "europe-west1", cors: true },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "POST requis" }); return; }
    const erreurs = validerReglesDor(req.body || {});
    res.json({ valide: erreurs.length === 0, erreurs });
  }
);

// ══════════════════════════════════════════════════════════════
// 1. SMS WEBHOOK — MacroDroid → stocker le SMS brut, rien d'autre
//    Le SMS arrive TOUJOURS en premier.
//    Gemini décidera quand l'ordre sera soumis.
// ══════════════════════════════════════════════════════════════
exports.smsWebhook = onRequest(
  { region: "europe-west1", cors: true, minInstances: 1, concurrency: 80 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Méthode non autorisée" }); return; }

    const body = req.body || {};
    const notification = body.notification || body.notificationText || body.not_body ||
                         body.texte || body.message || body.sms_body || body.sms || body.text || "";

    if (!notification || notification === "[notification]" || notification === "{notification}") {
      res.status(400).json({ error: "SMS vide ou format invalide" });
      return;
    }

    if (!/Transfer-?Id|DJF|Waafi|WAAFI/i.test(notification)) {
      res.json({ success: true, status: "ignoré_non_waafi" });
      return;
    }

    const { transferId, montantSMS, numClient } = parseSmsWaafi(notification);
    console.log(`[smsWebhook] SMS stocké | TransferID=${transferId} | Montant=${montantSMS} | N°=${numClient}`);

    const docRef = await db.collection("waafi_notifications").add({
      notification,
      source:        "macrodroid_http",
      transferIdSMS: transferId || null,
      montantSMS:    montantSMS || null,
      numClient:     numClient  || null,
      createdAt:     FieldValue.serverTimestamp(),
    });

    res.json({ success: true, status: "stocké", transferId, montantSMS, docId: docRef.id });
  }
);

// ══════════════════════════════════════════════════════════════
// 2. NOUVEL ORDRE → cherche le SMS déjà arrivé → Gemini décide
//    Flux principal : SMS arrivé avant l'ordre
// ══════════════════════════════════════════════════════════════
exports.onNouvelOrdre = onDocumentCreated(
  { document: "orders/{docId}", region: "europe-west1", secrets: [GEMINI_KEY], minInstances: 1, concurrency: 80 },
  async (event) => {
    const tx       = event.data.data();
    const docId    = event.params.docId;
    const ordreRef = tx.orderId || tx.ref || docId;
    const tid      = tx.waafitranfertID || "";

    await rtdbUpdateStatus(ordreRef, "En attente", { montant: Number(tx.montant || 0), type: tx.type });

    if (!tid) return;

    // Chercher le SMS déjà stocké dans waafi_notifications
    const cutoff  = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const smsSnap = await db.collection("waafi_notifications")
      .where("transferIdSMS", "==", tid)
      .limit(3).get();

    let smsDoc = null;
    for (const doc of smsSnap.docs) {
      const d = doc.data();
      const createdAt = d.createdAt ? d.createdAt.toDate() : new Date();
      if (createdAt >= cutoff) { smsDoc = doc; break; }
    }

    if (!smsDoc) {
      console.log(`[onNouvelOrdre] SMS pas encore arrivé pour ${tid} — ordre en attente`);
      return;
    }

    // SMS trouvé → Gemini décide
    try {
      const { decision, raison } = await geminiDecider(tx, smsDoc.data());
      console.log(`[onNouvelOrdre] Gemini → ${decision} : ${raison}`);

      if (decision === "confirmer") {
        const montantRecu = Number(smsDoc.data().montantSMS || tx.montant || 0);
        const id1xbet     = tx.userId1xBet || tx.id1x || tx.idUser || "";
        // Transaction Firestore — évite double confirmation
        const updated = await db.runTransaction(async (t) => {
          const snap = await t.get(db.collection("orders").doc(docId));
          if (snap.data().status !== "En attente") return false;
          t.update(db.collection("orders").doc(docId), {
            status: "Confirmé", confirmedAt: FieldValue.serverTimestamp(),
            confirmedBy: "gemini", montantRecu,
            ia_raison: raison, ia_decision: "confirmer",
          });
          return true;
        });
        if (updated) {
          await rtdbUpdateStatus(ordreRef, "Confirmé");
          declencherMacro({ ref: db.collection("orders").doc(docId) }, ordreRef, id1xbet, montantRecu);
        }
      } else if (decision === "rejeter") {
        await db.collection("orders").doc(docId).update({
          status: "Rejeté", rejetedAt: FieldValue.serverTimestamp(),
          flagRaison: "Gemini: " + raison, ia_decision: "rejeter",
        });
        await rtdbUpdateStatus(ordreRef, "Rejeté");
      }
      // "attendre" → ordre reste "En attente"
    } catch (e) {
      console.error("[onNouvelOrdre] Gemini erreur:", e.message);
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 3. AUTO-CONFIRMATION — SMS arrive après l'ordre (cas secondaire)
//    Firestore trigger sur waafi_notifications → cherche l'ordre → Gemini décide
// ══════════════════════════════════════════════════════════════
exports.autoConfirmation = onDocumentCreated(
  { document: "waafi_notifications/{docId}", region: "europe-west1", secrets: [GEMINI_KEY], minInstances: 1, concurrency: 80 },
  async (event) => {
    const sms = event.data.data();

    const transferId = sms.transferIdSMS;
    if (!transferId || !sms.montantSMS) return;

    // Chercher l'ordre "En attente" correspondant
    const ordreSnap = await db.collection("orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();

    if (ordreSnap.empty) {
      console.log(`[autoConfirmation] Aucun ordre en attente pour ${transferId}`);
      return;
    }

    const ordreDoc = ordreSnap.docs[0];
    const ordre    = ordreDoc.data();
    const ordreRef = ordre.orderId || ordre.ref || ordreDoc.id;

    // Gemini décide
    try {
      const { decision, raison } = await geminiDecider(ordre, sms);
      console.log(`[autoConfirmation] Gemini → ${decision} : ${raison}`);

      if (decision === "confirmer") {
        const montantRecu = Number(sms.montantSMS || ordre.montant || 0);
        const id1xbet     = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";
        const updated = await db.runTransaction(async (t) => {
          const snap = await t.get(ordreDoc.ref);
          if (snap.data().status !== "En attente") return false;
          t.update(ordreDoc.ref, {
            status: "Confirmé", confirmedAt: FieldValue.serverTimestamp(),
            confirmedBy: "gemini", montantRecu,
            ia_raison: raison, ia_decision: "confirmer",
          });
          return true;
        });
        if (updated) {
          await rtdbUpdateStatus(ordreRef, "Confirmé");
          declencherMacro(ordreDoc, ordreRef, id1xbet, montantRecu);
        }
      } else if (decision === "rejeter") {
        await ordreDoc.ref.update({
          status: "Rejeté", rejetedAt: FieldValue.serverTimestamp(),
          flagRaison: "Gemini: " + raison, ia_decision: "rejeter",
        });
        await rtdbUpdateStatus(ordreRef, "Rejeté");
      }
    } catch (e) {
      console.error("[autoConfirmation] Gemini erreur:", e.message);
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 4. ORDRE MODIFIÉ → Realtime DB live
// ══════════════════════════════════════════════════════════════
exports.onOrdreUpdated = onDocumentUpdated(
  { document: "orders/{docId}", region: "europe-west1", secrets: [] },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;
    const ref = after.orderId || after.ref || event.params.docId;
    console.log(`[onOrdreUpdated] ${ref} : ${before.status} → ${after.status}`);
    await rtdbUpdateStatus(ref, after.status, { montant: Number(after.montant || 0) });
  }
);

// ══════════════════════════════════════════════════════════════
// 5. GEMINI ANALYSE ADMIN — résumé + prédictions
// ══════════════════════════════════════════════════════════════
exports.geminiAnalyseAdmin = onCall(
  { region: "europe-west1", secrets: [GEMINI_KEY] },
  async () => {
    const snap      = await db.collection("orders").orderBy("createdAt", "desc").limit(100).get();
    const txs       = snap.docs.map(d => d.data());
    const confirmes = txs.filter(t => t.status === "Confirmé");
    const attente   = txs.filter(t => t.status === "En attente");
    const rejetes   = txs.filter(t => t.status === "Rejeté");
    const volume    = confirmes.reduce((s, t) => s + Number(t.montant || 0), 0);
    const taux      = txs.length ? Math.round((confirmes.length / txs.length) * 100) : 0;
    const moyenne   = confirmes.length ? Math.round(volume / confirmes.length) : 0;
    const derniers  = txs.slice(0, 5).map(t => {
      const d = t.createdAt ? t.createdAt.toDate().toLocaleDateString("fr-FR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) : "?";
      return `• ${t.type||"?"} ${Number(t.montant||0)} DJF — ${t.status||"?"} — ${d}`;
    }).join("\n");

    try {
      const data = await geminiJson(
        `Données des 100 dernières transactions :
- Confirmées: ${confirmes.length} — Volume: ${volume.toLocaleString()} DJF
- En attente: ${attente.length} | Rejetées: ${rejetes.length}
- Taux confirmation: ${taux}% | Montant moyen: ${moyenne} DJF
5 dernières : \n${derniers}
Réponds en JSON : {"resume":"...","alerte":null,"conseil":"...","prediction_demain":0,"heure_pic":"?","score_sante":0}`,
        `Tu es le conseiller IA de la direction de Kaffi Pay (Djibouti, 1xBet↔Waafi).
Analyse les performances, identifie les anomalies, donne des recommandations concrètes.`
      );
      return { success: true, data, stats: { confirmes: confirmes.length, attente: attente.length, rejetes: rejetes.length, volume } };
    } catch (e) {
      console.error("[geminiAnalyseAdmin] erreur:", e.message);
      return { success: false, error: "Erreur analyse IA" };
    }
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
          `Texte écran MobCash après recharge :\n"""\n${texteEcran}\n"""\nSuccès: "avec succès","déposé avec","Vous avez déposé",success,credited,completed\nÉchec: "Fonds insuffisants","Rechargez","actualisez",failed,error,insufficient\nRéponds en JSON : {"statut":"succes|echec|inconnu","raison":"...","confiance":0-100}`,
          `Tu vérifies le résultat d'une recharge 1xBet via MobCash (Djibouti). Réponds uniquement selon le texte fourni.`
        );
        analyseIA = result;
        estSucces  = result.statut === "succes";
      } catch (e) {
        const txt = texteEcran.toLowerCase();
        estSucces = /avec succ|déposé avec|vous avez déposé|dépôt|success|credited|completed|deposited/.test(txt);
        analyseIA = { statut: estSucces ? "succes" : "echec", raison: "Mots-clés (Gemini indisponible)", confiance: 70 };
      }
    } else if (resultat === "succes") {
      estSucces = true;
      analyseIA = { statut: "succes", raison: "Détecté par MacroDroid", confiance: 90 };
    } else if (resultat === "echec") {
      analyseIA = { statut: "echec", raison: "Détecté par MacroDroid", confiance: 90 };
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
      console.log(`[rechargeCallback] ✅ ${ref} → RECHARGÉ (tentative ${retries + 1})`);
      res.json({ success: true, ref, recharge: "ok", tentative: retries + 1 });
      return;
    }

    const nouvelleTentative = retries + 1;
    if (nouvelleTentative < 3) {
      await ordreDoc.ref.update({
        status: `Recharge Retry ${nouvelleTentative}/3 ⏳`, rechargeStatus: "retry",
        rechargeRetries: nouvelleTentative, rechargeMessage: "Échec — retry automatique",
        ia_ecran_statut: analyseIA.statut, ia_ecran_raison: analyseIA.raison,
        lastRetryAt: FieldValue.serverTimestamp(),
      });
      try {
        const retryUrl = `${MACRO_DEPOT_URL}&id1xbet=${encodeURIComponent(id1xbet||ordre.userId1xBet||"")}&montant=${montant||ordre.montant}&ref=${ref}&retry=${nouvelleTentative}`;
        await fetch(retryUrl, { signal: AbortSignal.timeout(8000) });
      } catch (e) { console.error("[rechargeCallback] Retry erreur:", e.message); }
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
    console.error(`[rechargeCallback] 🚨 ${ref} → INTERVENTION MANUELLE`);
    res.json({ success: true, ref, recharge: "manuel_requis", tentative: nouvelleTentative });
  }
);
