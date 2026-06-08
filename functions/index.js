/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  KAFFI PAY — CLOUD FUNCTIONS v6.0                                    ║
 * ║                                                                      ║
 * ║  FLOW :                                                              ║
 * ║  1. User paie Waafi → SMS → smsWebhook → waafi_notifications         ║
 * ║  2. User soumet ordre avec Transfer ID                               ║
 * ║  3. onNouvelOrdre cherche la notif correspondante → confirme         ║
 * ║  4. Admin confirme via bot → triggerMacrodroid immédiat              ║
 * ║                                                                      ║
 * ║  Fonctions (7) :                                                     ║
 * ║  [Triggers]  onNouvelOrdre · onOrdreUpdated                          ║
 * ║  [Scheduled] ordresBloques                                           ║
 * ║  [HTTP]      smsWebhook · healthCheck · supportClient · adminBot     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest }                    = require("firebase-functions/v2/https");
const { onSchedule }                           = require("firebase-functions/v2/scheduler");
const { defineSecret }                         = require("firebase-functions/params");
const { initializeApp }                        = require("firebase-admin/app");
const { getFirestore, FieldValue }             = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const REGION = "europe-west1";

const TELEGRAM_TOKEN    = defineSecret("TELEGRAM_TOKEN");
const TELEGRAM_ADMIN_ID = defineSecret("TELEGRAM_ADMIN_CHAT_ID");
const MACRO_WEBHOOK_URL = defineSecret("MACRODROID_WEBHOOK_URL");
const MACRO_SECRET      = defineSecret("MACRODROID_SECRET");
const SUPPORT_BOT_TOKEN = defineSecret("SUPPORT_BOT_TOKEN");

// ══════════════════════════════════════════════════════════════════
// SECTION 1 — STATE MACHINE
// ══════════════════════════════════════════════════════════════════
const TRANSITIONS_VALIDES = {
  "En attente":  ["Confirmé", "Rejeté", "Argent Reçu", "Correction", "Annulé"],
  "Argent Reçu": ["Confirmé", "Rejeté"],
  "Correction":  ["Confirmé", "Rejeté", "En attente"],
  "Confirmé":    [],
  "Rejeté":      [],
  "Annulé":      [],
};

function transitionValide(de, vers) {
  return (TRANSITIONS_VALIDES[de] || []).includes(vers);
}

// ══════════════════════════════════════════════════════════════════
// SECTION 2 — MOTEUR FRAUDE
// ══════════════════════════════════════════════════════════════════
function analyserFraude(tx, transferId) {
  const raisons = [];
  let score     = 0;
  const montant = Number(tx.montant || 0);
  const num     = (tx.numeroPayment || "").replace(/\s/g, "");

  if (montant > 200000)      { score += 50; raisons.push("Montant extrême (> 200 000 DJF)"); }
  else if (montant > 100000) { score += 35; raisons.push("Montant très élevé (> 100 000 DJF)"); }
  else if (montant > 50000)  { score += 15; raisons.push("Montant élevé (> 50 000 DJF)"); }
  else if (montant < 50)     { score += 30; raisons.push("Montant suspect (< 50 DJF)"); }

  if (!transferId) {
    score += 40; raisons.push("Transfer ID manquant");
  } else if (!/^\d{6,}$/.test(String(transferId))) {
    score += 40; raisons.push("Transfer ID invalide (< 6 chiffres)");
  } else if (String(transferId).length > 12) {
    score += 20; raisons.push("Transfer ID anormalement long");
  }

  if (!num)              { score += 10; raisons.push("Numéro expéditeur manquant"); }
  else if (!/^77/.test(num)) { score += 20; raisons.push("Numéro suspect (ne commence pas par 77)"); }

  score = Math.min(score, 100);
  const risque = score >= 70 ? "élevé" : score >= 40 ? "moyen" : "faible";
  const action = score >= 70 ? "rejeter" : score >= 40 ? "vérifier" : "valider";
  return { score_fraude: score, risque, raisons: raisons.length ? raisons : ["Aucune anomalie"], action };
}

// ══════════════════════════════════════════════════════════════════
// SECTION 3 — RATE LIMITING
// ══════════════════════════════════════════════════════════════════
const MAX_PAR_HEURE = 3;

async function verifierRateLimit(phone, type) {
  if (!phone || phone === "—") return { autorise: true };
  const cle      = `${phone}_${type}`;
  const ref      = db.collection("rate_limits").doc(cle);
  const fenetre  = 60 * 60 * 1000;
  const maintenant = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, { compte: 1, debut: maintenant, phone, type, expiresAt: maintenant + fenetre });
      return { autorise: true, restant: MAX_PAR_HEURE - 1 };
    }
    const d = snap.data();
    if (maintenant - d.debut > fenetre) {
      tx.set(ref, { compte: 1, debut: maintenant, phone, type, expiresAt: maintenant + fenetre });
      return { autorise: true, restant: MAX_PAR_HEURE - 1 };
    }
    if (d.compte >= MAX_PAR_HEURE) {
      return { autorise: false, restant: 0, resetDans: Math.ceil((d.debut + fenetre - maintenant) / 60000) };
    }
    tx.update(ref, { compte: FieldValue.increment(1) });
    return { autorise: true, restant: MAX_PAR_HEURE - d.compte - 1 };
  });
}

// ══════════════════════════════════════════════════════════════════
// SECTION 4 — DÉTECTION DOUBLONS
// ══════════════════════════════════════════════════════════════════
async function detecterDoublon(phone, montant, type, excluId) {
  if (!phone || phone === "—") return null;
  const fenetre    = 30 * 60 * 1000;
  const cutoff     = new Date(Date.now() - fenetre);
  const montantMin = montant * 0.95;
  const montantMax = montant * 1.05;

  try {
    const snap = await db.collection("orders")
      .where("numeroPayment", "==", phone).where("type", "==", type)
      .where("status", "in", ["En attente", "Confirmé"]).get();

    for (const doc of snap.docs) {
      if (doc.id === excluId) continue;
      const o  = doc.data();
      const ts = o.createdAt?.toDate ? o.createdAt.toDate() : new Date(o.ts || 0);
      const m  = Number(o.montant || 0);
      if (ts > cutoff && m >= montantMin && m <= montantMax)
        return { ordreId: o.orderId || doc.id, montant: o.montant, status: o.status };
    }
  } catch { /* best-effort */ }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// SECTION 5 — APPEL MACRODROID (direct, temps réel, sans circuit breaker)
// ══════════════════════════════════════════════════════════════════

// Appel direct MacroDroid — utilisé pour confirmations (auto + admin).
// Pas de circuit breaker ici : on déclenche immédiatement à chaque confirmation.
async function triggerMacrodroid(url, ordreId, montant, id1xbet) {
  if (!url) throw new Error("MACRODROID_WEBHOOK_URL non configuré dans Firebase Secrets");
  const webhookUrl = `${url}?id1xbet=${encodeURIComponent(id1xbet)}&montant=${encodeURIComponent(montant)}&ordreid=${encodeURIComponent(ordreId)}`;
  const resp = await fetch(webhookUrl, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`MacroDroid HTTP ${resp.status}`);
  return resp;
}

// Verrou global 20s — une seule instance appelle MacroDroid à la fois.
// Attend en boucle (max ~55s) jusqu'à ce que le verrou soit libre.
async function callMacrodroidLocked(webhookBase, ordreId, montant, id1xbet) {
  const lockRef  = db.collection("system_locks").doc("macrodroid");
  const deadline = Date.now() + 55000;
  while (Date.now() < deadline) {
    const acquired = await db.runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      const last = snap.exists ? (snap.data().at?.toMillis?.() || 0) : 0;
      if (Date.now() - last >= 20000) {
        tx.set(lockRef, { at: FieldValue.serverTimestamp() });
        return true;
      }
      return false;
    }).catch(() => false);
    if (acquired) return triggerMacrodroid(webhookBase, ordreId, montant, id1xbet);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error("MacroDroid occupé depuis > 55s");
}


// ══════════════════════════════════════════════════════════════════
// SECTION 5b — SCORING CORRESPONDANCE (3 critères)
//
//  Règles :
//  3/3 → confirmer automatiquement
//  2/3 → statut "Correction" — client doit resoumettre
//  0-1 → rejeter
//
//  Un critère est "MISMATCH" seulement si la valeur existe dans
//  la notification ET ne correspond pas à l'ordre.
//  Valeur absente (non parsée du SMS) = neutre, ne réduit pas le score.
// ══════════════════════════════════════════════════════════════════
function scorerCorrespondance(ordreData, notifData) {
  const montantOrdre = Number(ordreData.montant || 0);
  const tolerance    = Math.max(5, montantOrdre * 0.05);
  const transferId   = (ordreData.waafitranfertID || ordreData.hash || "").trim();
  const phone        = (ordreData.numeroPayment || ordreData.waafiNumber || "").trim();

  let score = 0;
  const mismatches = [];

  // Critère 1 : Transfer ID
  if (!notifData.transferId || transferId === notifData.transferId) {
    score++;
  } else {
    mismatches.push(
      `Transfer-ID incorrect (ordre: <code>${transferId}</code> / Waafi: <code>${notifData.transferId}</code>)`
    );
  }

  // Critère 2 : Montant ±5%
  if (!notifData.montant || Math.abs(montantOrdre - notifData.montant) <= tolerance) {
    score++;
  } else {
    mismatches.push(
      `Montant incorrect (ordre: <b>${montantOrdre.toLocaleString()} DJF</b> / Waafi: <b>${Number(notifData.montant).toLocaleString()} DJF</b>)`
    );
  }

  // Critère 3 : Numéro expéditeur
  if (!notifData.numClient || phone === notifData.numClient) {
    score++;
  } else {
    mismatches.push(
      `N° expéditeur différent (ordre: <code>${phone}</code> / Waafi: <code>${notifData.numClient}</code>)`
    );
  }

  const decision = score >= 3 ? "confirmer" : score === 2 ? "correction" : "rejeter";
  return { score, mismatches, decision };
}

// ══════════════════════════════════════════════════════════════════
// SECTION 6 — CONFIRMATION DÉPÔT + WEBHOOK MacroDroid
// Appelé par onNouvelOrdre (flux principal) et smsWebhook (cas rare)
// waafiDoc = document waafi_notifications correspondant
// ordreDoc = document orders à confirmer
// ══════════════════════════════════════════════════════════════════
async function confirmerDepot(ordreDoc, waafiDoc, token, adminId) {
  const ordre        = ordreDoc.data();
  const notif        = waafiDoc.data();
  const ordreId      = ordre.orderId || ordreDoc.id;
  const montantOrdre = Number(ordre.montant || 0);
  const montantNotif = notif.montant  || montantOrdre;
  const numReel      = notif.numClient || ordre.numeroPayment || "";

  // scorerCorrespondance a déjà validé la correspondance 3/3 avant d'appeler cette fonction.
  // On enregistre uniquement les corrections mineures (dans la tolérance).
  const corrections = [];
  if (notif.montant && Math.abs(montantOrdre - notif.montant) > 1)
    corrections.push(`Montant corrigé: ${montantOrdre} → ${notif.montant} DJF`);
  if (notif.numClient && ordre.numeroPayment && notif.numClient !== ordre.numeroPayment)
    corrections.push(`N° corrigé: ${ordre.numeroPayment} → ${notif.numClient}`);

  // Confirmation atomique (runTransaction évite les doubles confirmations)
  // ⚠️  waafi_notifications garde son status d'arrivée — on ne le touche plus.
  // Le match est enregistré dans la collection "ordre_traite".
  const traitRef = db.collection("ordre_traite").doc(notif.transferId || ordreId);
  const claimed = await db.runTransaction(async (tx) => {
    const [ordreSnap, traitSnap] = await Promise.all([
      tx.get(ordreDoc.ref),
      tx.get(traitRef),
    ]);
    if (!ordreSnap.exists || ordreSnap.data().status !== "En attente") return false;
    if (traitSnap.exists) return false;

    tx.update(ordreDoc.ref, {
      status: "Confirmé",
      confirmedBy: "auto_match_waafi",
      montantRecu: montantNotif,
      expediteurRecu: numReel,
      correctionApplied: corrections.length > 0,
      corrections,
      confirmedAt: FieldValue.serverTimestamp(),
    });
    tx.set(traitRef, {
      ordreId,
      waafiNotifId: waafiDoc.id,
      transferId: notif.transferId || "",
      montant: montantNotif,
      numClient: numReel,
      userId1xBet: ordre.userId1xBet || "",
      confirmedAt: FieldValue.serverTimestamp(),
      status: "confirmé",
    });
    return true;
  });

  if (!claimed) return false;

  logAudit("depot_confirme_match", { ordreId, transferId: notif.transferId, montant: montantNotif });

  await sendTelegram(token, adminId,
    `✅ <b>Dépôt confirmé automatiquement</b>${corrections.length ? " ✏️" : ""}\n\n` +
    `Ordre: <b>#${ordreId}</b> | <b>${Number(montantNotif).toLocaleString()} DJF</b>\n` +
    `Transfer-ID: <code>${notif.transferId || "?"}</code> | N°: <code>${numReel}</code>` +
    (ordre.whatsapp ? `\nWhatsApp: <code>${ordre.whatsapp}</code>` : "") +
    (corrections.length ? `\n✏️ <i>${corrections.join(" | ")}</i>` : "")
  );

  // MacroDroid est déclenché par onOrdreUpdated dès que status → "Confirmé"
  const id1xbet = ordre.userId1xBet || ordre.id1x || "";
  if (!id1xbet) {
    await sendTelegram(token, adminId,
      `⚠️ <b>ID 1xBet manquant</b> — #${ordreId}\n${Number(montantNotif).toLocaleString()} DJF confirmé.`
    );
  }

  return true;
}

// ══════════════════════════════════════════════════════════════════
// SECTION 7 — AUDIT LOG
// ══════════════════════════════════════════════════════════════════
function logAudit(action, data) {
  db.collection("audit_logs").add({
    action, data: data || {}, ts: FieldValue.serverTimestamp(), source: "cloud-functions",
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════
// SECTION 8 — SUPPORT CLIENT
// Flux : client envoie numéro d'ordre → cherche dans Firestore → affiche statut
// ══════════════════════════════════════════════════════════════════
function statutOrdreMsg(ordreId, o) {
  const montant = Number(o.montant || 0).toLocaleString();
  const type    = o.type || "Ordre";
  const wbOk    = o.webhookStatus === "ok" || o.webhookStatus === "ok_retry_rt";
  const wbFail  = o.webhookStatus === "echec";

  let statut = "";
  if (o.status === "Confirmé" && wbOk)
    statut = "✅ <b>Crédité avec succès</b> — votre compte 1xBet a été rechargé.";
  else if (o.status === "Confirmé" && wbFail)
    statut = "⚠️ <b>Confirmé mais crédit échoué</b> — notre équipe va intervenir.";
  else if (o.status === "Confirmé")
    statut = "✅ <b>Confirmé</b> — crédit 1xBet en cours...";
  else if (o.status === "En attente")
    statut = "⏳ <b>En attente</b> — traitement en cours.";
  else if (o.status === "Argent Reçu")
    statut = "💳 <b>Paiement reçu</b> — confirmation en cours.";
  else if (o.status === "Correction")
    statut = `✏️ <b>Correction requise</b>\n${o.correctionMsg || "Vérifiez votre Transfer ID et resoumettez."}`;
  else if (o.status === "Rejeté")
    statut = `❌ <b>Rejeté</b> — ${o.flagRaison || "Paiement non reçu."}`;
  else if (o.status === "Annulé")
    statut = "🚫 <b>Annulé.</b>";
  else
    statut = `Statut : <b>${o.status}</b>`;

  return (
    `🔍 <b>Ordre #${ordreId}</b>\n` +
    `Type : ${type} | Montant : <b>${montant} DJF</b>\n\n` +
    statut
  );
}

// ══════════════════════════════════════════════════════════════════
// SECTION 9 — ADMIN BOT
// ══════════════════════════════════════════════════════════════════
function traiterAdminBot(text, orders, notifs) {
  const t = text.toLowerCase().trim();

  function parseMontant(l) {
    const m = l.match(/\|\s*([\d\s]+)\s*DJF/);
    return m ? parseFloat(m[1].replace(/\s/g, "")) || 0 : 0;
  }

  const ordreNum = (text.match(/(?:#\s*)?(\d{6,8})\b/) || [])[1] || null;

  if (/^\/stats$/.test(t) || /\b(stats|statistiques|bilan|résumé)\b/.test(t)) {
    const confirmes = orders.filter((o) => o.includes("| Confirmé"));
    const attente   = orders.filter((o) => o.includes("| En attente"));
    const argRecu   = orders.filter((o) => o.includes("| Argent Reçu"));
    const rejetes   = orders.filter((o) => o.includes("| Rejeté"));
    const fraudes   = orders.filter((o) => o.toLowerCase().includes("fraude"));
    const volume    = confirmes.reduce((s, o) => s + parseMontant(o), 0);
    const taux      = orders.length ? Math.round(confirmes.length / orders.length * 100) : 0;
    const moy       = confirmes.length ? Math.round(volume / confirmes.length) : 0;
    return (
      "📊 <b>Statistiques (20 derniers ordres)</b>\n\n" +
      `✅ Confirmés : <b>${confirmes.length}</b>\n` +
      `💳 Argent reçu : <b>${argRecu.length}</b>\n` +
      `⏳ En attente : <b>${attente.length}</b>\n` +
      `❌ Rejetés : <b>${rejetes.length}</b>\n` +
      `🚨 Fraudes : <b>${fraudes.length}</b>\n` +
      `💰 Volume : <b>${volume.toLocaleString()} DJF</b>\n` +
      `📊 Montant moyen : <b>${moy.toLocaleString()} DJF</b>\n` +
      `📈 Taux confirmation : <b>${taux}%</b>`
    );
  }

  if (/^\/ordres?$/.test(t) || t === "ordres" || /\b(attente|pending)\b/.test(t)) {
    const aTraiter = orders.filter((o) => o.includes("| En attente") || o.includes("| Argent Reçu"));
    if (!aTraiter.length) return "✅ Aucun ordre en attente.";
    return `⏳ <b>En attente (${aTraiter.length})</b>\n\n${aTraiter.join("\n")}\n\n<i>Traitement automatique en cours — toutes les 5 min.</i>`;
  }

  if (/^\/fraudes?$/.test(t) || t === "fraudes") {
    const fraudes = orders.filter((o) => o.toLowerCase().includes("fraude"));
    return fraudes.length ? `🚨 <b>Fraudes (${fraudes.length})</b>\n\n${fraudes.join("\n")}` : "✅ Aucune fraude récente.";
  }

  if (/^\/rejet/.test(t) || t === "rejetés") {
    const rejetes = orders.filter((o) => o.includes("| Rejeté"));
    return rejetes.length ? `❌ <b>Rejetés (${rejetes.length})</b>\n\n${rejetes.join("\n")}` : "✅ Aucun rejet récent.";
  }

  if (/^\/sms$/.test(t) || /\b(sms|waafi|notif)\b/.test(t)) {
    return notifs.length ? `📩 <b>SMS Waafi (${notifs.length})</b>\n\n${notifs.join("\n")}` : "📭 Aucun SMS récent.";
  }

  if (ordreNum) {
    const ligne = orders.find((o) => o.includes(`#${ordreNum}`));
    return ligne
      ? `🔍 <b>#${ordreNum}</b>\n\n${ligne}\n\n<i>confirmer ${ordreNum} | rejeter ${ordreNum} raison</i>`
      : `❓ Ordre <b>#${ordreNum}</b> introuvable.\n<i>Essayez : client 77XXXXXXX</i>`;
  }

  return (
    "🤖 <b>Kaffi-Pay — Rapports</b>\n\n" +
    "📊 <code>stats</code> — bilan des 20 derniers ordres\n" +
    "⏳ <code>ordres</code> — ordres en attente\n" +
    "📩 <code>sms</code> — derniers SMS Waafi reçus\n" +
    "📭 <code>nonmatche</code> — SMS sans ordre correspondant\n" +
    "🚨 <code>fraudes</code> — ordres suspects\n" +
    "❌ <code>rejetés</code> — ordres rejetés\n" +
    "👤 <code>client 77123456</code> — ordres d'un numéro\n" +
    "📋 <code>macro jobs</code> — file d'attente MacroDroid\n" +
    "🔄 <code>test macro</code> — tester le webhook\n\n" +
    "<i>Le système confirme et recharge automatiquement.</i>"
  );
}

// ══════════════════════════════════════════════════════════════════
// SECTION 10 — HELPERS
// ══════════════════════════════════════════════════════════════════
async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) console.warn("Telegram error:", resp.status);
  } catch (e) { console.warn("Telegram failed:", e.message); }
}

async function sendTelegramToBot(token, chatId, text) {
  if (!token || !chatId) return false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(8000),
    });
    return resp.ok;
  } catch { return false; }
}

function extractTransferId(text) {
  // Waafi SMS variations: "Transfer Id : 123456", "TransferId:123456", "TID 123456", "Ref: 123456"
  const m = text.match(/Transfer[-\s]?Id\s*[:\s]+\s*(\d+)/i)
         || text.match(/\bTID\s*[:\s]+\s*(\d+)/i)
         || text.match(/\bRef(?:erence)?\s*[:\s]+\s*(\d{6,})/i);
  return m ? m[1].trim() : null;
}

function extractMontant(text) {
  const m = text.match(/Received\s+DJF\s+([\d,]+)/i) ||
            text.match(/transferred\s+DJF\s+([\d,]+)/i) ||
            text.match(/DJF\s*([\d,]+)/i);
  if (!m) return null;
  const val = parseFloat(m[1].replace(/,(?=\d{3})/g, "").replace(",", "."));
  return isNaN(val) ? null : val;
}

function extractNumClient(text, own = "77275572") {
  const ms     = (text.match(/\((\d{8})\)/g) || []).map((s) => s.replace(/[()]/g, ""));
  const others = ms.filter((n) => n !== own);
  if (others.length) return others[0];
  const m = text.match(/from\s+(77\d{6})/i) || text.match(/de\s+(77\d{6})/i);
  return m ? m[1] : (ms[0] || null);
}

// ══════════════════════════════════════════════════════════════════
// TRIGGER 1 — NOUVEL ORDRE  ← MOTEUR PRINCIPAL DE CONFIRMATION
//
//  FLOW PRIMAIRE :
//  1. waafi_notifications arrive en premier (user a payé)
//  2. User soumet l'ordre avec le Transfer ID
//  3. Ce trigger cherche la notif Waafi correspondante
//  4. Si trouvée → confirme + webhook MacroDroid
//
//  ANTI-FRAUDE : si Transfer ID introuvable dans waafi_notifications
//  → le paiement n'existe pas → rejet immédiat
// ══════════════════════════════════════════════════════════════════
exports.onNouvelOrdre = onDocumentCreated(
  {
    document: "orders/{docId}", region: REGION,
    secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, MACRO_SECRET],
    timeoutSeconds: 60,
  },
  async (event) => {
    const tx         = event.data.data();
    const docId      = event.params.docId;
    const ordreId    = tx.orderId || docId;
    const transferId = (tx.waafitranfertID || tx.hash || "").trim();
    const isDepot    = tx.type === "Dépôt";
    const phone      = (tx.numeroPayment || tx.waafiNumber || "").trim();
    const token      = TELEGRAM_TOKEN.value();
    const adminId    = TELEGRAM_ADMIN_ID.value();

    logAudit("nouvel_ordre", { ordreId, type: tx.type, montant: tx.montant, phone });

    // ── FRAUDE 1 : Transfer ID déjà utilisé pour un autre ordre ─
    // Vérifie 3 sources : ordre confirmé, notif matchée, notif traitée.
    // Si trouvé → tentative de réutilisation d'un paiement = FRAUDE.
    if (transferId) {
      const [confirmeSnap, ordreTraiteSnap] = await Promise.all([
        db.collection("orders")
          .where("waafitranfertID", "==", transferId)
          .where("status", "==", "Confirmé").limit(1).get(),
        db.collection("ordre_traite")
          .where("transferId", "==", transferId).limit(1).get(),
      ]);

      const srcConfirme = confirmeSnap.docs[0];
      const srcMatch    = ordreTraiteSnap.docs[0];

      if (srcConfirme || srcMatch) {
        // Récupérer la référence de l'ordre d'origine
        let ancienRef = "inconnu";
        if (srcConfirme) {
          ancienRef = srcConfirme.data().orderId || srcConfirme.id;
        } else if (srcMatch) {
          ancienRef = srcMatch.data().ordreId || srcMatch.id;
        }

        await db.collection("orders").doc(docId).update({
          status: "Rejeté",
          flagRaison: `FRAUDE — Paiement Waafi TID ${transferId} déjà utilisé pour l'ordre #${ancienRef}`,
          flaggedAt: FieldValue.serverTimestamp(),
          fraudType: "tid_reutilise",
          fraudTID: transferId,
          fraudAncienOrdre: ancienRef,
        });

        await sendTelegram(token, adminId,
          `🚨 <b>TENTATIVE DE FRAUDE — Paiement réutilisé</b>\n\n` +
          `Nouvel ordre : <code>#${ordreId}</code>\n` +
          `Transfer-ID : <code>${transferId}</code>\n` +
          `Ce TID a déjà été utilisé pour l'ordre <code>#${ancienRef}</code>.\n\n` +
          `⛔ Ordre <b>rejeté automatiquement</b>.`
        );

        logAudit("fraude_tid_reutilise", { ordreId, transferId, ancienRef, phone });
        return;
      }
    }

    // ── RATE LIMIT ───────────────────────────────────────────────
    if (phone) {
      const rl = await verifierRateLimit(phone, tx.type);
      if (!rl.autorise) {
        await db.collection("orders").doc(docId).update({
          status: "Rejeté",
          flagRaison: `Rate limit — max ${MAX_PAR_HEURE} ordres/heure. Réessayez dans ${rl.resetDans} min.`,
          flaggedAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(token, adminId,
          `⚠️ <b>Rate limit</b>\nN°: <code>${phone}</code> | ${tx.type}\nOrdre <code>#${ordreId}</code> rejeté.`
        );
        return;
      }
    }

    // ── DOUBLON ──────────────────────────────────────────────────
    const doublon = await detecterDoublon(phone, Number(tx.montant), tx.type, docId);
    if (doublon) {
      await db.collection("orders").doc(docId).update({
        doublon_suspect: doublon.ordreId, doublon_alerte: true,
        doublon_at: FieldValue.serverTimestamp(),
      });
      await sendTelegram(token, adminId,
        `⚠️ <b>Possible doublon</b>\nOrdre <code>#${ordreId}</code> ≈ <code>#${doublon.ordreId}</code>\n` +
        `Même n° (${phone}), montant similaire, < 30 min.`
      );
    }

    // ════════════════════════════════════════════════════════════
    //  DÉPÔT — RECHERCHE DE LA NOTIFICATION WAAFI CORRESPONDANTE
    //  C'est le cœur du système : l'user a payé en premier,
    //  le SMS est déjà dans waafi_notifications (status: "prêt")
    // ════════════════════════════════════════════════════════════
    if (isDepot) {
      if (!transferId) {
        await db.collection("orders").doc(docId).update({
          status: "Rejeté",
          flagRaison: "Transfer ID manquant",
          flaggedAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(token, adminId,
          `❌ <b>Dépôt rejeté — Transfer ID manquant</b>\nOrdre: <code>#${ordreId}</code>`
        );
        return;
      }

      // Recherche 1 : par Transfer ID exact (pas de filtre status — status = état à l'arrivée)
      // On vérifie ensuite que ce TID n'est pas déjà dans ordre_traite (déjà utilisé)
      let waafiDoc = null;
      const [byTID, dejaTraiteSnap] = await Promise.all([
        db.collection("waafi_notifications")
          .where("transferId", "==", transferId).limit(1).get(),
        db.collection("ordre_traite")
          .where("transferId", "==", transferId).limit(1).get(),
      ]);

      if (!byTID.empty && dejaTraiteSnap.empty) {
        waafiDoc = byTID.docs[0];
      }

      // Recherche 2 (fallback) : par numéro + montant ±5% si TID pas encore parsé
      if (!waafiDoc && phone) {
        const montantOrdre = Number(tx.montant || 0);
        const tolerance    = Math.max(5, montantOrdre * 0.05);
        const byPhone = await db.collection("waafi_notifications")
          .where("numClient", "==", phone)
          .limit(10).get();

        for (const d of byPhone.docs) {
          const n = d.data();
          if (!n.montant || Math.abs(montantOrdre - n.montant) > tolerance) continue;
          const dejaTID = n.transferId
            ? (await db.collection("ordre_traite").where("transferId", "==", n.transferId).limit(1).get()).empty
            : true;
          if (dejaTID) { waafiDoc = d; break; }
        }
      }

      if (waafiDoc) {
        // Notation trouvée → vérifier les 3 critères
        const ordreSnap  = await db.collection("orders").doc(docId).get();
        const { score, mismatches, decision } = scorerCorrespondance(tx, waafiDoc.data());

        if (decision === "confirmer") {
          // 3/3 — confirmation automatique
          await confirmerDepot(ordreSnap, waafiDoc, token, adminId);
          return;
        }

        if (decision === "correction") {
          // 2/3 — données partiellement incorrectes → correction + resoumettre
          const msgDetails = mismatches.map((m) => `• ${m}`).join("\n");
          await db.collection("orders").doc(docId).update({
            status: "Correction",
            correctionMsg: `Correspondance partielle (${score}/3) — corrigez les informations et resoumettez.\n${mismatches.join(" | ")}`,
            correctionDetails: mismatches,
            correctionScore: score,
            correctionAt: FieldValue.serverTimestamp(),
          });
          await sendTelegram(token, adminId,
            `✏️ <b>Correspondance partielle (${score}/3) — Correction requise</b>\n\n` +
            `Ordre <code>#${ordreId}</code> | ${Number(tx.montant || 0).toLocaleString()} DJF\n\n` +
            `${msgDetails}\n\n` +
            `<i>Le client doit corriger et resoumettre l'ordre.</i>\n` +
            `Forcer si OK : <code>confirmer ${ordreId}</code>`
          );
          logAudit("depot_correction_partielle", { ordreId, score, mismatches });
          return;
        }

        // score ≤ 1 — données trop éloignées → rejet même si notif trouvée
        const msgDetails = mismatches.map((m) => `• ${m}`).join("\n");
        await db.collection("orders").doc(docId).update({
          status: "Rejeté",
          flagRaison: `Données incorrectes (${score}/3) — ${mismatches.join(", ")}`,
          flaggedAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(token, adminId,
          `❌ <b>Dépôt rejeté — Correspondance insuffisante (${score}/3)</b>\n\n` +
          `Ordre <code>#${ordreId}</code>\n${msgDetails}`
        );
        logAudit("depot_rejete_mauvaise_correspondance", { ordreId, score, mismatches });
        return;
      }

      // Aucune notification trouvée → Transfer ID invalide/frauduleux
      await db.collection("orders").doc(docId).update({
        status: "Rejeté",
        flagRaison: `Paiement non reçu — Transfer ID ${transferId} introuvable dans notre système`,
        flaggedAt: FieldValue.serverTimestamp(),
      });
      await sendTelegram(token, adminId,
        `❌ <b>Dépôt rejeté — Paiement introuvable</b>\n\n` +
        `Ordre: <code>#${ordreId}</code>\n` +
        `Transfer-ID: <code>${transferId}</code>\n` +
        `Montant: ${Number(tx.montant || 0).toLocaleString()} DJF\n\n` +
        `<i>Aucune notification Waafi correspondante trouvée.</i>`
      );
      logAudit("depot_rejete_tId_introuvable", { ordreId, transferId });
      return;
    }

    // ════════════════════════════════════════════════════════════
    //  RETRAIT — Analyse fraude + notification admin
    //  Pour un retrait, il n'y a pas de Transfer ID Waafi.
    //  On passe le code de retrait à la place pour vérifier son format.
    // ════════════════════════════════════════════════════════════
    const tidRetrait = (tx.withdrawalCode || "").trim();
    const fraud = analyserFraude(tx, tidRetrait);
    await db.collection("orders").doc(docId).update({
      score_fraude: fraud.score_fraude, risque_fraude: fraud.risque,
      raisons_fraude: fraud.raisons, action_fraude: fraud.action,
      fraudeAnalysedAt: FieldValue.serverTimestamp(),
    });

    if (fraud.action === "rejeter" || fraud.risque === "élevé") {
      await db.collection("orders").doc(docId).update({
        status: "Rejeté", flagRaison: "Fraude: " + fraud.raisons.join(", "),
      });
      await sendTelegram(token, adminId,
        `🚨 <b>Retrait rejeté — Fraude (score ${fraud.score_fraude}/100)</b>\n` +
        `Ordre: <code>#${ordreId}</code> | ${fraud.raisons.join(", ")}`
      );
      logAudit("ordre_rejete_fraude", { ordreId, score: fraud.score_fraude });
      return;
    }

    await sendTelegram(token, adminId,
      `📤 <b>Nouveau Retrait</b>\n` +
      `Ordre: <b>#${ordreId}</b> | <b>${Number(tx.montant).toLocaleString()} DJF</b>\n` +
      `Code: <code>${tx.withdrawalCode || "?"}</code> | N° Waafi: <code>${tx.waafiNumber || "?"}</code>\n` +
      (doublon ? "⚠️ <i>Doublon possible</i>\n" : "") +
      `Risque: <i>${fraud.risque} (${fraud.score_fraude}/100)</i>`
    );
  }
);

// ══════════════════════════════════════════════════════════════════
// TRIGGER 2 — ORDRE MIS À JOUR (State Machine)
// ══════════════════════════════════════════════════════════════════
exports.onOrdreUpdated = onDocumentUpdated(
  {
    document: "orders/{docId}",
    region: REGION,
    secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, MACRO_WEBHOOK_URL],
    timeoutSeconds: 60,
  },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;

    if (!transitionValide(before.status, after.status)) {
      console.warn(`Transition invalide ignorée: ${before.status} → ${after.status}`);
      return;
    }

    const ordreId  = after.orderId || event.params.docId;
    const montant  = Number(after.montant || 0).toLocaleString();
    const type     = after.type || "Ordre";
    const token    = TELEGRAM_TOKEN.value();
    const adminId  = TELEGRAM_ADMIN_ID.value();

    logAudit("transition_statut", { ordreId, de: before.status, vers: after.status, par: after.confirmedBy || "?" });

    let msg = "";
    if (after.status === "Confirmé")
      msg = `✅ <b>${type} confirmé</b>\n#${ordreId} — ${montant} DJF\n` +
            (after.confirmedBy === "admin_telegram" ? "👤 Via bot admin"
              : after.confirmedBy?.startsWith("auto") ? "🤖 Automatique" : "👤 Manuel");
    else if (after.status === "Rejeté")
      msg = `❌ <b>${type} rejeté</b>\n#${ordreId} — ${after.flagRaison || "Raison inconnue"}`;
    else if (after.status === "Argent Reçu")
      msg = `💳 <b>Paiement Waafi reçu</b>\n#${ordreId} — ${montant} DJF\nCrédit 1xBet en cours…`;
    else if (after.status === "Correction")
      msg = `✏️ <b>Correction demandée</b>\n#${ordreId}\n${after.correctionMsg || ""}`;

    if (msg) await sendTelegram(token, adminId, msg);

    // ── MacroDroid — uniquement quand → "Confirmé" ──
    // callMacrodroidLocked attend le verrou 20s (max 55s) avant d'appeler.
    if (after.status !== "Confirmé") return;

    const id1xbet    = after.userId1xBet || after.id1x || "";
    const montantVal = Number(after.montant || 0);
    const webhookBase = MACRO_WEBHOOK_URL.value() || "";

    if (!id1xbet || !webhookBase) return;

    try {
      await callMacrodroidLocked(webhookBase, ordreId, montantVal, id1xbet);
      await event.data.after.ref.update({ webhookStatus: "ok", webhookAt: FieldValue.serverTimestamp() });
      logAudit("macrodroid_ok", { ordreId, id1xbet });
    } catch (e) {
      await event.data.after.ref.update({ webhookStatus: "echec", webhookErr: e.message });
      await sendTelegram(token, adminId,
        `⚠️ <b>MacroDroid échoué</b> — #${ordreId}\n<code>${e.message}</code>`);
      logAudit("macrodroid_echec", { ordreId, err: e.message });
    }
  }
);


// ══════════════════════════════════════════════════════════════════
// HTTP — MACRO JOB QUEUE (polling par MacroDroid)
//
//  MacroDroid configure un timer toutes les 60s :
//  1. GET /macroJob?secret=xxx              → retourne le prochain job
//  2. Traiter la recharge 1xBet
//  3. GET /macroJob?secret=xxx&done=JOBID  → valider le job
//
//  Chaque job Firestore : { ordreId, id1xbet, montant, status }
//  status: pending → processing → done | failed
// ══════════════════════════════════════════════════════════════════
exports.macroJob = onRequest(
  { region: REGION, secrets: [MACRO_SECRET, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const secret   = req.query.secret || (req.body || {}).secret || "";
    const expected = MACRO_SECRET.value() || "KaffiPay2026";
    if (!secret || secret !== expected) { res.status(403).json({ error: "Unauthorized" }); return; }

    const token   = TELEGRAM_TOKEN.value();
    const adminId = TELEGRAM_ADMIN_ID.value();

    // ── ACK : MacroDroid confirme le résultat d'une recharge ─────
    // MacroDroid appelle : ?secret=xxx&done={lv=ordreid}&status=ok  (ou failed)
    const ordreId = req.query.done || (req.body || {}).done || "";
    if (ordreId) {
      const isOk = (req.query.status || (req.body || {}).status || "ok") !== "failed";

      const ordSnap = await db.collection("orders").where("orderId", "==", ordreId).limit(1).get();
      if (ordSnap.empty) { res.json({ ok: false, error: "Ordre introuvable" }); return; }

      const oDoc  = ordSnap.docs[0];
      const oData = oDoc.data();

      await oDoc.ref.update({
        webhookStatus:    isOk ? "ok_confirmed" : "echec_confirmed",
        webhookConfirmedAt: FieldValue.serverTimestamp(),
      });

      logAudit(isOk ? "macrodroid_confirmed_ok" : "macrodroid_confirmed_failed", {
        ordreId, id1xbet: oData.userId1xBet || oData.id1x || "?",
      });

      if (isOk) {
        await sendTelegram(token, adminId,
          `✅ <b>Recharge confirmée par MacroDroid</b>\n` +
          `#${ordreId} | <code>${oData.userId1xBet || oData.id1x || "?"}</code> | ${Number(oData.montant || 0).toLocaleString()} DJF`);
      } else {
        await sendTelegram(token, adminId,
          `❌ <b>Recharge échouée (MacroDroid)</b>\n` +
          `#${ordreId} | <code>${oData.userId1xBet || oData.id1x || "?"}</code>\n` +
          `Utilise <code>recharge ${ordreId}</code> pour réessayer.`);
      }

      res.json({ ok: true });
      return;
    }

    res.json({ ok: true, info: "ACK endpoint — done=ordreId&status=ok|failed" });
  }
);

// ══════════════════════════════════════════════════════════════════
// SCHEDULED — AUTO-TRAITEMENT (toutes les 5 min)
//
//  1. Ordres "En attente" → cherche SMS correspondant → auto-confirme
//  2. Alerte si ordres > 60 min sans SMS trouvé
// ══════════════════════════════════════════════════════════════════
exports.ordresBloques = onSchedule(
  { schedule: "every 5 minutes", region: REGION, timeoutSeconds: 120, secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID] },
  async () => {
    const token   = TELEGRAM_TOKEN.value();
    const adminId = TELEGRAM_ADMIN_ID.value();

    // ── PARTIE 1 : Ordres En attente → tenter auto-confirmation ────
    const snapAttente = await db.collection("orders")
      .where("status", "==", "En attente")
      .get().catch(() => ({ docs: [] }));

    let autoConfirmes = 0;

    for (const ordreDoc of snapAttente.docs) {
      const ordre = ordreDoc.data();
      const tid   = ordre.waafitranfertID || ordre.hash || "";
      if (!tid) continue;

      // Déjà traité ?
      const dejaTraite = await db.collection("ordre_traite")
        .where("transferId", "==", tid).limit(1).get();
      if (!dejaTraite.empty) continue;

      // Cherche le SMS correspondant
      const notifSnap = await db.collection("waafi_notifications")
        .where("transferId", "==", tid).limit(1).get();
      if (notifSnap.empty) continue;

      const waafiDoc = notifSnap.docs[0];
      const { decision } = scorerCorrespondance(ordre, waafiDoc.data());

      if (decision === "confirmer") {
        const ok = await confirmerDepot(ordreDoc, waafiDoc, token, adminId);
        if (ok) autoConfirmes++;
      } else if (decision === "correction") {
        const { score, mismatches } = scorerCorrespondance(ordre, waafiDoc.data());
        await ordreDoc.ref.update({
          status: "Correction",
          correctionMsg: `Correspondance partielle (${score}/3) — corrigez et resoumettez.\n${mismatches.join(" | ")}`,
          correctionDetails: mismatches, correctionScore: score,
          correctionAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(token, adminId,
          `✏️ <b>Correction auto (${score}/3)</b>\nOrdre <code>#${ordre.orderId || ordreDoc.id}</code>\n` +
          mismatches.map((m) => `• ${m}`).join("\n")
        );
      }
    }

    // ── PARTIE 2 : Alerte ordres > 60 min sans SMS trouvé ─────────
    const cutoff60 = new Date(Date.now() - 60 * 60 * 1000);
    const alertRef  = db.collection("alertes_etat").doc("ordres_bloques");
    const alertSnap = await alertRef.get();
    if (alertSnap.exists) {
      const last = alertSnap.data().ts?.toDate?.() || new Date(0);
      if (Date.now() - last.getTime() < 60 * 60 * 1000) return;
    }

    const reSnapAttente = await db.collection("orders")
      .where("status", "==", "En attente").get().catch(() => ({ docs: [] }));

    const vieux = reSnapAttente.docs.filter((d) => {
      const ts = d.data().ts;
      return ts && new Date(ts) < cutoff60;
    });

    if (!vieux.length) return;

    const lignes = vieux.map((d) => {
      const o   = d.data();
      const age = Math.round((Date.now() - o.ts) / 60000);
      return `• #${o.orderId || d.id} | ${o.montant} DJF | ⏱ ${age}min | TID:${o.waafitranfertID || "?"}`;
    });

    await sendTelegram(token, adminId,
      `⚠️ <b>${vieux.length} ordre(s) > 60 min sans SMS Waafi</b>\n\n${lignes.join("\n")}\n\n` +
      `<i>SMS Waafi introuvable — vérifiez le paiement.</i>`
    );

    await alertRef.set({ ts: FieldValue.serverTimestamp(), count: vieux.length });
  }
);


// ══════════════════════════════════════════════════════════════════
// HTTP — WEBHOOK MACRODROID (réception SMS Waafi)
// Parse le SMS, stocke dans waafi_notifications, alerte admin.
// Cas rare : si un ordre "En attente" avec ce TID existe déjà,
// confirme directement (ordre soumis avant l'arrivée du SMS).
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
    if (secret && secret !== expectedSecret) { res.status(403).json({ error: "Secret invalide" }); return; }
    if (!notif) { res.status(400).json({ error: "Champ 'notification' requis" }); return; }

    const transferId = extractTransferId(notif);
    const montant    = extractMontant(notif);
    const numClient  = extractNumClient(notif);

    const docRef = await db.collection("waafi_notifications").add({
      notification: notif, transferId, montant, numClient,
      secret: expectedSecret, source: "macrodroid",
      processedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });

    res.json({ success: true, id: docRef.id });

    // Alerte admin — exécuté après la réponse
    const token   = TELEGRAM_TOKEN.value();
    const adminId = TELEGRAM_ADMIN_ID.value();

    if (!transferId && !montant) return; // SMS non parsable

    await sendTelegram(token, adminId,
      `📩 <b>SMS Waafi reçu — Paiement enregistré</b>\n\n` +
      `Transfer-ID: <code>${transferId || "?"}</code>\n` +
      `Montant: <b>${montant ? Number(montant).toLocaleString() : "?"} DJF</b>\n` +
      `Expéditeur: <code>${numClient || "?"}</code>\n\n` +
      `<i>✅ En attente de l'ordre client — confirmation automatique dès soumission.</i>`
    );

    // Cas rare : ordre déjà soumis avant que le SMS arrive
    if (!transferId) return;

    const ordreSnap = await db.collection("orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();

    if (ordreSnap.empty) return;

    const dejaTraite = await db.collection("ordre_traite")
      .where("transferId", "==", transferId).limit(1).get();
    if (!dejaTraite.empty) return;

    const ordreDoc  = ordreSnap.docs[0];
    const waafiSnap = await docRef.get();
    const { score, mismatches, decision } = scorerCorrespondance(ordreDoc.data(), waafiSnap.data());
    const ordreRef2   = ordreDoc.data().orderId || ordreDoc.id;

    if (decision === "confirmer") {
      await confirmerDepot(ordreDoc, waafiSnap, token, adminId);
    } else if (decision === "correction") {
      await ordreDoc.ref.update({
        status: "Correction",
        correctionMsg: `Correspondance partielle (${score}/3) — corrigez et resoumettez.\n${mismatches.join(" | ")}`,
        correctionDetails: mismatches, correctionScore: score,
        correctionAt: FieldValue.serverTimestamp(),
      });
      await sendTelegram(token, adminId,
        `✏️ <b>Correction requise (${score}/3)</b>\n\nOrdre <code>#${ordreRef2}</code>\n` +
        mismatches.map((m) => `• ${m}`).join("\n") + `\n\n<i>Le client doit corriger et resoumettre.</i>`
      );
    } else {
      await ordreDoc.ref.update({
        status: "Rejeté",
        flagRaison: `Données incorrectes (${score}/3) — ${mismatches.join(", ")}`,
        flaggedAt: FieldValue.serverTimestamp(),
      });
      await sendTelegram(token, adminId,
        `❌ <b>Correspondance insuffisante (${score}/3)</b>\nOrdre <code>#${ordreRef2}</code>\n` +
        mismatches.map((m) => `• ${m}`).join("\n")
      );
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — HEALTH CHECK
// ══════════════════════════════════════════════════════════════════
exports.healthCheck = onRequest(
  { region: REGION, secrets: [] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const t0 = Date.now();
    let firestoreMs = "?", statut = "ok";
    try {
      await db.collection("orders").limit(1).get();
      firestoreMs = `${Date.now() - t0}ms`;
    } catch (e) { firestoreMs = `erreur: ${e.message}`; statut = "degraded"; }

    res.json({
      statut, timestamp: new Date().toISOString(), region: REGION,
      firestore: firestoreMs, version: "6.0",
      flow: "sms_webhook → waafi_notifications → onNouvelOrdre → confirmerDepot",
      exports: 7,
    });
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — SUPPORT CLIENT
// Flux simple : client donne numéro d'ordre → Firestore → affiche statut
// ══════════════════════════════════════════════════════════════════
exports.supportClient = onRequest(
  { region: REGION, secrets: [SUPPORT_BOT_TOKEN, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, MACRO_WEBHOOK_URL], timeoutSeconds: 60 },
  async (req, res) => {
    res.status(200).send("OK");

    const msg          = (req.body || {}).message || (req.body || {}).edited_message;
    if (!msg) return;
    const chatId       = String(msg.chat.id);
    const text         = (msg.text || "").trim();
    const firstName    = (msg.from || {}).first_name || "Client";
    const supportToken = SUPPORT_BOT_TOKEN.value();
    if (!text || !supportToken) return;

    const send = (txt) => sendTelegramToBot(supportToken, chatId, txt + "\n\n— <i>Support Kaffi-Pay</i>");

    try {
      const t = text.toLowerCase().trim();

      // Extraire le numéro d'ordre (5-8 chiffres, avec ou sans #)
      const ordreMatch = text.match(/(?:#\s*)?(\d{5,8})\b/i);
      const ordreId    = ordreMatch ? ordreMatch[1] : null;

      // ── /start ──
      if (t === "/start" || t === "start") {
        await sendTelegramToBot(supportToken, chatId,
          `👋 <b>Bienvenue sur le Support Kaffi-Pay !</b>\n\n` +
          `Je suis votre assistant automatique — disponible <b>24h/24</b>.\n\n` +
          `<b>Ce que je peux faire :</b>\n` +
          `🔍 Vérifier le statut de votre ordre\n` +
          `⚡ Relancer un crédit bloqué\n` +
          `❓ Répondre à vos questions\n\n` +
          `<b>Pour commencer :</b> envoyez votre <b>numéro d'ordre</b>\n` +
          `Exemple : <code>#06073</code>\n\n` +
          `Tapez <b>aide</b> pour voir toutes les commandes.`
        );
        return;
      }

      // ── Salutations (Français + Arabe + Somali) ──
      if (/^(bonjour|salut|bonsoir|hello|salam|hi|allo|allô|bjr|bj|nabad|marhaba|ahlan|asalam|salaamu|wa calaykum|مرحبا|السلام)\b/.test(t)) {
        await send(
          `Bonjour ${firstName} ! 👋\n\n` +
          `Je suis le support Kaffi-Pay.\n\n` +
          `Envoyez votre <b>numéro d'ordre</b> pour voir son statut.\n` +
          `Exemple : <code>#06073</code>\n\n` +
          `Tapez <b>aide</b> pour toutes les options.`
        );
        return;
      }

      // ── Aide / Menu ──
      if (/^(aide|help|menu|option|commande|que.*faire|quoi.*faire)/.test(t)) {
        await send(
          `📋 <b>Commandes disponibles</b>\n\n` +
          `🔍 <code>#XXXXX</code> — Statut de votre ordre\n` +
          `❓ <b>comment ça marche</b> — Explications\n` +
          `⏱️ <b>délai</b> — Temps de traitement\n` +
          `💰 <b>tarifs</b> — Frais et limites\n` +
          `📤 <b>retrait</b> — Info sur les retraits\n` +
          `🚫 <b>annuler</b> — Comment annuler un ordre\n` +
          `👤 <b>agent</b> — Parler à un humain\n\n` +
          `Ou envoyez directement votre numéro d'ordre.`
        );
        return;
      }

      // ── Comment ça marche ──
      if (/comment.*(fonc|march|utilis)|étape|procédure|expliqu|process/.test(t)) {
        await send(
          `ℹ️ <b>Comment fonctionne Kaffi-Pay ?</b>\n\n` +
          `<b>📥 Dépôt 1xBet :</b>\n` +
          `1️⃣ Allez sur <b>kaffi-pay.com</b> → onglet Dépôt\n` +
          `2️⃣ Remplissez : montant, ID 1xBet, WhatsApp\n` +
          `3️⃣ Payez via Waafi au numéro <code>77275572</code>\n` +
          `4️⃣ Notez le <b>Waafi Transfer ID</b> reçu par SMS\n` +
          `5️⃣ Renseignez-le dans le formulaire → soumettez\n` +
          `6️⃣ Votre compte 1xBet est crédité <b>automatiquement</b>\n\n` +
          `<b>📤 Retrait 1xBet :</b>\n` +
          `1️⃣ Sur 1xBet → Finances → Retirer → Code de retrait\n` +
          `2️⃣ Sur kaffi-pay.com → onglet Retrait\n` +
          `3️⃣ Entrez le code + votre numéro Waafi\n` +
          `4️⃣ Recevez l'argent sur Waafi\n\n` +
          `Pour suivre : envoyez votre <code>#numéro_ordre</code>`
        );
        return;
      }

      // ── Délais ──
      if (/délai|durée|combien.*temps|quand.*confirm|vite|rapide|attente/.test(t)) {
        await send(
          `⏱️ <b>Temps de traitement</b>\n\n` +
          `• Confirmation automatique : <b>1 à 5 min</b>\n` +
          `• Crédit 1xBet : <b>moins de 2 min</b> après confirmation\n` +
          `• Vérification manuelle (rare) : <b>max 30 min</b>\n\n` +
          `📅 Service disponible <b>24h/24 — 7j/7</b>\n\n` +
          `Si votre ordre attend depuis plus de 30 min,\nenvoyez votre <b>numéro d'ordre</b> ici.`
        );
        return;
      }

      // ── Tarifs ──
      if (/tarif|frais|commiss|coût|prix|combien.*payer|minimum/.test(t)) {
        await send(
          `💰 <b>Tarifs Kaffi-Pay</b>\n\n` +
          `• Dépôt minimum : <b>50 DJF</b>\n` +
          `• Retrait minimum : <b>250 DJF</b>\n` +
          `• Commission : <b>0 DJF</b> — aucun frais !\n` +
          `• Vous recevez exactement le montant envoyé\n\n` +
          `Numéro Waafi pour payer : <code>77275572</code>`
        );
        return;
      }

      // ── Retrait ──
      if (/^retrait|retirer.*argent|code.*retrait|retrait.*1xbet|comment.*retirer/.test(t)) {
        await send(
          `📤 <b>Comment effectuer un retrait 1xBet</b>\n\n` +
          `1️⃣ Sur 1xBet → <b>Finances → Retirer des fonds</b>\n` +
          `2️⃣ Choisissez <b>"Code de retrait"</b>\n` +
          `3️⃣ Saisissez le montant souhaité\n` +
          `4️⃣ Copiez le <b>code de retrait</b> généré\n` +
          `5️⃣ Allez sur <b>kaffi-pay.com</b> → onglet Retrait\n` +
          `6️⃣ Renseignez le code + votre numéro Waafi\n` +
          `7️⃣ Recevez l'argent sur votre compte Waafi ✅\n\n` +
          `⚠️ Le code de retrait expire en <b>24 heures</b>.`
        );
        return;
      }

      // ── Annulation ──
      if (/annul|cancel|suppr.*ordre|comment.*annul/.test(t)) {
        await send(
          `🚫 <b>Annuler un ordre</b>\n\n` +
          `Vous pouvez annuler uniquement si l'ordre est <b>"En attente"</b>.\n\n` +
          `<b>Comment annuler :</b>\n` +
          `1️⃣ Allez sur <b>kaffi-pay.com</b>\n` +
          `2️⃣ Retrouvez votre ordre dans l'historique\n` +
          `3️⃣ Cliquez sur le bouton <b>🚫 Annuler cet ordre</b>\n\n` +
          `⚠️ Un ordre <b>Confirmé</b> ne peut pas être annulé.\n\n` +
          `Envoyez votre numéro d'ordre si vous avez besoin d'aide.`
        );
        return;
      }

      // ── "Pas reçu" / "Non crédité" / problème général ──
      if (/pas.*reçu|non.*crédit|pas.*crédit|toujours.*pas|n'a pas|pas.*arrivé|problem|problème|erreur|pas.*fonc|pas.*march/.test(t)) {
        await send(
          `⚠️ <b>Problème avec votre ordre ?</b>\n\n` +
          `Je vais vérifier immédiatement.\n\n` +
          `Envoyez votre <b>numéro d'ordre</b> :\n` +
          `Exemple : <code>#06073</code>\n\n` +
          `Votre numéro d'ordre se trouve sur <b>kaffi-pay.com</b> dans l'historique.`
        );
        return;
      }

      // ── Demande d'agent humain ──
      if (/agent|humain|opérateur|parler.*quelqu|quelqu.*humain|personne|responsable|admin|réel/.test(t)) {
        const adminToken2 = TELEGRAM_TOKEN.value();
        const adminId3    = TELEGRAM_ADMIN_ID.value();
        await send(
          `👤 <b>Mise en relation avec un agent</b>\n\n` +
          `Votre demande a été transmise à notre équipe.\n` +
          `Un agent vous répondra dans les plus brefs délais.\n\n` +
          `Pour accélérer le traitement, envoyez votre <b>numéro d'ordre</b>.`
        );
        await sendTelegram(adminToken2, adminId3,
          `🆘 <b>Demande d'agent humain</b>\n` +
          `👤 ${firstName} (chatId: <code>${chatId}</code>)\n` +
          `Message : <i>${text.substring(0, 200)}</i>`
        );
        return;
      }

      // ── Numéro d'ordre détecté → chercher dans Firestore ──
      if (ordreId) {
        const snap = await db.collection("orders").where("orderId", "==", ordreId).limit(1).get();
        if (snap.empty) {
          await send(
            `❓ Ordre <b>#${ordreId}</b> introuvable.\n\n` +
            `Vérifiez votre numéro d'ordre sur <b>kaffi-pay.com</b>.\n` +
            `Le numéro d'ordre fait 5 à 8 chiffres (ex: <code>#06073</code>).`
          );
          return;
        }
        const o          = snap.docs[0].data();
        const oRef       = snap.docs[0].ref;
        const wbOk       = o.webhookStatus === "ok" || o.webhookStatus === "ok_retry_rt";
        const adminToken = TELEGRAM_TOKEN.value();
        const adminId2   = TELEGRAM_ADMIN_ID.value();

        // ── Confirmé mais non crédité → support bot relance MacroDroid ──
        if (o.status === "Confirmé" && !wbOk) {
          const id1xbet = o.userId1xBet || o.id1x || "";
          if (!id1xbet) {
            await send(
              `⚠️ Votre dépôt est confirmé mais votre <b>ID 1xBet est manquant</b>.\n` +
              `Notre équipe va vous contacter sous peu.`
            );
            await sendTelegram(adminToken, adminId2,
              `🆘 <b>ID 1xBet manquant</b> — 👤 ${firstName}\nOrdre <b>#${ordreId}</b> | ${Number(o.montant||0).toLocaleString()} DJF`);
            return;
          }
          const wbUrl = (MACRO_WEBHOOK_URL && MACRO_WEBHOOK_URL.value) ? MACRO_WEBHOOK_URL.value() : "";
          await send(
            `✅ <b>Dépôt confirmé — Crédit en cours</b>\n\n` +
            `Ordre : <b>#${ordreId}</b> | ${Number(o.montant||0).toLocaleString()} DJF\n` +
            `ID 1xBet : <code>${id1xbet}</code>\n\n` +
            `⏱️ Votre compte sera crédité sous peu.`
          );
          await sendTelegram(adminToken, adminId2,
            `📋 <b>Support → relance MacroDroid</b> — 👤 ${firstName}\nOrdre <b>#${ordreId}</b> | <code>${id1xbet}</code>`);
          if (wbUrl) {
            try {
              await callMacrodroidLocked(wbUrl, ordreId, o.montant || 0, id1xbet);
              await oRef.update({ webhookStatus: "ok", webhookAt: FieldValue.serverTimestamp() });
              logAudit("macrodroid_ok_support", { ordreId, clientName: firstName });
            } catch (err) {
              await oRef.update({ webhookStatus: "echec", webhookErr: err.message });
              await sendTelegram(adminToken, adminId2,
                `⚠️ MacroDroid échoué (support) — #${ordreId}\n<code>${err.message}</code>`);
            }
          }
          return;
        }

        // ── Confirmé + crédité mais client réclame → alerte admin ──
        if (o.status === "Confirmé" && wbOk) {
          await send(
            statutOrdreMsg(ordreId, o) +
            `\n\n📞 Si le crédit n'apparaît pas sur 1xBet, attendez 2 min puis vérifiez.\n` +
            `Si le problème persiste, notre équipe est alertée.`
          );
          await sendTelegram(adminToken, adminId2,
            `🆘 <b>Crédit envoyé mais client réclame</b> — 👤 ${firstName}\nOrdre <b>#${ordreId}</b>\nForcer : <code>recharge ${ordreId}</code>`);
          return;
        }

        // ── Rejeté → explication + actions ──
        if (o.status === "Rejeté") {
          await send(
            statutOrdreMsg(ordreId, o) +
            `\n\n<b>Que faire ?</b>\n` +
            `• Vérifiez que votre Transfer ID est correct\n` +
            `• Soumettez un <b>nouvel ordre</b> sur kaffi-pay.com\n` +
            `• En cas de doute, contactez le support`
          );
          await sendTelegram(adminToken, adminId2,
            `🆘 <b>Support</b> | 👤 ${firstName} | <b>#${ordreId}</b> (Rejeté)\nRaison : ${o.flagRaison || "?"}`);
          return;
        }

        // ── Correction requise ──
        if (o.status === "Correction") {
          await send(
            statutOrdreMsg(ordreId, o) +
            `\n\n<b>Comment corriger :</b>\n` +
            `1️⃣ Allez sur kaffi-pay.com\n` +
            `2️⃣ Retrouvez votre ordre #${ordreId}\n` +
            `3️⃣ Cliquez sur <b>✏️ Corriger mon ordre</b>\n` +
            `4️⃣ Soumettez les informations corrigées`
          );
          await sendTelegram(adminToken, adminId2,
            `🆘 <b>Support</b> | 👤 ${firstName} | <b>#${ordreId}</b> (Correction)`);
          return;
        }

        // ── Autres statuts (En attente, Argent Reçu…) ──
        await send(statutOrdreMsg(ordreId, o));
        return;
      }

      // ── Aucun ordre ID trouvé — fallback ──
      await send(
        `Pour vérifier votre ordre, envoyez votre <b>numéro d'ordre</b>.\n\n` +
        `Exemple : <code>#06073</code>\n\n` +
        `Tapez <b>aide</b> pour voir toutes les options disponibles.`
      );

    } catch (e) {
      console.error("supportClient crash:", e.message, e.stack);
      try { await send("Désolé, une erreur s'est produite. Réessayez dans quelques instants."); } catch {}
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — ADMIN BOT
// ══════════════════════════════════════════════════════════════════
exports.adminBot = onRequest(
  { region: REGION, secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, SUPPORT_BOT_TOKEN, MACRO_WEBHOOK_URL, MACRO_SECRET], timeoutSeconds: 60 },
  async (req, res) => {
    res.status(200).send("OK");
    try {
      const msg = (req.body || {}).message || (req.body || {}).edited_message;
      if (!msg) return;

      const chatId  = String(msg.chat.id);
      const text    = (msg.text || "").trim();
      const adminId = String(TELEGRAM_ADMIN_ID.value());
      const token   = TELEGRAM_TOKEN.value();

      if (chatId !== adminId || !text) return;
      console.log(`adminBot: "${text}"`);

      const t = text.toLowerCase().trim();

      // confirmer #ID
      const confirmMatch = text.match(/^confirmer?\s+#?(\d{5,8})\b/i);
      if (confirmMatch) {
        const num  = confirmMatch[1];
        const snap = await db.collection("orders").where("orderId", "==", num).limit(1).get();
        if (snap.empty) { await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`); return; }
        const doc  = snap.docs[0]; const data = doc.data();
        if (data.status === "Confirmé") { await sendTelegram(token, adminId, `ℹ️ <b>#${num}</b> déjà confirmé.`); return; }
        if (!transitionValide(data.status, "Confirmé")) {
          await sendTelegram(token, adminId, `⛔ Impossible de confirmer un ordre en statut <b>${data.status}</b>.`); return;
        }

        // Confirmer → onOrdreUpdated déclenche MacroDroid automatiquement
        await doc.ref.update({ status: "Confirmé", confirmedBy: "admin_telegram", confirmedAt: FieldValue.serverTimestamp() });
        logAudit("confirme_admin_telegram", { num, adminId, ancienStatut: data.status });
        const montantVal = Number(data.montant || data.amount || 0);
        await sendTelegram(token, adminId,
          `✅ Ordre <b>#${num}</b> confirmé — ${montantVal.toLocaleString()} DJF\n🔄 MacroDroid en cours de déclenchement...`);
        return;
      }

      // rejeter #ID [raison]
      const rejectMatch = text.match(/^rejeter?\s+#?(\d{5,8})(?:\s+(.+))?$/i);
      if (rejectMatch) {
        const num    = rejectMatch[1];
        const raison = (rejectMatch[2] || "Rejeté par admin").trim();
        const snap   = await db.collection("orders").where("orderId", "==", num).limit(1).get();
        if (snap.empty) { await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`); return; }
        const doc  = snap.docs[0]; const data = doc.data();
        if (data.status === "Rejeté") { await sendTelegram(token, adminId, `ℹ️ <b>#${num}</b> déjà rejeté.`); return; }
        if (!transitionValide(data.status, "Rejeté")) {
          await sendTelegram(token, adminId, `⛔ Impossible de rejeter un ordre en statut <b>${data.status}</b>.`); return;
        }
        await doc.ref.update({ status: "Rejeté", flagRaison: raison, rejectedBy: "admin_telegram", flaggedAt: FieldValue.serverTimestamp() });
        logAudit("rejete_admin_telegram", { num, raison, adminId });
        await sendTelegram(token, adminId, `❌ Ordre <b>#${num}</b> rejeté.\nRaison : <i>${raison}</i>`);
        return;
      }

      // client 77XXXXXXX
      const clientMatch = text.match(/^client\s+((?:77|78|70|71|21)\d{6})\b/i);
      if (clientMatch) {
        const phone = clientMatch[1];
        const snap  = await db.collection("orders").where("numeroPayment", "==", phone)
          .orderBy("ts", "desc").limit(10).get()
          .catch(() => db.collection("orders").where("numeroPayment", "==", phone).limit(10).get());
        if (snap.empty) { await sendTelegram(token, adminId, `❓ Aucun ordre pour <code>${phone}</code>.`); return; }
        const lignes = snap.docs.map((d) => { const o = d.data(); return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status}`; });
        await sendTelegram(token, adminId, `👤 <b>Ordres ${phone} (${snap.size})</b>\n\n${lignes.join("\n")}`);
        return;
      }

      // alerte
      if (t === "alerte" || t === "/alerte") {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000);
        const snap   = await db.collection("orders").where("status", "==", "En attente")
          .orderBy("ts", "asc").get()
          .catch(() => db.collection("orders").where("status", "==", "En attente").get());
        const vieux = snap.docs.filter((d) => { const ts = d.data().ts; return ts && new Date(ts) < cutoff; });
        if (!vieux.length) { await sendTelegram(token, adminId, "✅ Aucun ordre en attente > 30 min."); return; }
        const lignes = vieux.map((d) => {
          const o = d.data(); const age = Math.round((Date.now() - o.ts) / 60000);
          return `• #${o.orderId || d.id} | ${o.montant} DJF | ⏱ ${age}min`;
        });
        await sendTelegram(token, adminId, `⚠️ <b>Bloqués > 30 min (${vieux.length})</b>\n\n${lignes.join("\n")}\n\n<i>confirmer #ID | rejeter #ID raison</i>`);
        return;
      }

      // nonmatche — notifs reçues mais pas encore dans ordre_traite
      if (t === "nonmatche" || t === "/nonmatche") {
        const [notifSnap2, traitSnap2] = await Promise.all([
          db.collection("waafi_notifications").orderBy("processedAt", "desc").limit(20).get()
            .catch(() => db.collection("waafi_notifications").limit(20).get()),
          db.collection("ordre_traite").limit(100).get(),
        ]);
        const tidTraites = new Set(traitSnap2.docs.map((d) => d.data().transferId));
        const snap = { docs: notifSnap2.docs.filter((d) => {
          const n = d.data();
          return n.processedAt && n.transferId && !tidTraites.has(n.transferId);
        }), empty: false };
        snap.empty = snap.docs.length === 0;
        if (snap.empty) { await sendTelegram(token, adminId, "✅ Aucun SMS en attente."); return; }
        const lignes = snap.docs.map((d) => {
          const n = d.data();
          return `• TID:${n.transferId || "?"} | ${n.montant || "?"}DJF | N°${n.numClient || "?"} | ${n.status}`;
        });
        await sendTelegram(token, adminId, `📭 <b>SMS en attente (${snap.size})</b>\n\n${lignes.join("\n")}`);
        return;
      }

      // test macro — vérifie que MacroDroid répond
      if (t === "test macro" || t === "/test_macro") {
        const wbUrl = MACRO_WEBHOOK_URL.value() || "";
        if (!wbUrl) { await sendTelegram(token, adminId, "❌ MACRODROID_WEBHOOK_URL non configuré dans Firebase Secrets."); return; }
        await sendTelegram(token, adminId, `🔄 Test MacroDroid...\n<code>${wbUrl.substring(0, 60)}...</code>`);
        try {
          await triggerMacrodroid(wbUrl, "TEST", 0, "TEST");
          await sendTelegram(token, adminId, "✅ MacroDroid répond correctement !");
        } catch (e) {
          await sendTelegram(token, adminId,
            `❌ MacroDroid ne répond pas :\n<code>${e.message}</code>\n\n` +
            "Vérifiez que :\n• MacroDroid est ouvert sur le téléphone\n• Le webhook est bien configuré dans MacroDroid\n• L'URL dans Firebase Secrets est correcte");
        }
        return;
      }

      // macro jobs — file d'attente MacroDroid
      if (t === "macro jobs" || t === "/macro_jobs") {
        const [pendSnap, procSnap] = await Promise.all([
          db.collection("macrodroid_jobs").where("status", "==", "pending").limit(10).get(),
          db.collection("macrodroid_jobs").where("status", "==", "processing").limit(10).get(),
        ]);
        const docs = [...pendSnap.docs, ...procSnap.docs];
        if (!docs.length) { await sendTelegram(token, adminId, "✅ File MacroDroid vide — aucun job en attente."); return; }
        const lignes = docs.map(d => {
          const j = d.data();
          return `• #${j.ordreId} | ID:${j.id1xbet} | ${Number(j.montant||0).toLocaleString()}DJF | ${j.status}`;
        });
        await sendTelegram(token, adminId,
          `📋 <b>File MacroDroid (${docs.length} job${docs.length>1?"s":""})</b>\n\n${lignes.join("\n")}\n\n` +
          `<i>MacroDroid poll: GET /macroJob?secret=xxx</i>`);
        return;
      }

      // circuit
      if (t === "circuit" || t === "/circuit") {
        const snap = await db.collection("circuit_breakers").doc("macrodroid").get();
        if (!snap.exists) { await sendTelegram(token, adminId, "✅ Circuit breaker: <b>closed</b>"); return; }
        const cb = snap.data();
        const ouvertDepuis = cb.ouvertA ? Math.round((Date.now() - cb.ouvertA) / 60000) : null;
        await sendTelegram(token, adminId,
          `🔌 <b>Circuit breaker MacroDroid</b>\n\nÉtat: <b>${cb.etat.toUpperCase()}</b>\n` +
          `Échecs: ${cb.echecs || 0}\n` +
          (ouvertDepuis ? `Ouvert depuis: ${ouvertDepuis} min\n` : "") +
          (cb.dernierEchec ? `Dernier échec: <i>${cb.dernierEchec}</i>` : "")
        );
        if (cb.etat === "open")
          await sendTelegram(token, adminId, "Pour réinitialiser : <code>reset circuit</code>");
        return;
      }

      // reset circuit
      if (t === "reset circuit" || t === "/reset_circuit") {
        await db.collection("circuit_breakers").doc("macrodroid").set({ etat: "closed", echecs: 0, resetAt: Date.now() });
        logAudit("circuit_reset", { adminId });
        await sendTelegram(token, adminId, "✅ Circuit breaker réinitialisé — <b>CLOSED</b>");
        return;
      }

      // webhook support — configure le webhook Telegram du bot support
      if (t === "webhook support" || t === "/webhook_support") {
        const sToken = SUPPORT_BOT_TOKEN.value();
        if (!sToken) { await sendTelegram(token, adminId, "❌ Secret SUPPORT_BOT_TOKEN non configuré."); return; }
        const funcUrl = "https://europe-west1-kaffi-pay.cloudfunctions.net/supportClient";
        const r = await fetch(`https://api.telegram.org/bot${sToken}/setWebhook`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: funcUrl, allowed_updates: ["message"] }),
          signal: AbortSignal.timeout(10000),
        });
        const rj = await r.json().catch(() => ({}));
        if (rj.ok) {
          await sendTelegram(token, adminId, `✅ Webhook support bot configuré :\n<code>${funcUrl}</code>`);
        } else {
          await sendTelegram(token, adminId, `❌ Erreur webhook : ${rj.description || r.status}`);
        }
        return;
      }

      // recharge #ID — relance MacroDroid manuellement pour un ordre confirmé
      const rechargeMatch = text.match(/^recharge\s+#?(\d{5,8})\b/i);
      if (rechargeMatch) {
        const num  = rechargeMatch[1];
        const snap = await db.collection("orders").where("orderId", "==", num).limit(1).get();
        if (snap.empty) { await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`); return; }
        const oDoc  = snap.docs[0];
        const oData = oDoc.data();
        if (oData.status !== "Confirmé") {
          await sendTelegram(token, adminId, `⛔ Ordre <b>#${num}</b> n'est pas Confirmé (statut: <b>${oData.status}</b>).`); return;
        }
        const id1xbet    = oData.userId1xBet || oData.id1x || oData.idBet || "";
        const montantVal = oData.montant || oData.amount || 0;
        if (!id1xbet) { await sendTelegram(token, adminId, `⚠️ ID 1xBet manquant pour <b>#${num}</b>.`); return; }
        const wbUrl = MACRO_WEBHOOK_URL.value() || "";
        if (!wbUrl) { await sendTelegram(token, adminId, `❌ MACRODROID_WEBHOOK_URL non configuré.`); return; }
        await sendTelegram(token, adminId, `🔄 Relance MacroDroid — <b>#${num}</b> | <code>${id1xbet}</code>…`);
        try {
          await callMacrodroidLocked(wbUrl, num, montantVal, id1xbet);
          await oDoc.ref.update({ webhookStatus: "ok", webhookAt: FieldValue.serverTimestamp(), rechargeAdmin: true });
          logAudit("recharge_manuelle_ok", { num, adminId, id1xbet });
          await sendTelegram(token, adminId,
            `✅ <b>Recharge réussie !</b>\n#${num} | <code>${id1xbet}</code> | ${Number(montantVal).toLocaleString()} DJF`);
        } catch (e) {
          await sendTelegram(token, adminId, `❌ Échec : <code>${e.message}</code>`);
        }
        return;
      }

      // Requêtes générales
      const [ordersSnap, notifSnap] = await Promise.all([
        db.collection("orders").orderBy("ts", "desc").limit(20).get()
          .catch(() => db.collection("orders").limit(20).get()),
        db.collection("waafi_notifications").orderBy("createdAt", "desc").limit(10).get()
          .catch(() => db.collection("waafi_notifications").limit(10).get()),
      ]);

      const orders = ordersSnap.docs.map((d) => {
        const o = d.data();
        return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status} | N°${o.numeroPayment || "?"} | ${o.flagRaison || ""}`;
      });
      const notifs = notifSnap.docs.map((d) => {
        const n = d.data();
        return `• TID:${n.transferId || "?"} | ${n.montant || "?"}DJF | N°${n.numClient || "?"} | ${n.status}`;
      });

      await sendTelegram(token, adminId, traiterAdminBot(text, orders, notifs));

    } catch (e) { console.error("adminBot crash:", e.message, e.stack); }
  }
);
