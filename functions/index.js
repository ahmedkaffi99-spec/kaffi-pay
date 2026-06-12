/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  KAFFI PAY — CLOUD FUNCTIONS v7.0                                    ║
 * ║                                                                      ║
 * ║  FLOW DÉPÔT (automatique) :                                          ║
 * ║  1. User paie Waafi → SMS → smsWebhook → waafi_notifications         ║
 * ║  2. User soumet ordre → onNouvelOrdre → match TID 3/3 critères       ║
 * ║  3. Check ordre_traite (anti-fraude doublon) → "Paiement Reçu"       ║
 * ║  4. onOrdreUpdated → MobCash API → "Crédité avec succès"            ║
 * ║                                                                      ║
 * ║  FLOW RETRAIT (automatique) :                                         ║
 * ║  1. User soumet retrait → MobCash Payout immédiat                    ║
 * ║  2. Succès → "Paiement Reçu" + USSD admin (Telegram + Web)          ║
 * ║  3. Admin compose USSD + clique Terminer → "Crédité avec succès"    ║
 * ║                                                                      ║
 * ║  STATUTS : En attente → Paiement Reçu → Crédité avec succès         ║
 * ║                       ↘ Paiement Non Reçu (rejet / fraude)           ║
 * ║                                                                      ║
 * ║  Fonctions (7) :                                                     ║
 * ║  [Triggers]  onNouvelOrdre · onOrdreUpdated                          ║
 * ║  [Scheduled] ordresBloques                                           ║
 * ║  [HTTP]      smsWebhook · healthCheck · supportClient · adminBot     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest }                            = require("firebase-functions/v2/https");
const { onSchedule }                           = require("firebase-functions/v2/scheduler");
const { defineSecret }                         = require("firebase-functions/params");
const { initializeApp }                        = require("firebase-admin/app");
const { getFirestore, FieldValue }             = require("firebase-admin/firestore");
const crypto                                   = require("crypto");

initializeApp();
const db = getFirestore();

const REGION = "europe-west1";

const TELEGRAM_TOKEN    = defineSecret("TELEGRAM_TOKEN");
const TELEGRAM_ADMIN_ID = defineSecret("TELEGRAM_ADMIN_CHAT_ID");
const MACRO_SECRET      = defineSecret("MACRODROID_SECRET"); // smsWebhook auth only
const SUPPORT_BOT_TOKEN  = defineSecret("SUPPORT_BOT_TOKEN");
const ULTRAMSG_INSTANCE  = defineSecret("ULTRAMSG_INSTANCE_ID");
const ULTRAMSG_TOKEN     = defineSecret("ULTRAMSG_TOKEN");
const MOBCASH_HASH       = defineSecret("MOBCASH_HASH");
const MOBCASH_CASHIERPASS = defineSecret("MOBCASH_CASHIERPASS");
const MOBCASH_CASHDESKID = defineSecret("MOBCASH_CASHDESKID");
const MOBCASH_LOGIN      = defineSecret("MOBCASH_LOGIN");

// ══════════════════════════════════════════════════════════════════
// SECTION 1 — STATE MACHINE
// ══════════════════════════════════════════════════════════════════
const TRANSITIONS_VALIDES = {
  // Dépôt
  "En attente":          ["Paiement Reçu", "Paiement Non Reçu", "Annulé", "Code Validé", "Code Invalide"],
  "Paiement Reçu":       ["Crédité avec succès", "Paiement Non Reçu"],
  "Crédité avec succès": [],
  "Paiement Non Reçu":   ["En attente"],
  "Annulé":              ["En attente"],
  // Retrait
  "Code Validé":         ["Payé", "Code Invalide"],
  "Code Invalide":       ["En attente", "Code Validé"],
  "Payé":                [],
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
  const num     = (tx.numeroPayment || tx.waafiNumber || "").replace(/\s/g, "");

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
// SECTION 5b — MOBCASH API (Dépôt / Retrait 1xBet)
//
//  Login  : POST /Login/{cashdeskId}
//           sign = SHA256(login + cashdeskId + cashierpass + hash)
//  Dépôt  : POST /Deposit/{userId1xbet}/Add
//  Retrait: POST /Deposit/{userId1xbet}/Payout
//           sign = MD5(summa + cashierpass + cashdeskId)
// ══════════════════════════════════════════════════════════════════
const MOBCASH_BASE = "https://partners.servcul.com/CashdeskBotAPI";

async function callMobcash(type, userId1xbet, montant, withdrawalCode) {
  const hash        = MOBCASH_HASH.value();
  const cashierpass = MOBCASH_CASHIERPASS.value();
  const cashdeskId  = MOBCASH_CASHDESKID.value();
  if (!hash || !cashierpass || !cashdeskId)
    throw new Error("Secrets MobCash non configurés (MOBCASH_HASH / MOBCASH_CASHIERPASS / MOBCASH_CASHDESKID)");

  const userId   = String(userId1xbet);
  const lng      = "en";
  const isDepot  = type !== "Retrait";
  const endpoint = isDepot ? "Add" : "Payout";

  // Signature step 1 : SHA256(hash=H&lng=L&userid=U)
  const part1 = crypto.createHash("sha256")
    .update(`hash=${hash}&lng=${lng}&userid=${userId}`)
    .digest("hex");

  // Signature step 2 : MD5 selon type (doc API MobCash)
  // Dépôt (Reception) : MD5(summa=X&cashierpass=P&cashdeskid=C)
  // Retrait (Pay)     : MD5(code=X&cashierpass=P&cashdeskid=C)
  const part2 = isDepot
    ? crypto.createHash("md5").update(`summa=${montant}&cashierpass=${cashierpass}&cashdeskid=${cashdeskId}`).digest("hex")
    : crypto.createHash("md5").update(`code=${withdrawalCode}&cashierpass=${cashierpass}&cashdeskid=${cashdeskId}`).digest("hex");

  // Signature step 3 : SHA256(part1 + part2) → header "sign"
  const sign = crypto.createHash("sha256").update(part1 + part2).digest("hex");

  // confirm = MD5(userId:hash) → body
  const confirm = crypto.createHash("md5").update(`${userId}:${hash}`).digest("hex");

  const body = isDepot
    ? { cashdeskid: Number(cashdeskId), lng, summa: montant, confirm }
    : { cashdeskid: Number(cashdeskId), lng, code: String(withdrawalCode || ""), confirm };

  const resp = await fetch(`${MOBCASH_BASE}/Deposit/${userId}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "sign": sign },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const err = new Error(`MobCash ${endpoint} HTTP ${resp.status}: ${errText}`);
    err.rawData = { httpStatus: resp.status, body: errText };
    err.debugInfo = { url: `${MOBCASH_BASE}/Deposit/${userId}/${endpoint}`, userId, endpoint };
    throw err;
  }
  const data = await resp.json();
  const isSuccess = data.Success ?? data.success;
  const msgId     = data.MessageId ?? data.messageId;
  const msgText   = data.Message   || data.message || JSON.stringify(data);
  if (isSuccess === false || (msgId && msgId !== 0)) {
    const err = new Error(`MobCash ${endpoint}: ${msgText}`);
    err.rawData  = data;
    err.debugInfo = { url: `${MOBCASH_BASE}/Deposit/${userId}/${endpoint}`, userId, endpoint };
    throw err;
  }
  return data;
}


// ══════════════════════════════════════════════════════════════════
// SECTION 5c — SCORING CORRESPONDANCE (3 critères)
//
//  Règles :
//  3/3 → confirmer automatiquement
//  <3  → rejeter avec raison spécifique par champ
//
//  Un critère est "MISMATCH" seulement si la valeur existe dans
//  la notification ET ne correspond pas à l'ordre.
//  Valeur absente (non parsée du SMS) = neutre, ne réduit pas le score.
// ══════════════════════════════════════════════════════════════════
function scorerCorrespondance(ordreData, notifData) {
  const montantOrdre = Number(ordreData.montant || 0);
  const transferId   = (ordreData.waafitranfertID || ordreData.hash || "").trim();
  const phone        = (ordreData.numeroPayment || ordreData.waafiNumber || "").trim();

  let score = 0;
  const mismatches = [];

  // Critère 1 : Transfer ID (clé primaire — doit correspondre exactement)
  if (!notifData.transferId || transferId === notifData.transferId) {
    score++;
  } else {
    mismatches.push(
      `Transfer-ID incorrect (ordre: <code>${transferId}</code> / Waafi: <code>${notifData.transferId}</code>)`
    );
  }

  // Critère 2 : Montant exact (tolérance 1 DJF pour les arrondis flottants uniquement)
  if (!notifData.montant || Math.abs(montantOrdre - notifData.montant) <= 1) {
    score++;
  } else {
    mismatches.push(
      `Montant incorrect (ordre: <b>${montantOrdre.toLocaleString()} DJF</b> / Waafi: <b>${Number(notifData.montant).toLocaleString()} DJF</b>)`
    );
  }

  // Critère 3 : Numéro expéditeur (compare sans préfixe +253)
  const normPhone  = phone.replace(/^\+?253/, "").replace(/\D/g, "");
  const normNotif  = (notifData.numClient || "").replace(/^\+?253/, "").replace(/\D/g, "");
  if (!normNotif || normPhone === normNotif) {
    score++;
  } else {
    mismatches.push(
      `N° expéditeur différent (ordre: <code>${phone}</code> / Waafi: <code>${notifData.numClient}</code>)`
    );
  }

  const decision = score >= 3 ? "confirmer" : "rejeter";
  return { score, mismatches, decision };
}

function mismatchToRaison(mismatches) {
  for (const m of mismatches) {
    const ml = (m || "").toLowerCase();
    if (ml.includes("transfer")) return "Paiement non reçu";
    if (ml.includes("montant"))  return "Montant incorrect";
    if (ml.includes("xpéditeur") || ml.includes("n°")) return "Numéro expéditeur incorrect";
  }
  return "Informations incorrectes";
}

// ══════════════════════════════════════════════════════════════════
// SECTION 6 — CONFIRMATION DÉPÔT + WEBHOOK MacroDroid
// Appelé par onNouvelOrdre (flux principal) et smsWebhook (cas rare)
// waafiDoc = document waafi_notifications correspondant
// ordreDoc = document orders à confirmer
// ══════════════════════════════════════════════════════════════════
// ── Recherche un ordre dans les deux collections ──
async function findOrder(ordreId) {
  const [depotSnap, retraitSnap] = await Promise.all([
    db.collection("depot_orders").where("orderId", "==", ordreId).limit(1).get(),
    db.collection("retrait_orders").where("orderId", "==", ordreId).limit(1).get(),
  ]);
  if (!depotSnap.empty) return depotSnap.docs[0];
  if (!retraitSnap.empty) return retraitSnap.docs[0];
  return null;
}

async function confirmerDepot(ordreDoc, waafiDoc, token, adminId) {
  const ordre        = ordreDoc.data();
  const notif        = waafiDoc.data();
  const ordreId      = ordre.orderId || ordreDoc.id;
  const montantOrdre = Number(ordre.montant || 0);
  const montantNotif = notif.montant || montantOrdre;
  const numReel      = notif.numClient || ordre.numeroPayment || "";

  // Transaction atomique : évite les doubles confirmations
  // Crée ordre_traite (anti-doublon TID) + ordre_confirme (archive de confirmation)
  const traitRef   = db.collection("ordre_traite").doc(notif.transferId || ordreId);
  const confirmeRef = db.collection("ordre_confirme").doc(ordreId);
  const claimed = await db.runTransaction(async (tx) => {
    const [ordreSnap, traitSnap] = await Promise.all([
      tx.get(ordreDoc.ref),
      tx.get(traitRef),
    ]);
    if (!ordreSnap.exists || ordreSnap.data().status !== "En attente") return false;
    if (traitSnap.exists) return false;

    tx.update(ordreDoc.ref, {
      status: "Paiement Reçu",
      confirmedBy: "auto_match_waafi",
      montantRecu: montantNotif,
      expediteurRecu: numReel,
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
      status: "confirme",
    });
    tx.set(confirmeRef, {
      ordreId,
      type: ordre.type || "Dépôt",
      montant: montantNotif,
      montantOrdre,
      numClient: numReel,
      transferId: notif.transferId || "",
      waafiNotifId: waafiDoc.id,
      userId1xBet: ordre.userId1xBet || ordre.id1x || "",
      whatsapp: ordre.whatsapp || "",
      confirmedBy: "auto_match_waafi",
      confirmedAt: FieldValue.serverTimestamp(),
      status: "confirme",
    });
    return true;
  });

  if (!claimed) return false;

  // Marquer la notification Waafi comme "matché" → affichage correct onglet Notifications admin
  db.collection("waafi_notifications").doc(waafiDoc.id).update({
    status: "matché", ordreRef: ordreId, matchedAt: FieldValue.serverTimestamp(),
  }).catch(() => {});

  logAudit("depot_paiement_confirme", { ordreId, transferId: notif.transferId, montant: montantNotif });

  // Telegram admin — paiement confirmé, MobCash va créditer
  await sendTelegram(token, adminId,
    `💳 <b>Ordre paiement confirmé — Paiement Waafi validé</b>\n\n` +
    `Ordre: <b>#${ordreId}</b> | <b>${Number(montantNotif).toLocaleString()} DJF</b>\n` +
    `Transfer-ID: <code>${notif.transferId || "?"}</code> | N°: <code>${numReel}</code>` +
    (ordre.whatsapp ? `\nWhatsApp: <code>${ordre.whatsapp}</code>` : "") +
    `\n\n<i>⏳ MobCash va créditer le compte 1xBet...</i>`
  );

  const id1xbet = ordre.userId1xBet || ordre.id1x || "";
  if (!id1xbet) {
    await sendTelegram(token, adminId,
      `⚠️ <b>ID 1xBet manquant</b> — #${ordreId}\n${Number(montantNotif).toLocaleString()} DJF en attente de crédit.`
    );
  }

  // WhatsApp 2/3 — paiement reçu, crédit en cours
  if (ordre.whatsapp) {
    await sendWhatsApp(ordre.whatsapp,
      `💳 *Kaffi-Pay — Paiement reçu* ✅\n\n` +
      `Votre paiement *#${ordreId}* de *${Number(montantNotif).toLocaleString()} DJF* a bien été reçu.\n\n` +
      `Statut : 💳 *Paiement reçu*\n\n` +
      `⏳ Crédit de votre compte 1xBet en cours...\n` +
      `📲 kaffi-pay.com/#suivi-${ordreId}`
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
  const montant   = Number(o.montant || 0).toLocaleString();
  const type      = o.type || "Ordre";
  const isRetrait = o.type === "Retrait";

  let statut = "";
  // Retrait statuses
  if (o.status === "Payé")
    statut = "✅ <b>Payé</b> — Paiement envoyé avec succès. Veuillez vérifier votre solde Waafi. Merci de votre confiance.";
  else if (o.status === "Code Validé")
    statut = "⏳ <b>Code Validé</b> — Fonds retirés avec succès depuis 1xbet. Votre transfert Waafi arrive dans un instant.";
  else if (o.status === "Code Invalide")
    statut = `❌ <b>Code Invalide</b> — ${o.flagRaison || "Code invalide. Contactez le support."}`;
  // Dépôt statuses
  else if (o.status === "Crédité avec succès")
    statut = "✅ <b>Crédité avec succès</b> — votre compte 1xBet a été rechargé.";
  else if (o.status === "En attente")
    statut = isRetrait
      ? "⏳ <b>En attente</b> — traitement en cours. Ne pas annuler le code sur votre application 1xBet."
      : "⏳ <b>En attente</b> — traitement en cours.";
  else if (o.status === "Paiement Reçu")
    statut = "💳 <b>Paiement reçu</b> — crédit 1xBet en cours...";
  else if (o.status === "Paiement Non Reçu")
    statut = `❌ <b>Paiement non reçu</b> — ${o.flagRaison || "Paiement non reçu."}`;
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
    const confirmes = orders.filter((o) => o.includes("| Crédité avec succès"));
    const attente   = orders.filter((o) => o.includes("| En attente"));
    const argRecu   = orders.filter((o) => o.includes("| Paiement Reçu"));
    const rejetes   = orders.filter((o) => o.includes("| Paiement Non Reçu"));
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
    const aTraiter = orders.filter((o) => o.includes("| En attente") || o.includes("| Paiement Reçu"));
    if (!aTraiter.length) return "✅ Aucun ordre en attente.";
    return `⏳ <b>En attente (${aTraiter.length})</b>\n\n${aTraiter.join("\n")}\n\n<i>Traitement automatique en cours — toutes les 5 min.</i>`;
  }

  if (/^\/fraudes?$/.test(t) || t === "fraudes") {
    const fraudes = orders.filter((o) => o.toLowerCase().includes("fraude"));
    return fraudes.length ? `🚨 <b>Fraudes (${fraudes.length})</b>\n\n${fraudes.join("\n")}` : "✅ Aucune fraude récente.";
  }

  if (/^\/rejet/.test(t) || t === "rejetés") {
    const rejetes = orders.filter((o) => o.includes("| Paiement Non Reçu"));
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
    "🤖 <code>statut support</code> — statut webhook bot client\n" +
    "🔄 <code>test mobcash</code> — tester MobCash\n" +
    "📱 <code>test whatsapp +25377XXXXXX</code> — tester l'envoi WhatsApp\n\n" +
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

// Envoie un message Telegram avec boutons inline (keyboard = [[{text, callback_data|url}]])
async function sendTelegramKeyboard(token, chatId, text, keyboard) {
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { console.warn("Telegram keyboard failed:", e.message); }
}

// Répond à un callback_query Telegram (supprime le spinner sur le bouton)
async function answerCallback(token, callbackId, text) {
  if (!token || !callbackId) return;
  fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text: text || "" }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
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

async function sendWhatsApp(phone, message) {
  const instanceId = ULTRAMSG_INSTANCE.value();
  const token      = ULTRAMSG_TOKEN.value();
  if (!instanceId || !token || !phone) {
    console.warn("WhatsApp skipped: missing instanceId, token, or phone", { instanceId: !!instanceId, token: !!token, phone: !!phone });
    return { ok: false, reason: "missing_config" };
  }
  // Normalise l'instance ID : "#179983" ou "179983" → "instance179983"
  let iid = instanceId.replace(/^#/, "").trim();
  if (/^\d+$/.test(iid)) iid = "instance" + iid;
  const to = phone.startsWith("+") ? phone : "+" + phone;
  try {
    const resp = await fetch(`https://api.ultramsg.com/${iid}/messages/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, to, body: message }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const body = await resp.text();
    if (!resp.ok) {
      console.warn("UltraMsg error:", resp.status, body);
      return { ok: false, status: resp.status, body };
    }
    return { ok: true, body };
  } catch (e) {
    console.warn("WhatsApp send failed:", e.message);
    return { ok: false, reason: e.message };
  }
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
// TRIGGER 1a — NOUVEL ORDRE DÉPÔT
//
//  FLOW :
//  1. waafi_notifications arrive en premier (user a payé)
//  2. User soumet l'ordre avec le Transfer ID
//  3. Ce trigger cherche la notif Waafi correspondante
//  4. Si trouvée → confirme + webhook MacroDroid
//
//  ANTI-FRAUDE : si Transfer ID introuvable dans waafi_notifications
//  → le paiement n'existe pas → rejet immédiat
// ══════════════════════════════════════════════════════════════════
exports.onNouvelDepot = onDocumentCreated(
  {
    document: "depot_orders/{docId}", region: REGION,
    secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ULTRAMSG_INSTANCE, ULTRAMSG_TOKEN,
              MOBCASH_HASH, MOBCASH_CASHIERPASS, MOBCASH_CASHDESKID, MOBCASH_LOGIN],
    timeoutSeconds: 60,
  },
  async (event) => {
    const tx      = event.data.data();
    if (tx.type !== "Dépôt") return;

    const docId      = event.params.docId;
    const ordreId    = tx.orderId || docId;
    const transferId = (tx.waafitranfertID || tx.hash || "").trim();
    const phone      = (tx.numeroPayment || tx.waafiNumber || "").trim();
    const token      = TELEGRAM_TOKEN.value();
    const adminId    = TELEGRAM_ADMIN_ID.value();

    logAudit("nouvel_depot", { ordreId, montant: tx.montant, phone });

    // ── Telegram admin — nouvel ordre reçu ──
    await sendTelegram(token, adminId,
      `📥 <b>Nouvel ordre Dépôt</b> — <code>#${ordreId}</code>\n\n` +
      `Montant : <b>${Number(tx.montant || 0).toLocaleString()} DJF</b>\n` +
      `ID 1xBet : <code>${tx.userId1xBet || tx.id1x || "—"}</code>\n` +
      `Transfer-ID : <code>${transferId || "—"}</code>\n` +
      `N° Waafi : <code>${phone || "—"}</code>\n\n` +
      `<i>⏳ Vérification en cours...</i>`
    );

    // ── WhatsApp — accusé de réception immédiat ──
    if (tx.whatsapp) {
      const montantStr = Number(tx.montant || 0).toLocaleString();
      await sendWhatsApp(tx.whatsapp,
        `🧾 *Kaffi-Pay — Ordre reçu* ✅\n\n` +
        `Votre ordre *#${ordreId}* a bien été soumis.\n\n` +
        `📥 *Dépôt 1xBet*\n` +
        `Montant : *${montantStr} DJF*\n` +
        `ID 1xBet : ${tx.userId1xBet || tx.id1x || "—"}\n` +
        `Waafi Transfer ID : ${tx.waafitranfertID || tx.hash || "—"}\n` +
        `N° expéditeur : ${tx.numeroPayment || "—"}\n\n` +
        `Statut : ⏳ *En attente*\n\n` +
        `Vous recevrez une notification dès que votre paiement sera validé.\n` +
        `📲 Suivi : kaffi-pay.com/#suivi-${ordreId}`
      );
    }

    if (!transferId) {
      await db.collection("depot_orders").doc(docId).update({
        status: "Paiement Non Reçu",
        flagRaison: "Transfer ID manquant",
        flaggedAt: FieldValue.serverTimestamp(),
      });
      await sendTelegram(token, adminId,
        `❌ <b>Dépôt rejeté — Transfer ID manquant</b>\nOrdre: <code>#${ordreId}</code>`
      );
      return;
    }

    // Recherche 1 : par Transfer ID exact (champ parsé)
    let waafiDoc = null;
    const byTID = await db.collection("waafi_notifications")
      .where("transferId", "==", transferId).limit(1).get();
    if (!byTID.empty) waafiDoc = byTID.docs[0];

    // Recherche 2 (fallback) : par numéro + montant ±5%
    if (!waafiDoc && phone) {
      const montantOrdre = Number(tx.montant || 0);
      const tolerance    = Math.max(5, montantOrdre * 0.05);
      const byPhone = await db.collection("waafi_notifications")
        .where("numClient", "==", phone).limit(10).get();
      for (const d of byPhone.docs) {
        const n = d.data();
        if (n.montant && Math.abs(montantOrdre - n.montant) > tolerance) continue;
        const dejaTID = n.transferId
          ? (await db.collection("ordre_traite").where("transferId", "==", n.transferId).limit(1).get()).empty
          : true;
        if (dejaTID) { waafiDoc = d; break; }
      }
    }

    // Recherche 3 (fallback brut) : docs MacroDroid non encore parsés (contiennent le TID dans le texte)
    // Utile si onNouvelleNotifWaafi n'a pas encore tourné (race condition quelques ms)
    if (!waafiDoc) {
      const rawSnap = await db.collection("waafi_notifications")
        .where("status", "in", ["nouveau", "new", "pending", "reçu"])
        .limit(30).get();
      for (const d of rawSnap.docs) {
        const n = d.data();
        if (n.transferId !== undefined) continue; // Déjà parsé, skip
        const texte = n.texte || n.sms || n.message || n.notification || n.content
                   || (n.not_title ? (n.not_title + " " + (n.notification || "")) : "");
        if (!texte.includes(transferId)) continue;
        // Enrichir le doc avec les champs parsés pour les prochaines recherches
        const tid2 = extractTransferId(texte);
        const mt2  = extractMontant(texte);
        const nc2  = extractNumClient(texte);
        d.ref.update({ transferId: tid2 || null, montant: mt2 || null, numClient: nc2 || null,
                       parsedAt: FieldValue.serverTimestamp(), source: n.source || "macrodroid_direct" }).catch(() => {});
        waafiDoc = d;
        break;
      }
    }

    if (waafiDoc) {
      const ordreSnap = await db.collection("depot_orders").doc(docId).get();
      const { score, mismatches, decision } = scorerCorrespondance(tx, waafiDoc.data());

      if (decision === "confirmer") {
        const confirmed = await confirmerDepot(ordreSnap, waafiDoc, token, adminId);
        if (!confirmed) {
          // Re-lire le statut actuel : une autre fonction (onNouvelleNotifWaafi, scheduler)
          // a peut-être déjà confirmé cet ordre entre-temps (race condition normale).
          const freshSnap = await db.collection("depot_orders").doc(docId).get();
          if (!freshSnap.exists || freshSnap.data().status !== "En attente") return;

          // Vrai doublon TID : le TID appartient à un autre ordre
          const autreOrdre = await db.collection("ordre_traite")
            .where("transferId", "==", waafiDoc.data().transferId || "").limit(1).get();
          const autreId = autreOrdre.empty ? "?" : (autreOrdre.docs[0].data().ordreId || "?");
          if (autreId === ordreId) return; // Même ordre — déjà confirmé, on ne touche pas
          await db.collection("depot_orders").doc(docId).update({
            status: "Paiement Non Reçu",
            flagRaison: `Transfer-ID déjà utilisé par l'ordre #${autreId}`,
            flaggedAt: FieldValue.serverTimestamp(),
          });
          await sendTelegram(token, adminId,
            `⚠️ <b>Doublon TID détecté — #${ordreId}</b>\n\n` +
            `Transfer-ID <code>${transferId}</code> déjà utilisé par l'ordre <code>#${autreId}</code>.\n` +
            `Montant: ${Number(tx.montant||0).toLocaleString()} DJF | ID 1xBet: <code>${tx.userId1xBet||"?"}</code>\n\n` +
            `<i>Si c'est un re-soumission du même client, relancez <code>#${autreId}</code> avec le bon ID 1xBet.</i>`
          );
        }
        return;
      }

      const raison = mismatchToRaison(mismatches);
      await db.collection("depot_orders").doc(docId).update({
        status: "Paiement Non Reçu",
        flagRaison: raison,
        flaggedAt: FieldValue.serverTimestamp(),
      });
      await sendTelegram(token, adminId,
        `❌ <b>Dépôt rejeté (${score}/3) — ${raison}</b>\n\n` +
        `Ordre <code>#${ordreId}</code>\n${mismatches.map((m) => `• ${m}`).join("\n")}`
      );
      logAudit("depot_rejete_mauvaise_correspondance", { ordreId, score, mismatches, raison });
      return;
    }

    // Aucune notification trouvée → ordre reste "En attente" (SMS peut arriver dans les prochaines minutes)
    // Le scheduler ordresBloques (toutes les 5 min) et smsWebhook (reverse match) prendront le relais.
    // Alerte admin uniquement si ordre > 10 min sans SMS.
    const ageMin = tx.ts ? Math.round((Date.now() - tx.ts) / 60000) : 0;
    if (ageMin >= 10) {
      await sendTelegram(token, adminId,
        `⏳ <b>Dépôt en attente — SMS introuvable</b>\n\n` +
        `Ordre: <code>#${ordreId}</code>\n` +
        `Transfer-ID: <code>${transferId}</code>\n` +
        `Montant: ${Number(tx.montant || 0).toLocaleString()} DJF\n` +
        `Âge: ${ageMin} min\n\n` +
        `<i>Notification Waafi non encore reçue. Le scheduler relancera automatiquement.</i>`
      );
    }
    logAudit("depot_sms_introuvable_attente", { ordreId, transferId, ageMin });
  }
);

// ══════════════════════════════════════════════════════════════════
// TRIGGER 1b — NOUVEL ORDRE RETRAIT
//
//  FLOW :
//  1. Client soumet demande de retrait (code + numéro Waafi)
//  2. MobCash Payout retire le montant du compte 1xBet
//  3. Vérification montant MobCash = montant soumis
//  4. Admin reçoit USSD Waafi + bouton Terminer
//  5. Admin paie Waafi et clique Terminer → "Crédité avec succès"
// ══════════════════════════════════════════════════════════════════
exports.onNouvelRetrait = onDocumentCreated(
  {
    document: "retrait_orders/{docId}", region: REGION,
    secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ULTRAMSG_INSTANCE, ULTRAMSG_TOKEN,
              MOBCASH_HASH, MOBCASH_CASHIERPASS, MOBCASH_CASHDESKID, MOBCASH_LOGIN],
    timeoutSeconds: 60,
  },
  async (event) => {
    const tx = event.data.data();
    if (tx.type !== "Retrait") return;

    const docId      = event.params.docId;
    const ordreId    = tx.orderId || docId;
    const tidRetrait = (tx.withdrawalCode || "").trim();
    const montantVal = Number(tx.montant || 0);
    const waafiNum   = (tx.numeroWaafi || tx.waafiNumber || tx.tel || tx.whatsapp || "").replace(/\s/g, "").replace(/^\+?253/, "");
    const token      = TELEGRAM_TOKEN.value();
    const adminId    = TELEGRAM_ADMIN_ID.value();

    logAudit("nouvel_retrait", { ordreId, montant: montantVal, waafiNum });

    // ── WhatsApp — accusé de réception "En attente" ──
    if (tx.whatsapp) {
      await sendWhatsApp(tx.whatsapp,
        `🧾 *Kaffi-Pay — Retrait reçu*\n\n` +
        `Ordre *#${ordreId}* — *${montantVal.toLocaleString()} DJF*\n\n` +
        `📝 *Statut : En attente*\n` +
        `Note : Traitement en cours. Veuillez ne pas annuler le code sur votre application 1xbet.\n\n` +
        `📲 kaffi-pay.com/#suivi-${ordreId}`
      );
    }

    if (!tidRetrait) {
      await sendTelegram(token, adminId,
        `⚠️ <b>Retrait sans code</b> — #${ordreId}\nCode retrait manquant, intervention manuelle requise.`);
      return;
    }

    const userId1xBetVal = (tx.userId1xBet || tx.id1x || "").trim();
    if (!userId1xBetVal) {
      await sendTelegram(token, adminId,
        `⚠️ <b>Retrait sans ID 1xBet</b> — #${ordreId}\nID compte 1xBet manquant, intervention manuelle requise.`);
      return;
    }

    try {
      const mobcashData    = await callMobcash("Retrait", userId1xBetVal, montantVal, tidRetrait);
      // MobCash Payout returns Summa as a negative value (e.g. -250), use Math.abs()
      const montantMobcash = Math.abs(Number(
        mobcashData.Summa ?? mobcashData.summa ?? mobcashData.amount ?? mobcashData.sum ?? montantVal
      ));

      // Montant MobCash ≠ montant soumis → Code Invalide
      if (montantMobcash !== montantVal) {
        const note = "Montant incorrect. Le montant saisi ne correspond pas à la valeur du code sur 1xbet.";
        await db.collection("retrait_orders").doc(docId).update({
          status: "Code Invalide", flagRaison: note,
          montantMobcash, flaggedAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(token, adminId,
          `❌ <b>Retrait — Code Invalide</b>\nOrdre : <code>#${ordreId}</code>\n${note}\n` +
          `Soumis : ${montantVal.toLocaleString()} DJF | MobCash : ${montantMobcash.toLocaleString()} DJF`
        );
        if (tx.whatsapp) {
          await sendWhatsApp(tx.whatsapp,
            `❌ *Kaffi-Pay — Code Invalide*\n\nOrdre *#${ordreId}* :\n\n📝 ${note}\n\n📲 kaffi-pay.com/#suivi-${ordreId}`);
        }
        logAudit("retrait_montant_incorrect", { ordreId, montantVal, montantMobcash });
        return;
      }

      // Succès MobCash → Code Validé
      await db.collection("retrait_orders").doc(docId).update({
        status: "Code Validé",
        mobcashAt: FieldValue.serverTimestamp(),
        montantMobcash,
      });

      if (tx.whatsapp) {
        await sendWhatsApp(tx.whatsapp,
          `✅ *Kaffi-Pay — Code Validé*\n\nOrdre *#${ordreId}* — *${montantMobcash.toLocaleString()} DJF*\n\n` +
          `📝 *Statut : Code Validé*\n` +
          `Note : Fonds retirés avec succès depuis 1xbet. Votre transfert Waafi arrive dans un instant.\n\n` +
          `📲 kaffi-pay.com/#suivi-${ordreId}`
        );
      }

      const ussd = `*200*${waafiNum}*${montantMobcash}#`;
      // tel: URLs are rejected by Telegram Bot API — use only the callback button
      await sendTelegramKeyboard(token, adminId,
        `📤 <b>Retrait à payer — #${ordreId}</b>\n\n` +
        `Montant : <b>${montantMobcash.toLocaleString()} DJF</b>\n` +
        `N° Waafi : <code>${waafiNum}</code>\n` +
        `Code retrait : <code>${tidRetrait}</code>\n\n` +
        `📱 USSD : <code>${ussd}</code>\n\n` +
        `<i>1. Copiez le USSD ci-dessus → 2. Composez → 3. Confirmez → 4. Cliquez Terminer.</i>`,
        [
          [{ text: "✅ Paiement Waafi effectué — Terminer", callback_data: `terminer_${ordreId}` }],
        ]
      );
      logAudit("retrait_code_valide", { ordreId, waafiNum, montantMobcash });

    } catch (e) {
      // Détection type d'erreur MobCash → note spécifique
      const msg = (e.message || "").toLowerCase();
      let note;
      if (/expir|expired/.test(msg))
        note = "Code expiré. Les codes de retrait 1xbet ont une durée de validité limitée.";
      else if (/already|used|cancelled|annul|duplicate/.test(msg))
        note = "Code déjà utilisé ou annulé sur 1xbet.";
      else if (/amount|montant|sum|incorrect/.test(msg))
        note = "Montant incorrect. Le montant saisi ne correspond pas à la valeur du code sur 1xbet.";
      else
        note = "Code inexistant. Veuillez vérifier les caractères et réessayer.";

      await db.collection("retrait_orders").doc(docId).update({
        status: "Code Invalide", flagRaison: note, flaggedAt: FieldValue.serverTimestamp(),
      });
      await sendTelegram(token, adminId,
        `❌ <b>Retrait — Code Invalide</b> — #${ordreId}\n${note}\n<code>${e.message}</code>`);
      if (tx.whatsapp) {
        await sendWhatsApp(tx.whatsapp,
          `❌ *Kaffi-Pay — Code Invalide*\n\nOrdre *#${ordreId}* :\n\n📝 ${note}\n\n📲 kaffi-pay.com/#suivi-${ordreId}`);
      }
      logAudit("retrait_code_invalide", { ordreId, note, err: e.message });
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// TRIGGER 2a — DÉPÔT MIS À JOUR
//
//  "Paiement Reçu"       → MobCash Deposit → crédite 1xBet
//  "Crédité avec succès" → WhatsApp + Telegram (succès dépôt)
//  "Paiement Non Reçu"   → WhatsApp + Telegram (rejet dépôt)
// ══════════════════════════════════════════════════════════════════
exports.onDepotUpdated = onDocumentUpdated(
  {
    document: "depot_orders/{docId}", region: REGION,
    secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ULTRAMSG_INSTANCE, ULTRAMSG_TOKEN,
              MOBCASH_HASH, MOBCASH_CASHIERPASS, MOBCASH_CASHDESKID, MOBCASH_LOGIN],
    timeoutSeconds: 60,
  },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (after.type !== "Dépôt") return;
    if (before.status === after.status) return;

    if (!transitionValide(before.status, after.status)) {
      console.warn(`[Dépôt] Transition invalide ignorée: ${before.status} → ${after.status}`);
      return;
    }

    const ordreId = after.orderId || event.params.docId;
    const montant = Number(after.montant || 0).toLocaleString();
    const token   = TELEGRAM_TOKEN.value();
    const adminId = TELEGRAM_ADMIN_ID.value();

    logAudit("depot_transition", { ordreId, de: before.status, vers: after.status, par: after.confirmedBy || "?" });

    if (after.status === "Crédité avec succès") {
      await sendTelegram(token, adminId,
        `✅ <b>Dépôt — Crédité avec succès</b>\n#${ordreId} — ${montant} DJF`);
      if (after.whatsapp) {
        await sendWhatsApp(after.whatsapp,
          `🎉 *Kaffi-Pay — Compte 1xBet crédité !*\n\n` +
          `Votre dépôt *#${ordreId}* de *${montant} DJF* a été traité avec succès.\n\n` +
          `✅ *Crédité avec succès*\n\n` +
          `Votre compte 1xBet est rechargé. Vous pouvez maintenant jouer ! 🎮`
        );
      }
      return;
    }

    if (after.status === "Paiement Non Reçu") {
      await sendTelegram(token, adminId,
        `❌ <b>Dépôt — Paiement non reçu</b>\n#${ordreId}\n${after.flagRaison || "Raison inconnue"}`);
      if (after.whatsapp) {
        await sendWhatsApp(after.whatsapp,
          `❌ *Kaffi-Pay — Paiement non reçu*\n\n` +
          `Votre ordre *#${ordreId}* n'a pas pu être traité.\n` +
          `Raison : ${after.flagRaison || "Paiement non reçu"}\n\n` +
          `Soumettez un nouvel ordre sur kaffi-pay.com`
        );
      }
      return;
    }

    // ── "Paiement Reçu" → MobCash Deposit → crédite le compte 1xBet ──
    if (after.status !== "Paiement Reçu") return;
    if (after.webhookStatus === "ok") return;

    const montantVal  = Number(after.montant || 0);
    const userId1xBet = after.userId1xBet || after.id1x || "";

    if (!userId1xBet) {
      await sendTelegram(token, adminId,
        `⚠️ <b>ID 1xBet manquant</b> — #${ordreId}\nCrédit impossible, vérifiez l'ordre.`);
      return;
    }

    const ERREURS_PERMANENTES_DEPOT = [
      "currency does not match",
      "account currency",
      "user not found",
      "invalid user",
      "account not found",
    ];

    try {
      await callMobcash("Dépôt", userId1xBet, montantVal, "");
      const tid = after.waafitranfertID || after.hash || "";
      if (tid) {
        db.collection("ordre_traite").doc(tid).update({
          status: "credite", creditedAt: FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
      await event.data.after.ref.update({
        status: "Crédité avec succès",
        webhookStatus: "ok",
        webhookAt: FieldValue.serverTimestamp(),
      });
      logAudit("depot_mobcash_ok", { ordreId, userId1xBet });
    } catch (e) {
      const errMsg = e.message || "";
      const estPermanente = ERREURS_PERMANENTES_DEPOT.some((s) => errMsg.toLowerCase().includes(s));
      await event.data.after.ref.update({
        webhookStatus: estPermanente ? "echec_permanent" : "echec",
        webhookErr: errMsg,
      });
      if (estPermanente) {
        await sendTelegram(token, adminId,
          `🚨 <b>Erreur permanente MobCash — #${ordreId}</b>\n` +
          `ID 1xBet: <code>${userId1xBet}</code>\n` +
          `<code>${errMsg}</code>\n\n` +
          `<b>Cause probable :</b> compte 1xBet en devise étrangère (USD/EUR).\n` +
          `<b>Action requise :</b> demander l'ID DJF au client ou créditer manuellement.`
        );
      } else {
        await sendTelegram(token, adminId,
          `⚠️ <b>MobCash Dépôt échoué</b> — #${ordreId}\n<code>${errMsg}</code>\n` +
          `<i>Le scheduler relancera dans 5 min (max 3 tentatives).</i>`);
      }
      logAudit("depot_mobcash_echec", { ordreId, err: errMsg, permanent: estPermanente });
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// TRIGGER 2b — RETRAIT MIS À JOUR
//
//  "Payé"          → WhatsApp + Telegram (paiement envoyé)
//  "Code Invalide" → WhatsApp note spécifique + Telegram
// ══════════════════════════════════════════════════════════════════
exports.onRetraitUpdated = onDocumentUpdated(
  {
    document: "retrait_orders/{docId}", region: REGION,
    secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ULTRAMSG_INSTANCE, ULTRAMSG_TOKEN],
    timeoutSeconds: 30,
  },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (after.type !== "Retrait") return;
    if (before.status === after.status) return;

    const ordreId = after.orderId || event.params.docId;
    const montant = Number(after.montant || 0).toLocaleString();
    const token   = TELEGRAM_TOKEN.value();
    const adminId = TELEGRAM_ADMIN_ID.value();

    logAudit("retrait_transition", { ordreId, de: before.status, vers: after.status });

    if (after.status === "Payé") {
      await sendTelegram(token, adminId,
        `✅ <b>Retrait — Payé</b>\n#${ordreId} — ${montant} DJF`);
      if (after.whatsapp) {
        await sendWhatsApp(after.whatsapp,
          `✅ *Kaffi-Pay — Retrait Payé*\n\nOrdre *#${ordreId}* — *${montant} DJF*\n\n` +
          `📝 *Statut : Payé*\n` +
          `Note : Paiement envoyé avec succès. Veuillez vérifier votre solde Waafi. Merci de votre confiance.\n\n` +
          `📲 kaffi-pay.com/#suivi-${ordreId}`
        );
      }
      return;
    }

    if (after.status === "Code Invalide") {
      await sendTelegram(token, adminId,
        `❌ <b>Retrait — Code Invalide</b>\n#${ordreId}\n${after.flagRaison || "Code invalide"}`);
      if (after.whatsapp) {
        await sendWhatsApp(after.whatsapp,
          `❌ *Kaffi-Pay — Code Invalide*\n\nOrdre *#${ordreId}* :\n\n` +
          `📝 ${after.flagRaison || "Code invalide. Contactez le support."}\n\n` +
          `📲 kaffi-pay.com/#suivi-${ordreId}`
        );
      }
      return;
    }
  }
);


// ══════════════════════════════════════════════════════════════════
// SCHEDULED — AUTO-TRAITEMENT (toutes les 5 min)
//
//  1. Ordres "En attente" → cherche SMS correspondant → auto-confirme
//  2. Alerte si ordres > 60 min sans SMS trouvé
// ══════════════════════════════════════════════════════════════════
exports.ordresBloques = onSchedule(
  { schedule: "every 5 minutes", region: REGION, timeoutSeconds: 120,
    secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ULTRAMSG_INSTANCE, ULTRAMSG_TOKEN,
              MOBCASH_HASH, MOBCASH_CASHIERPASS, MOBCASH_CASHDESKID, MOBCASH_LOGIN] },
  async () => {
    const token   = TELEGRAM_TOKEN.value();
    const adminId = TELEGRAM_ADMIN_ID.value();

    // ── PARTIE 1 : Ordres En attente → tenter auto-confirmation ────
    const snapAttente = await db.collection("depot_orders")
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
      const { score, mismatches, decision } = scorerCorrespondance(ordre, waafiDoc.data());

      if (decision === "confirmer") {
        const ok = await confirmerDepot(ordreDoc, waafiDoc, token, adminId);
        if (ok) autoConfirmes++;
      } else {
        const raison = mismatchToRaison(mismatches);
        await ordreDoc.ref.update({
          status: "Paiement Non Reçu",
          flagRaison: raison,
          flaggedAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(token, adminId,
          `❌ <b>Dépôt rejeté (${score}/3) — ${raison}</b>\nOrdre <code>#${ordre.orderId || ordreDoc.id}</code>\n` +
          mismatches.map((m) => `• ${m}`).join("\n")
        );
      }
    }

    // ── PARTIE 2 : Alerte ordres > 60 min sans SMS trouvé ─────────
    const cutoff60 = new Date(Date.now() - 60 * 60 * 1000);
    const alertRef  = db.collection("alertes_etat").doc("ordres_bloques");
    const alertSnap = await alertRef.get();
    const dernierAlerte = alertSnap.exists
      ? (alertSnap.data().ts?.toDate?.() || new Date(0))
      : new Date(0);
    const alertThrottle = Date.now() - dernierAlerte.getTime() < 60 * 60 * 1000;

    if (!alertThrottle) {
      const reSnapAttente = await db.collection("depot_orders")
        .where("status", "==", "En attente").get().catch(() => ({ docs: [] }));

      const vieux = reSnapAttente.docs.filter((d) => {
        const ts = d.data().ts;
        return ts && new Date(ts) < cutoff60;
      });

      if (vieux.length) {
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
    }

    // ── PARTIE 3a : Recovery Dépôt — "Paiement Reçu" + webhookStatus != ok ──
    // MobCash Deposit n'a pas crédité 1xBet. Re-tente max 3 fois.
    const snapDepotRecu = await db.collection("depot_orders")
      .where("status", "==", "Paiement Reçu")
      .get().catch(() => ({ docs: [] }));

    const ERREURS_PERMANENTES = [
      "currency does not match",
      "account currency",
      "user not found",
      "invalid user",
      "account not found",
    ];

    for (const ordreDoc of snapDepotRecu.docs) {
      const o         = ordreDoc.data();
      const ordreId   = o.orderId || ordreDoc.id;
      const id1xbet   = o.userId1xBet || o.id1x || "";
      const wbOk      = o.webhookStatus === "ok" || o.webhookStatus === "ok_recovery";

      if (wbOk) continue;
      // Erreur permanente déjà détectée → skip sans réessayer
      if (o.webhookStatus === "echec_permanent") continue;
      if (!id1xbet) continue;

      // Max 3 tentatives de recovery
      const retryCount = Number(o.webhookRetryCount || 0);
      if (retryCount >= 3) {
        // Alerte unique à la 3ème tentative (webhookStatus passe à echec_max)
        if (o.webhookStatus !== "echec_max") {
          await ordreDoc.ref.update({ webhookStatus: "echec_max" });
          await sendTelegram(token, adminId,
            `🚨 <b>Recovery abandonné — 3 échecs</b>\n` +
            `Ordre <code>#${ordreId}</code> | ID 1xBet: <code>${id1xbet}</code>\n` +
            `${Number(o.montant||0).toLocaleString()} DJF\n` +
            `Dernière erreur: <code>${o.webhookErr || "?"}</code>\n\n` +
            `<i>⚠️ Intervention manuelle requise.</i>`
          );
        }
        continue;
      }

      const tid         = o.waafitranfertID || o.hash || "";
      const dejaCredite = tid
        ? await db.collection("ordre_traite")
            .where("transferId", "==", tid).where("status", "==", "credite").limit(1).get()
        : { empty: true };

      if (!dejaCredite.empty) {
        await ordreDoc.ref.update({ status: "Crédité avec succès", webhookStatus: "ok_recovery" });
        continue;
      }

      try {
        await callMobcash("Dépôt", id1xbet, Number(o.montant || 0), "");
        if (tid) {
          db.collection("ordre_traite").doc(tid).update({
            status: "credite", creditedAt: FieldValue.serverTimestamp(),
          }).catch(() => {});
        }
        await ordreDoc.ref.update({
          status: "Crédité avec succès",
          webhookStatus: "ok",
          webhookAt: FieldValue.serverTimestamp(),
          recoveryBy: "scheduler",
        });
        await sendTelegram(token, adminId,
          `🔄 <b>Recovery Dépôt</b> — #<code>${ordreId}</code> crédité\n` +
          `ID 1xBet: <code>${id1xbet}</code> | ${Number(o.montant||0).toLocaleString()} DJF`
        );
        logAudit("depot_recovery_scheduler", { ordreId, id1xbet });
      } catch (err) {
        const errMsg = err.message || "";
        const estPermanente = ERREURS_PERMANENTES.some((e) => errMsg.toLowerCase().includes(e));

        if (estPermanente) {
          await ordreDoc.ref.update({
            webhookStatus: "echec_permanent",
            webhookErr: errMsg,
            webhookRetryCount: retryCount + 1,
          });
          await sendTelegram(token, adminId,
            `🚨 <b>Erreur permanente MobCash — #${ordreId}</b>\n` +
            `ID 1xBet: <code>${id1xbet}</code>\n` +
            `<code>${errMsg}</code>\n\n` +
            `<b>Cause probable :</b> compte 1xBet en devise étrangère (USD/EUR).\n` +
            `<b>Action requise :</b> demander au client son ID de compte DJF ou créditer manuellement.`
          );
        } else {
          await ordreDoc.ref.update({
            webhookStatus: "echec",
            webhookErr: errMsg,
            webhookRetryCount: retryCount + 1,
          });
          await sendTelegram(token, adminId,
            `⚠️ <b>Recovery Dépôt échoué (${retryCount + 1}/3)</b> — #${ordreId}\n<code>${errMsg}</code>`
          );
        }
      }
    }

  }
);


// ══════════════════════════════════════════════════════════════════
// HTTP — WEBHOOK MACRODROID (réception SMS Waafi)
// ══════════════════════════════════════════════════════════════════
// TRIGGER WAAFI NOTIF — Parse les docs bruts écrits par MacroDroid
// directement dans Firestore (not_title + notification fields).
// Complète les champs transferId/montant/numClient puis fait le
// reverse-match avec les ordres "En attente".
// ══════════════════════════════════════════════════════════════════
exports.onNouvelleNotifWaafi = onDocumentCreated(
  { document: "waafi_notifications/{docId}", region: REGION,
    secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID] },
  async (event) => {
    const data  = event.data.data();

    // Skip docs déjà parsés par smsWebhook (source = "macrodroid" + champ transferId présent)
    if (data.source === "macrodroid" && data.transferId !== undefined) return;
    // Skip docs déjà traités
    if (data.status && !["nouveau", "new", "pending"].includes(data.status)) return;

    // Construire le texte brut depuis tous les champs possibles de MacroDroid
    let texte = data.texte || data.sms || data.message || data.body
             || data.text  || data.notification || data.content || "";
    if (!texte && data.not_title && data.notification)
      texte = data.not_title + " " + data.notification;
    if (!texte && data.not_title && data.not_message)
      texte = data.not_title + " " + data.not_message;

    // Filtrer : doit ressembler à un SMS Waafi
    const isWaafi = texte.includes("Transfer") || texte.includes("DJF")
                 || texte.includes("Waafi")     || texte.includes("transferred")
                 || texte.includes("received")  || texte.includes("Evc-Plus");
    if (!isWaafi) return;

    // Parser les champs structurés
    const transferId = extractTransferId(texte);
    const montant    = extractMontant(texte);
    const numClient  = extractNumClient(texte);

    // Enrichir le document (utile pour les recherches dans onNouvelDepot)
    await event.data.ref.update({
      transferId: transferId || null,
      montant:    montant    || null,
      numClient:  numClient  || null,
      rawText:    texte,
      parsedAt:   FieldValue.serverTimestamp(),
      source:     data.source || "macrodroid_direct",
      status:     "reçu",
    }).catch(() => {});

    const token   = TELEGRAM_TOKEN.value();
    const adminId = TELEGRAM_ADMIN_ID.value();

    if (!transferId && !montant) {
      await sendTelegram(token, adminId,
        `⚠️ <b>SMS Waafi non parsable</b>\n<code>${texte.substring(0, 200)}</code>`
      ).catch(() => {});
      return;
    }

    // Alerte admin — SMS reçu et parsé
    await sendTelegram(token, adminId,
      `📩 <b>SMS Waafi reçu (MacroDroid direct)</b>\n\n` +
      `Transfer-ID: <code>${transferId || "?"}</code>\n` +
      `Montant: <b>${montant ? Number(montant).toLocaleString() : "?"} DJF</b>\n` +
      `Expéditeur: <code>${numClient || "?"}</code>\n\n` +
      `<i>✅ En attente de l'ordre client...</i>`
    ).catch(() => {});

    if (!transferId) return; // Pas de TID → pas de reverse-match possible

    // Reverse-match : ordre déjà soumis avec ce TID ?
    const ordreSnap = await db.collection("depot_orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();
    if (ordreSnap.empty) return;

    const dejaTraite = await db.collection("ordre_traite")
      .where("transferId", "==", transferId).limit(1).get();
    if (!dejaTraite.empty) return;

    const ordreDoc  = ordreSnap.docs[0];
    const notifSnap = await event.data.ref.get();
    const { score, mismatches, decision } = scorerCorrespondance(ordreDoc.data(), notifSnap.data());

    if (decision === "confirmer") {
      await confirmerDepot(ordreDoc, notifSnap, token, adminId);
    } else {
      const raison = mismatchToRaison(mismatches);
      await ordreDoc.ref.update({
        status: "Paiement Non Reçu",
        flagRaison: raison,
        flaggedAt: FieldValue.serverTimestamp(),
      });
      await sendTelegram(token, adminId,
        `❌ <b>Dépôt rejeté (${score}/3) — ${raison}</b>\nOrdre <code>#${ordreDoc.data().orderId || ordreDoc.id}</code>\n` +
        mismatches.map((m) => `• ${m}`).join("\n")
      );
    }
  }
);

// Parse le SMS, stocke dans waafi_notifications, alerte admin.
// Cas rare : si un ordre "En attente" avec ce TID existe déjà,
// confirme directement (ordre soumis avant l'arrivée du SMS).
// ══════════════════════════════════════════════════════════════════
exports.smsWebhook = onRequest(
  { region: REGION, invoker: "public", secrets: [MACRO_SECRET, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ULTRAMSG_INSTANCE, ULTRAMSG_TOKEN] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST")    { res.status(405).send("Method Not Allowed"); return; }

    const body   = req.body || {};
    const notif  = body.notification || body.not_body || body.message || body.text || "";
    const secret = body.secret || "";

    const expectedSecret = MACRO_SECRET.value() || "Kafia&77105640";
    if (!secret || secret !== expectedSecret) { res.status(403).json({ error: "Secret invalide" }); return; }
    if (!notif) { res.status(400).json({ error: "Champ 'notification' requis" }); return; }

    const transferId = extractTransferId(notif);
    const montant    = extractMontant(notif);
    const numClient  = extractNumClient(notif);

    const docRef = await db.collection("waafi_notifications").add({
      notification: notif, transferId, montant, numClient,
      secret: expectedSecret, source: "macrodroid",
      status: "reçu",
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

    const ordreSnap = await db.collection("depot_orders")
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
    } else {
      const raison = mismatchToRaison(mismatches);
      await ordreDoc.ref.update({
        status: "Paiement Non Reçu",
        flagRaison: raison,
        flaggedAt: FieldValue.serverTimestamp(),
      });
      await sendTelegram(token, adminId,
        `❌ <b>Dépôt rejeté (${score}/3) — ${raison}</b>\nOrdre <code>#${ordreRef2}</code>\n` +
        mismatches.map((m) => `• ${m}`).join("\n")
      );
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — HEALTH CHECK
// ══════════════════════════════════════════════════════════════════
exports.healthCheck = onRequest(
  { region: REGION, invoker: "public", secrets: [] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const t0 = Date.now();
    let firestoreMs = "?", statut = "ok";
    try {
      await db.collection("depot_orders").limit(1).get();
      firestoreMs = `${Date.now() - t0}ms`;
    } catch (e) { firestoreMs = `erreur: ${e.message}`; statut = "degraded"; }

    res.json({
      statut, timestamp: new Date().toISOString(), region: REGION,
      firestore: firestoreMs, version: "6.0",
      flow: "sms_webhook → waafi_notifications → onNouvelDepot/onNouvelRetrait → confirmerDepot",
      exports: 7,
    });
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — TEST MOBCASH (admin only)
// ══════════════════════════════════════════════════════════════════
exports.testMobcash = onRequest(
  { region: REGION, invoker: "public",
    secrets: [MOBCASH_HASH, MOBCASH_CASHIERPASS, MOBCASH_CASHDESKID] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const body   = req.body || {};
    const ak     = body._ak || req.query._ak || "";
    if (ak !== "kp2026_9f3aXmQ7") { res.status(403).json({ ok: false, error: "Non autorisé" }); return; }

    const type      = (body.type || "depot").toLowerCase();
    const montant   = Number(body.montant || 0);
    const code      = (body.code || "").trim();
    const userId    = (body.userId || "0").trim();

    try {
      const data = type === "retrait"
        ? await callMobcash("Retrait", userId, montant, code)
        : await callMobcash("Dépôt",   userId, montant, "");
      res.json({ ok: true, data });
    } catch (e) {
      res.json({ ok: false, error: e.message, rawData: e.rawData || null, debugInfo: e.debugInfo || null });
    }
  }
);

// HTTP — WHATSAPP RECAP (appelé par le bouton "Recevoir les détails")
// Envoie automatiquement via UltraMsg — pas de wa.me manuel.
// ══════════════════════════════════════════════════════════════════
exports.waRecap = onRequest(
  { region: REGION, invoker: "public", secrets: [ULTRAMSG_INSTANCE, ULTRAMSG_TOKEN] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const ordreId = (req.query.ordreId || (req.body || {}).ordreId || "").trim();
    if (!ordreId) { res.status(400).json({ ok: false, reason: "ordreId requis" }); return; }

    const orderDoc = await findOrder(ordreId).catch(() => null);
    if (!orderDoc) { res.status(404).json({ ok: false, reason: "Ordre introuvable" }); return; }

    const o          = orderDoc.data();
    const phone      = o.whatsapp || "";
    if (!phone) { res.status(400).json({ ok: false, reason: "Aucun numéro WhatsApp" }); return; }

    const montantStr = Number(o.montant || 0).toLocaleString();
    const isRetrait  = o.type === "Retrait";
    let statut;
    if (o.status === "Payé")
      statut = "✅ Payé — Paiement envoyé avec succès. Vérifiez votre solde Waafi.";
    else if (o.status === "Code Validé")
      statut = "⏳ Code Validé — Fonds retirés. Transfert Waafi en cours.";
    else if (o.status === "Code Invalide")
      statut = `❌ Code Invalide — ${o.flagRaison || "contactez le support"}`;
    else if (o.status === "Crédité avec succès")
      statut = "✅ Crédité avec succès";
    else if (o.status === "Paiement Reçu")
      statut = "💳 Paiement reçu — crédit 1xBet en cours...";
    else if (o.status === "Paiement Non Reçu")
      statut = `❌ Paiement non reçu — ${o.flagRaison || "contactez le support"}`;
    else if (o.status === "Annulé")
      statut = "🚫 Annulé";
    else
      statut = o.status || "⏳ En attente";

    const msg = !isRetrait
      ? `🧾 *Kaffi-Pay — Récapitulatif Dépôt*\n\n` +
        `N° Ordre : *#${ordreId}*\n` +
        `Montant : ${montantStr} DJF\n` +
        `ID 1xBet : ${o.userId1xBet || o.id1x || "—"}\n` +
        `Waafi Transfer ID : ${o.waafitranfertID || o.hash || "—"}\n` +
        `N° Expéditeur : ${o.numeroPayment || "—"}\n` +
        `Statut : ${statut}\n\n` +
        `📲 kaffi-pay.com/#suivi-${ordreId}`
      : `🧾 *Kaffi-Pay — Récapitulatif Retrait*\n\n` +
        `N° Ordre : *#${ordreId}*\n` +
        `Montant : ${montantStr} DJF\n` +
        `Code retrait : ${o.withdrawalCode || o.code || "—"}\n` +
        `Numéro Waafi : ${o.waafiNumber || o.tel || "—"}\n` +
        `Statut : ${statut}\n\n` +
        `📲 kaffi-pay.com/#suivi-${ordreId}`;

    const result = await sendWhatsApp(phone, msg);
    if (result.ok) {
      res.json({ ok: true });
    } else {
      res.status(500).json({ ok: false, reason: result.reason || result.body || "Échec UltraMsg" });
    }
  }
);


// ══════════════════════════════════════════════════════════════════
// HTTP — SUPPORT CLIENT
// Flux simple : client donne numéro d'ordre → Firestore → affiche statut
// ══════════════════════════════════════════════════════════════════
exports.supportClient = onRequest(
  { region: REGION, invoker: "public", secrets: [SUPPORT_BOT_TOKEN, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ULTRAMSG_INSTANCE, ULTRAMSG_TOKEN,
                              MOBCASH_HASH, MOBCASH_CASHIERPASS, MOBCASH_CASHDESKID, MOBCASH_LOGIN], timeoutSeconds: 60 },
  async (req, res) => {
    res.status(200).send("OK");

    const supportToken = SUPPORT_BOT_TOKEN.value();
    if (!supportToken) {
      console.error("supportClient: SUPPORT_BOT_TOKEN non configuré");
      return;
    }

    // ── Helpers ───────────────────────────────────────────────────
    const SIG = "\n\n<i>— Support Kaffi-Pay · kaffi-pay.com</i>";

    async function reply(chatId, txt) {
      return sendTelegramToBot(supportToken, chatId, txt + SIG);
    }
    async function replyKb(chatId, txt, kb) {
      return sendTelegramKeyboard(supportToken, chatId, txt + SIG, kb);
    }

    const MAIN_KB = [
      [{ text: "📋 Suivre mon ordre", callback_data: "sc_ordre" }, { text: "⚡ Délais", callback_data: "sc_delais" }],
      [{ text: "📥 Comment déposer", callback_data: "sc_depot" }, { text: "📤 Comment retirer", callback_data: "sc_retrait" }],
      [{ text: "💰 Tarifs",          callback_data: "sc_tarifs" }, { text: "👤 Agent humain",   callback_data: "sc_agent"  }],
    ];
    const BACK_KB = [[{ text: "🏠 Menu principal", callback_data: "sc_menu" }]];
    const AGENT_KB = [[{ text: "👤 Contacter un agent", callback_data: "sc_agent" }], ...BACK_KB];

    // ── Contenus FAQ ─────────────────────────────────────────────
    const FAQ = {
      depot:
        `📥 <b>Comment effectuer un dépôt 1xBet</b>\n\n` +
        `1️⃣ Allez sur <b>kaffi-pay.com</b> → onglet <b>Dépôt</b>\n` +
        `2️⃣ Remplissez le formulaire :\n` +
        `   • <b>Montant</b> à déposer\n` +
        `   • <b>ID 1xBet</b> (votre identifiant de compte)\n` +
        `   • <b>Numéro Waafi expéditeur</b> (le numéro depuis lequel vous payez)\n` +
        `   • <b>Numéro de transfert Waafi</b> (reçu par SMS après le paiement)\n` +
        `   • <b>Numéro WhatsApp</b> (pour recevoir les confirmations)\n` +
        `3️⃣ Payez via Waafi Mobile au numéro <code>77 27 55 72</code>\n` +
        `4️⃣ Validez le formulaire\n\n` +
        `✅ Votre compte 1xBet est crédité <b>rapidement</b> après la validation de votre paiement.`,

      retrait:
        `📤 <b>Comment effectuer un retrait 1xBet</b>\n\n` +
        `1️⃣ Sur 1xBet → <b>Finances → Retirer des fonds</b>\n` +
        `2️⃣ Sélectionnez <b>"Code de retrait"</b>, saisissez le montant et copiez le code\n` +
        `3️⃣ Allez sur <b>kaffi-pay.com</b> → onglet <b>Retrait</b>\n` +
        `4️⃣ Remplissez le formulaire :\n` +
        `   • <b>ID 1xBet</b> (votre identifiant de compte)\n` +
        `   • <b>Code de retrait</b> (généré sur 1xBet)\n` +
        `   • <b>Numéro Waafi</b> (pour recevoir l'argent)\n` +
        `   • <b>Numéro WhatsApp</b> (pour recevoir les confirmations)\n` +
        `5️⃣ Validez — l'argent arrive sur votre Waafi <b>rapidement</b>.\n\n` +
        `⚠️ Le code de retrait expire en <b>24 heures</b> — ne tardez pas.`,

      delais:
        `⚡ <b>Délais de traitement</b>\n\n` +
        `Notre système est <b>100% automatique</b> — aucune validation manuelle, aucune attente d'un agent.\n\n` +
        `Vos ordres sont traités <b>dès réception</b>, que ce soit un dépôt ou un retrait.\n\n` +
        `⏰ Service opérationnel <b>24h/24 — 7j/7</b>, jours fériés inclus.`,

      tarifs:
        `💰 <b>Tarifs — aucun frais caché</b>\n\n` +
        `• Dépôt minimum : <b>50 DJF</b>\n` +
        `• Retrait minimum : <b>250 DJF</b>\n` +
        `• Commission : <b>0 DJF</b> — vous recevez exactement ce que vous envoyez\n\n` +
        `📱 Numéro Waafi pour payer : <code>77 27 55 72</code>`,

      securite:
        `🔒 <b>Sécurité & Fiabilité</b>\n\n` +
        `• Chaque transaction est vérifiée et sécurisée\n` +
        `• Historique complet de vos transactions sur <b>kaffi-pay.com</b>\n` +
        `• Service fiable, disponible <b>24h/24</b>\n\n` +
        `Kaffi-Pay est le service de confiance pour vos transactions 1xBet à Djibouti.`,

      annuler:
        `🚫 <b>Annuler un ordre</b>\n\n` +
        `Vous pouvez annuler uniquement si l'ordre est encore <b>"En attente"</b>.\n\n` +
        `<b>Comment faire :</b>\n` +
        `1️⃣ Allez sur <b>kaffi-pay.com</b>\n` +
        `2️⃣ Ouvrez votre ordre dans l'historique\n` +
        `3️⃣ Appuyez sur <b>🚫 Annuler cet ordre</b>\n\n` +
        `⚠️ Un ordre <b>Crédité</b> ou <b>Payé</b> ne peut pas être annulé.`,
    };

    // ── Callback query (clics sur boutons) ──────────────────────
    const cbq = (req.body || {}).callback_query;
    if (cbq) {
      try {
        await answerCallback(supportToken, cbq.id, "");
        const cbChatId  = String(cbq.message.chat.id);
        const cbData    = cbq.data || "";
        const cbName    = (cbq.from || {}).first_name || "Client";

        if (cbData === "sc_menu") {
          await replyKb(cbChatId, `👋 Comment puis-je vous aider ?`, MAIN_KB);
        } else if (cbData === "sc_depot") {
          await replyKb(cbChatId, FAQ.depot, BACK_KB);
        } else if (cbData === "sc_retrait") {
          await replyKb(cbChatId, FAQ.retrait, BACK_KB);
        } else if (cbData === "sc_delais") {
          await replyKb(cbChatId, FAQ.delais, BACK_KB);
        } else if (cbData === "sc_tarifs") {
          await replyKb(cbChatId, FAQ.tarifs, BACK_KB);
        } else if (cbData === "sc_ordre") {
          await reply(cbChatId,
            `📋 <b>Suivi de votre ordre</b>\n\nEnvoyez votre <b>numéro d'ordre</b> et je l'affiche instantanément.\nExemple : <code>#06111</code>`
          );
        } else if (cbData === "sc_agent") {
          const adminTok = TELEGRAM_TOKEN.value();
          const adminId0 = TELEGRAM_ADMIN_ID.value();
          await replyKb(cbChatId,
            `👤 <b>Un agent va vous répondre</b>\n\nVotre demande a été transmise à notre équipe.\nUn agent vous répondra dans les plus brefs délais.`,
            BACK_KB
          );
          await sendTelegram(adminTok, adminId0,
            `🆘 <b>Demande agent</b> — Support Bot\n👤 ${cbName} (chat: <code>${cbChatId}</code>)`
          );
        }
      } catch (e) { console.error("supportClient cbq crash:", e.message); }
      return;
    }

    // ── Message texte ─────────────────────────────────────────────
    const msg = (req.body || {}).message || (req.body || {}).edited_message;
    if (!msg) return;

    const chatId    = String(msg.chat.id);
    const text      = (msg.text || "").trim();
    const firstName = (msg.from || {}).first_name || "Client";

    // Message sans texte (photo, sticker, voice…)
    if (!text) {
      await replyKb(chatId, `Veuillez envoyer un <b>message texte</b>.\nComment puis-je vous aider ?`, MAIN_KB);
      return;
    }

    const t = text.toLowerCase().trim();

    try {
      // Extraire numéro d'ordre (5-8 chiffres)
      const ordreMatch = text.match(/(?:#\s*)?(\d{5,8})\b/i);
      const ordreId    = ordreMatch ? ordreMatch[1] : null;

      // ── /start ──
      if (t === "/start" || t === "start") {
        await replyKb(chatId,
          `👋 <b>Bienvenue chez Kaffi-Pay !</b>\n\n` +
          `Je suis votre assistant — service disponible <b>24h/24</b>.\n\n` +
          `Comment puis-je vous aider ?`,
          MAIN_KB
        );
        return;
      }

      // ── Salutations (Français + Somali + Arabe) ──
      if (/^(bonjour|salut|bonsoir|hello|salam|hi|allo|allô|bjr|bj|nabad|marhaba|ahlan|asalam|salaamu|wa calaykum|صباح|مرحبا|السلام|haye|hey|yo)\b/i.test(t)) {
        await replyKb(chatId,
          `👋 Bonjour !\n\nJe suis votre assistant Kaffi-Pay.\nComment puis-je vous aider ?`,
          MAIN_KB
        );
        return;
      }

      // ── Aide ──
      if (/^(aide|help|menu|\?+$)/.test(t) || t === "/aide" || t === "/help" || /que.*faire|quoi.*faire|option/.test(t)) {
        await replyKb(chatId, `Comment puis-je vous aider ?`, MAIN_KB);
        return;
      }

      // ── Délais ──
      if (/délai|durée|combien.*temps|quand.*confirm|vite|rapide|longtemps|attente/.test(t)) {
        await replyKb(chatId, FAQ.delais, BACK_KB);
        return;
      }

      // ── Tarifs ──
      if (/tarif|frais|commiss|coût|prix|combien.*pay|minimum|gratuit|0 djf/.test(t)) {
        await replyKb(chatId, FAQ.tarifs, BACK_KB);
        return;
      }

      // ── Retrait ──
      if (/retrait|retirer|code.*retrait|retrait.*1xbet|comment.*retirer|withdraw/.test(t)) {
        await replyKb(chatId, FAQ.retrait, BACK_KB);
        return;
      }

      // ── Dépôt / Comment ça marche ──
      if (/depot|dépôt|recharger?|comment.*(fonc|march|utilis|faire)|étape|procédure|expliqu|commenc/.test(t)) {
        await replyKb(chatId, FAQ.depot, BACK_KB);
        return;
      }

      // ── Annulation ──
      if (/annul|cancel|comment.*annul/.test(t)) {
        await replyKb(chatId, FAQ.annuler, BACK_KB);
        return;
      }

      // ── Sécurité / Confiance ──
      if (/sécurité|sécurisé|confiance|fiable|arnaque|escroquerie|sûr/.test(t)) {
        await replyKb(chatId, FAQ.securite, BACK_KB);
        return;
      }

      // ── Problème général ──
      if (/pas.*reçu|non.*crédit|pas.*crédit|toujours.*pas|n'a pas|pas.*arrivé|problem|problème|erreur|bloqué|coincé/.test(t)) {
        await replyKb(chatId,
          `⚠️ <b>Problème avec votre ordre ?</b>\n\nUtilisez le bouton <b>Suivre mon ordre</b> pour vérifier votre statut, ou contactez un agent.`,
          [[{ text: "📋 Suivre mon ordre", callback_data: "sc_ordre" }, { text: "👤 Contacter un agent", callback_data: "sc_agent" }]]
        );
        return;
      }

      // ── Demande d'agent ──
      if (/agent|humain|opérateur|parler.*quelqu|quelqu.*humain|personne|responsable|admin|réel|contact/.test(t)) {
        const adminTok2 = TELEGRAM_TOKEN.value();
        const adminId3  = TELEGRAM_ADMIN_ID.value();
        await replyKb(chatId,
          `👤 <b>Un agent va vous répondre</b>\n\nVotre demande est transmise à notre équipe.\nUn agent vous répondra dans les plus brefs délais.`,
          BACK_KB
        );
        await sendTelegram(adminTok2, adminId3,
          `🆘 <b>Demande agent</b> — Support Bot\n👤 ${firstName} (chat: <code>${chatId}</code>)\nMsg : <i>${text.substring(0, 200)}</i>`
        );
        return;
      }

      // ── Numéro d'ordre → Firestore ───────────────────────────
      if (ordreId) {
        const orderDoc = await findOrder(ordreId).catch(() => null);
        if (!orderDoc) {
          await replyKb(chatId,
            `❓ Ordre <b>#${ordreId}</b> introuvable.\n\nVérifiez votre numéro sur <b>kaffi-pay.com</b> dans l'historique.\n(Le numéro fait 5 à 8 chiffres — ex: <code>#06111</code>)`,
            AGENT_KB
          );
          return;
        }

        const o          = orderDoc.data();
        const oRef       = orderDoc.ref;
        const wbOk       = o.webhookStatus === "ok" || o.webhookStatus === "ok_retry_rt";
        const adminTok   = TELEGRAM_TOKEN.value();
        const adminId2   = TELEGRAM_ADMIN_ID.value();

        // Paiement reçu, crédit bloqué → relance automatique
        if (o.status === "Paiement Reçu" && !wbOk) {
          const id1xbet = o.userId1xBet || o.id1x || "";
          if (!id1xbet) {
            await replyKb(chatId,
              `⚠️ Votre paiement est bien reçu mais votre <b>ID de compte 1xBet est manquant</b>.\nNotre équipe vous contacte sous peu.`,
              AGENT_KB
            );
            await sendTelegram(adminTok, adminId2,
              `🆘 <b>ID 1xBet manquant</b> — 👤 ${firstName}\nOrdre <b>#${ordreId}</b> | ${Number(o.montant||0).toLocaleString()} DJF`);
            return;
          }
          await replyKb(chatId,
            `💳 <b>Paiement reçu — Crédit en cours</b>\n\nOrdre <b>#${ordreId}</b> — ${Number(o.montant||0).toLocaleString()} DJF\n\n⏱️ Votre compte 1xBet sera crédité dans quelques instants.`,
            [[{ text: "🔄 Actualiser", callback_data: "sc_menu" }]]
          );
          await sendTelegram(adminTok, adminId2,
            `📋 <b>Support → relance</b> — 👤 ${firstName} — Ordre <b>#${ordreId}</b> | <code>${id1xbet}</code>`);
          try {
            await callMobcash(o.type || "Dépôt", id1xbet, o.montant || 0, o.withdrawalCode || "");
            const tid2 = o.waafitranfertID || o.hash || "";
            if (tid2) db.collection("ordre_traite").doc(tid2).update({ status: "credite", creditedAt: FieldValue.serverTimestamp() }).catch(() => {});
            await oRef.update({ status: "Crédité avec succès", webhookStatus: "ok", webhookAt: FieldValue.serverTimestamp() });
            logAudit("mobcash_ok_support", { ordreId, clientName: firstName });
          } catch (err) {
            await oRef.update({ webhookStatus: "echec", webhookErr: err.message });
            await sendTelegram(adminTok, adminId2,
              `⚠️ Relance échouée (support) — #${ordreId}\n<code>${err.message}</code>`);
          }
          return;
        }

        // Crédité mais client réclame
        if (o.status === "Crédité avec succès") {
          await replyKb(chatId,
            statutOrdreMsg(ordreId, o) +
            `\n\n📞 Si le crédit n'apparaît pas encore sur 1xBet, attendez 2 minutes et actualisez.\nSi le problème persiste, notre équipe est déjà alertée.`,
            AGENT_KB
          );
          await sendTelegram(adminTok, adminId2,
            `🆘 <b>Crédité mais client réclame</b> — 👤 ${firstName}\nOrdre <b>#${ordreId}</b>`);
          return;
        }

        // Rejeté
        if (o.status === "Paiement Non Reçu") {
          await replyKb(chatId,
            statutOrdreMsg(ordreId, o) +
            `\n\n<b>Que faire ?</b>\n` +
            `• Vérifiez que votre numéro de transfert est exact\n` +
            `• Soumettez un <b>nouvel ordre</b> sur kaffi-pay.com\n` +
            `• En cas de doute, contactez un agent`,
            AGENT_KB
          );
          await sendTelegram(adminTok, adminId2,
            `🆘 <b>Support</b> | 👤 ${firstName} | <b>#${ordreId}</b> rejeté — ${o.flagRaison || "?"}`);
          return;
        }

        // Tous les autres statuts
        await replyKb(chatId, statutOrdreMsg(ordreId, o), [
          [{ text: "🔄 Actualiser", callback_data: "sc_menu" }],
          [{ text: "👤 Contacter un agent", callback_data: "sc_agent" }],
        ]);
        return;
      }

      // ── Fallback ──────────────────────────────────────────────
      await replyKb(chatId, `Comment puis-je vous aider ?`, MAIN_KB);

    } catch (e) {
      console.error("supportClient crash:", e.message, e.stack);
      try { await reply(chatId, "Une erreur temporaire s'est produite. Réessayez dans quelques instants."); } catch {}
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — ADMIN BOT
// ══════════════════════════════════════════════════════════════════
exports.adminBot = onRequest(
  { region: REGION, invoker: "public", secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, SUPPORT_BOT_TOKEN, MACRO_SECRET,
                              ULTRAMSG_INSTANCE, ULTRAMSG_TOKEN,
                              MOBCASH_HASH, MOBCASH_CASHIERPASS, MOBCASH_CASHDESKID, MOBCASH_LOGIN], timeoutSeconds: 60 },
  async (req, res) => {
    res.status(200).send("OK");
    try {
      // ── Callback query — boutons inline (ex: Terminer retrait) ──
      const callbackQuery = (req.body || {}).callback_query;
      if (callbackQuery) {
        const cbToken   = TELEGRAM_TOKEN.value();
        const cbAdminId = String(TELEGRAM_ADMIN_ID.value());
        const fromId    = String((callbackQuery.from || {}).id || "");
        const cbData    = callbackQuery.data || "";
        const cbId      = callbackQuery.id;

        if (fromId === cbAdminId && cbData.startsWith("terminer_")) {
          const ordreId = cbData.replace("terminer_", "");

          await answerCallback(cbToken, cbId, "✅ Retrait finalisé !");

          const doc = await findOrder(ordreId).catch(() => null);
          if (!doc) {
            await sendTelegram(cbToken, cbAdminId, `❓ Ordre <b>#${ordreId}</b> introuvable.`);
            return;
          }

          const data = doc.data();

          if (data.status === "Payé") {
            await sendTelegram(cbToken, cbAdminId, `ℹ️ Retrait <b>#${ordreId}</b> déjà finalisé.`);
            return;
          }

          if (!transitionValide(data.status, "Payé")) {
            await sendTelegram(cbToken, cbAdminId,
              `⛔ Impossible de finaliser — statut actuel : <b>${data.status}</b>.`);
            return;
          }

          await doc.ref.update({
            status: "Payé",
            finalisePar: "admin_terminer_button",
            finaliseAt: FieldValue.serverTimestamp(),
          });
          // Archiver dans ordre_traite comme finalisé
          await db.collection("ordre_traite").add({
            ordreId,
            type: "Retrait",
            montant: data.montant || 0,
            waafiNumber: data.waafiNumber || data.tel || "",
            finalisePar: "admin_terminer_button",
            finaliseAt: FieldValue.serverTimestamp(),
            status: "finalise",
          }).catch(() => {});
          // onOrdreUpdated gère WhatsApp 3/3 + Telegram "Crédité avec succès" automatiquement.
          logAudit("retrait_finalise_admin", { ordreId, adminId: cbAdminId });
        } else {
          await answerCallback(cbToken, cbId, "");
        }
        return;
      }

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
        const doc = await findOrder(num).catch(() => null);
        if (!doc) { await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`); return; }
        const data = doc.data();
        if (data.status === "Crédité avec succès" || data.status === "Payé") { await sendTelegram(token, adminId, `ℹ️ <b>#${num}</b> déjà finalisé.`); return; }
        const montantVal = Number(data.montant || 0);
        if (data.type === "Retrait") {
          if (!transitionValide(data.status, "Code Validé")) { await sendTelegram(token, adminId, `⛔ Impossible de confirmer — statut : <b>${data.status}</b>.`); return; }
          await doc.ref.update({ status: "Code Validé", confirmedBy: "admin_telegram", confirmedAt: FieldValue.serverTimestamp() });
          await sendTelegram(token, adminId, `✅ Retrait <b>#${num}</b> — Code Validé — ${montantVal.toLocaleString()} DJF`);
        } else {
          if (!transitionValide(data.status, "Paiement Reçu")) { await sendTelegram(token, adminId, `⛔ Impossible de confirmer — statut : <b>${data.status}</b>.`); return; }
          await doc.ref.update({ status: "Paiement Reçu", confirmedBy: "admin_telegram", confirmedAt: FieldValue.serverTimestamp() });
          await sendTelegram(token, adminId, `✅ Dépôt <b>#${num}</b> confirmé — ${montantVal.toLocaleString()} DJF\n🔄 MobCash en cours...`);
        }
        logAudit("confirme_admin_telegram", { num, adminId, type: data.type });
        return;
      }

      // rejeter #ID [raison]
      const rejectMatch = text.match(/^rejeter?\s+#?(\d{5,8})(?:\s+(.+))?$/i);
      if (rejectMatch) {
        const num    = rejectMatch[1];
        const raison = (rejectMatch[2] || "Rejeté par admin").trim();
        const doc = await findOrder(num).catch(() => null);
        if (!doc) { await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`); return; }
        const data = doc.data();
        if (data.status === "Paiement Non Reçu" || data.status === "Code Invalide") { await sendTelegram(token, adminId, `ℹ️ <b>#${num}</b> déjà rejeté.`); return; }
        const rejetStatut = data.type === "Retrait" ? "Code Invalide" : "Paiement Non Reçu";
        if (!transitionValide(data.status, rejetStatut)) { await sendTelegram(token, adminId, `⛔ Impossible de rejeter — statut : <b>${data.status}</b>.`); return; }
        await doc.ref.update({ status: rejetStatut, flagRaison: raison, rejectedBy: "admin_telegram", flaggedAt: FieldValue.serverTimestamp() });
        logAudit("rejete_admin_telegram", { num, raison, adminId, type: data.type });
        await sendTelegram(token, adminId, `❌ Ordre <b>#${num}</b> — ${rejetStatut}.\nRaison : <i>${raison}</i>`);
        return;
      }

      // remettre #ID — remet un ordre en "En attente" pour re-vérification manuelle
      const remettreMatch = text.match(/^remettre\s+#?(\d{5,8})\b/i);
      if (remettreMatch) {
        const num  = remettreMatch[1];
        const doc = await findOrder(num).catch(() => null);
        if (!doc) { await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`); return; }
        const data = doc.data();
        if (!transitionValide(data.status, "En attente")) {
          await sendTelegram(token, adminId, `⛔ Impossible de remettre en attente un ordre en statut <b>${data.status}</b>.`); return;
        }
        await doc.ref.update({ status: "En attente", remisEnAttenteBy: "admin_telegram", remisEnAttenteAt: FieldValue.serverTimestamp() });
        logAudit("remis_en_attente_admin", { num, adminId, ancienStatut: data.status });
        await sendTelegram(token, adminId, `🔄 Ordre <b>#${num}</b> remis en attente.\nTu peux maintenant le confirmer après vérification.`);
        return;
      }

      // client 77XXXXXXX
      const clientMatch = text.match(/^client\s+((?:77|78|70|71|21)\d{6})\b/i);
      if (clientMatch) {
        const phone = clientMatch[1];
        const [depotSnap2, retraitSnap2] = await Promise.all([
          db.collection("depot_orders").where("numeroPayment", "==", phone).limit(10).get().catch(() => ({ docs: [] })),
          db.collection("retrait_orders").where("waafiNumber", "==", phone).limit(10).get().catch(() => ({ docs: [] })),
        ]);
        const snap = { docs: [...depotSnap2.docs, ...retraitSnap2.docs], empty: true };
        snap.empty = snap.docs.length === 0;
        if (snap.empty) { await sendTelegram(token, adminId, `❓ Aucun ordre pour <code>${phone}</code>.`); return; }
        const lignes = snap.docs.map((d) => { const o = d.data(); return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status}`; });
        await sendTelegram(token, adminId, `👤 <b>Ordres ${phone} (${snap.docs.length})</b>\n\n${lignes.join("\n")}`);
        return;
      }

      // alerte
      if (t === "alerte" || t === "/alerte") {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000);
        const [depotAl, retraitAl] = await Promise.all([
          db.collection("depot_orders").where("status", "==", "En attente").get().catch(() => ({ docs: [] })),
          db.collection("retrait_orders").where("status", "==", "En attente").get().catch(() => ({ docs: [] })),
        ]);
        const snap = { docs: [...depotAl.docs, ...retraitAl.docs] };
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
        await sendTelegram(token, adminId, `📭 <b>SMS en attente (${snap.docs.length})</b>\n\n${lignes.join("\n")}`);
        return;
      }

      // test mobcash — vérifie que MobCash répond (login)
      if (t === "test mobcash" || t === "/test_mobcash" || t === "test macro" || t === "/test_macro") {
        await sendTelegram(token, adminId, "🔄 Test MobCash (login)…");
        try {
          await callMobcash("Dépôt", "TEST_NO_EXEC", 0, null);
          await sendTelegram(token, adminId, "✅ MobCash répond correctement !");
        } catch (e) {
          await sendTelegram(token, adminId,
            `❌ MobCash : <code>${e.message}</code>\n\n` +
            "Vérifiez les secrets : MOBCASH_HASH, MOBCASH_CASHIERPASS, MOBCASH_CASHDESKID, MOBCASH_LOGIN");
        }
        return;
      }

      // test whatsapp — diagnostic complet Ultramsg
      if (t.startsWith("test whatsapp")) {
        const numMatch = text.match(/(\+?\d{8,15})/);
        if (!numMatch) { await sendTelegram(token, adminId, "Usage: <code>test whatsapp +25377XXXXXX</code>"); return; }
        const rawInstance = ULTRAMSG_INSTANCE.value();
        const waToken     = ULTRAMSG_TOKEN.value();
        if (!rawInstance || !waToken) {
          await sendTelegram(token, adminId,
            "❌ Secrets Ultramsg manquants :\n" +
            `• ULTRAMSG_INSTANCE_ID : ${rawInstance ? "✅" : "❌ non défini"}\n` +
            `• ULTRAMSG_TOKEN : ${waToken ? "✅" : "❌ non défini"}`);
          return;
        }
        // Normalisation identique à sendWhatsApp
        let iid = rawInstance.replace(/^#/, "").trim();
        if (/^\d+$/.test(iid)) iid = "instance" + iid;
        const apiUrl = `https://api.ultramsg.com/${iid}/messages/chat`;
        await sendTelegram(token, adminId,
          `🔍 <b>Diagnostic WhatsApp</b>\n` +
          `Secret brut : <code>${rawInstance}</code>\n` +
          `Instance normalisée : <code>${iid}</code>\n` +
          `URL : <code>${apiUrl}</code>\n` +
          `Token (5 premiers car.) : <code>${waToken.slice(0,5)}…</code>\n\n` +
          `🔄 Vérification statut instance…`);
        // 1) Vérifie le statut de l'instance
        let statusInfo = "—";
        try {
          const sr = await fetch(
            `https://api.ultramsg.com/${iid}/instance/status?token=${encodeURIComponent(waToken)}`,
            { signal: AbortSignal.timeout(10000) }
          );
          const sb = await sr.text();
          statusInfo = sb.slice(0, 200);
        } catch (e) { statusInfo = "Timeout / erreur réseau : " + e.message; }
        await sendTelegram(token, adminId, `📡 Statut instance :\n<code>${statusInfo}</code>`);
        // 2) Tente l'envoi
        await sendTelegram(token, adminId, `📤 Envoi test vers <code>${numMatch[1]}</code>…`);
        const result = await sendWhatsApp(numMatch[1], "✅ Test Kaffi-Pay — WhatsApp fonctionne !");
        if (result && result.ok) {
          await sendTelegram(token, adminId,
            `✅ <b>Message envoyé avec succès !</b>\nRéponse Ultramsg : <code>${String(result.body).slice(0,300)}</code>`);
        } else {
          await sendTelegram(token, adminId,
            `❌ <b>Échec envoi</b>\nHTTP status : <code>${result?.status || "N/A"}</code>\n` +
            `Raison : <code>${result?.reason || result?.body || "inconnu"}</code>`);
        }
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

      // statut support — vérifie l'état du webhook du bot client
      if (t === "statut support" || t === "/statut_support") {
        const sToken = SUPPORT_BOT_TOKEN.value();
        if (!sToken) {
          await sendTelegram(token, adminId, "❌ Secret <b>SUPPORT_BOT_TOKEN</b> non configuré dans Firebase Secrets.");
          return;
        }
        // getMe — vérifie que le token est valide
        const [meR, whR] = await Promise.all([
          fetch(`https://api.telegram.org/bot${sToken}/getMe`, { signal: AbortSignal.timeout(8000) }),
          fetch(`https://api.telegram.org/bot${sToken}/getWebhookInfo`, { signal: AbortSignal.timeout(8000) }),
        ]);
        const meJ  = await meR.json().catch(() => ({}));
        const whJ  = await whR.json().catch(() => ({}));
        const bot  = meJ.result || {};
        const wh   = whJ.result || {};
        await sendTelegram(token, adminId,
          `🤖 <b>Support Bot — Diagnostic</b>\n\n` +
          `<b>Bot :</b> ${bot.first_name || "?"} (@${bot.username || "?"})\n` +
          `<b>Token :</b> ${meJ.ok ? "✅ valide" : "❌ invalide"}\n\n` +
          `<b>Webhook URL :</b>\n<code>${wh.url || "❌ non configuré"}</code>\n` +
          `<b>Mises à jour en attente :</b> ${wh.pending_update_count ?? "?"}\n` +
          `<b>Dernière erreur :</b> ${wh.last_error_message ? `❌ ${wh.last_error_message}` : "✅ aucune"}\n\n` +
          (wh.url
            ? "✅ Bot actif — les messages clients sont reçus."
            : "⚠️ Webhook non configuré !\nTapez <code>webhook support</code> pour le configurer.")
        );
        return;
      }

      // webhook support — configure le webhook Telegram du bot support
      if (t === "webhook support" || t === "/webhook_support") {
        const sToken = SUPPORT_BOT_TOKEN.value();
        if (!sToken) { await sendTelegram(token, adminId, "❌ Secret SUPPORT_BOT_TOKEN non configuré."); return; }
        const funcUrl = "https://europe-west1-kaffi-pay.cloudfunctions.net/supportClient";
        const r = await fetch(`https://api.telegram.org/bot${sToken}/setWebhook`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: funcUrl, allowed_updates: ["message", "callback_query"] }),
          signal: AbortSignal.timeout(10000),
        });
        const rj = await r.json().catch(() => ({}));
        if (rj.ok) {
          await sendTelegram(token, adminId, `✅ Webhook support bot configuré :\n<code>${funcUrl}</code>\n<i>message + callback_query activés</i>`);
        } else {
          await sendTelegram(token, adminId, `❌ Erreur webhook : ${rj.description || r.status}`);
        }
        return;
      }

      // /sms <texte SMS Waafi> — injecte manuellement un SMS Waafi sans MacroDroid
      const smsMatch = text.match(/^\/sms\s+(.+)/is);
      if (smsMatch) {
        const smsText  = smsMatch[1].trim();
        const tid      = extractTransferId(smsText);
        const montant  = extractMontant(smsText);
        const numCli   = extractNumClient(smsText);

        if (!tid && !montant) {
          await sendTelegram(token, adminId,
            `❌ <b>SMS non reconnu</b>\nFormat attendu : Transfer-Id, Received DJF, numéro\n\n` +
            `SMS reçu :\n<code>${smsText.substring(0, 200)}</code>`);
          return;
        }

        // Vérifie si ce TID est déjà dans waafi_notifications
        let existingDoc = null;
        if (tid) {
          const ex = await db.collection("waafi_notifications")
            .where("transferId", "==", tid).limit(1).get();
          if (!ex.empty) existingDoc = ex.docs[0];
        }

        let docRef;
        if (existingDoc) {
          docRef = existingDoc.ref;
          await sendTelegram(token, adminId,
            `ℹ️ TID <code>${tid}</code> déjà enregistré — tentative de confirmation...`);
        } else {
          const newRef = await db.collection("waafi_notifications").add({
            notification: smsText, transferId: tid, montant, numClient: numCli,
            source: "admin_manual", status: "reçu",
            processedAt: FieldValue.serverTimestamp(),
            createdAt: FieldValue.serverTimestamp(),
          });
          docRef = newRef;
          await sendTelegram(token, adminId,
            `📩 <b>SMS Waafi enregistré</b>\n\n` +
            `Transfer-ID: <code>${tid || "?"}</code>\n` +
            `Montant: <b>${montant ? Number(montant).toLocaleString() : "?"} DJF</b>\n` +
            `Expéditeur: <code>${numCli || "?"}</code>\n\n` +
            `<i>Recherche d'un ordre correspondant...</i>`);
        }

        // Cherche un ordre En attente avec ce TID
        if (!tid) {
          await sendTelegram(token, adminId, `⚠️ Transfer-ID non trouvé dans le SMS — confirmation manuelle requise.`);
          return;
        }

        const ordreSnap = await db.collection("depot_orders")
          .where("waafitranfertID", "==", tid)
          .where("status", "==", "En attente").limit(1).get();

        if (ordreSnap.empty) {
          await sendTelegram(token, adminId,
            `⏳ Aucun ordre "En attente" avec TID <code>${tid}</code> trouvé.\n` +
            `La notification est enregistrée — elle sera utilisée dès qu'un ordre correspondant sera soumis.`);
          return;
        }

        const dejaTraite = await db.collection("ordre_traite")
          .where("transferId", "==", tid).limit(1).get();
        if (!dejaTraite.empty) {
          await sendTelegram(token, adminId, `⚠️ TID <code>${tid}</code> déjà traité — doublon bloqué.`);
          return;
        }

        const ordreDoc  = ordreSnap.docs[0];
        const waafiSnap = await docRef.get();
        const { score, mismatches, decision } = scorerCorrespondance(ordreDoc.data(), waafiSnap.data());
        const ordreRef2 = ordreDoc.data().orderId || ordreDoc.id;

        if (decision === "confirmer") {
          await confirmerDepot(ordreDoc, waafiSnap, token, adminId);
          await sendTelegram(token, adminId, `✅ Ordre <b>#${ordreRef2}</b> confirmé via SMS manuel.`);
        } else {
          const raison = mismatchToRaison(mismatches);
          await sendTelegram(token, adminId,
            `❌ <b>Score ${score}/3 — ${raison}</b>\nOrdre <code>#${ordreRef2}</code>\n` +
            mismatches.map((m) => `• ${m}`).join("\n") +
            `\n\nUtilise <code>confirmer ${ordreRef2}</code> pour forcer si nécessaire.`);
        }
        return;
      }

      // webhook admin — configure le webhook du bot admin (message + callback_query pour boutons inline)
      if (t === "webhook admin" || t === "/webhook_admin") {
        const funcUrl = "https://europe-west1-kaffi-pay.cloudfunctions.net/adminBot";
        const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: funcUrl, allowed_updates: ["message", "callback_query"] }),
          signal: AbortSignal.timeout(10000),
        });
        const rj = await r.json().catch(() => ({}));
        if (rj.ok) {
          await sendTelegram(token, adminId, `✅ Webhook admin bot configuré :\n<code>${funcUrl}</code>`);
        } else {
          await sendTelegram(token, adminId, `❌ Erreur webhook : ${rj.description || r.status}`);
        }
        return;
      }

      // recharge #ID — relance MobCash manuellement pour un ordre confirmé
      const rechargeMatch = text.match(/^recharge\s+#?(\d{5,8})\b/i);
      if (rechargeMatch) {
        const num  = rechargeMatch[1];
        const oDoc = await findOrder(num).catch(() => null);
        if (!oDoc) { await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`); return; }
        const oData = oDoc.data();
        if (oData.status !== "Crédité avec succès") {
          await sendTelegram(token, adminId, `⛔ Ordre <b>#${num}</b> non crédité (statut: <b>${oData.status}</b>).`); return;
        }
        const id1xbet        = oData.userId1xBet || oData.id1x || oData.idBet || "";
        const montantVal     = oData.montant || oData.amount || 0;
        const orderType      = oData.type || "Dépôt";
        const withdrawalCode = oData.withdrawalCode || "";
        if (!id1xbet) { await sendTelegram(token, adminId, `⚠️ ID 1xBet manquant pour <b>#${num}</b>.`); return; }
        await sendTelegram(token, adminId, `🔄 Relance MobCash — <b>#${num}</b> | <code>${id1xbet}</code>…`);
        try {
          await callMobcash(orderType, id1xbet, montantVal, withdrawalCode);
          await oDoc.ref.update({ webhookStatus: "ok", webhookAt: FieldValue.serverTimestamp(), rechargeAdmin: true });
          logAudit("recharge_manuelle_ok", { num, adminId, id1xbet });
          await sendTelegram(token, adminId,
            `✅ <b>Recharge réussie !</b>\n#${num} | <code>${id1xbet}</code> | ${Number(montantVal).toLocaleString()} DJF`);
        } catch (e) {
          await sendTelegram(token, adminId, `❌ Échec MobCash : <code>${e.message}</code>`);
        }
        return;
      }

      // Requêtes générales
      const [ordersSnap, notifSnap] = await Promise.all([
        Promise.all([
          db.collection("depot_orders").orderBy("ts", "desc").limit(10).get().catch(() => ({ docs: [] })),
          db.collection("retrait_orders").orderBy("ts", "desc").limit(10).get().catch(() => ({ docs: [] })),
        ]).then(([d, r]) => ({ docs: [...d.docs, ...r.docs].sort((a, b) => (b.data().ts||0) - (a.data().ts||0)).slice(0, 20) })),
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

// ══════════════════════════════════════════════════════════════════
// HTTP — ADMIN API : AGENTS
// GET  → liste des agents
// POST → action: 'add' | 'delete'  +  agent: {name,user,pass,role}
// ══════════════════════════════════════════════════════════════════
const ADMIN_KEY = "kp2026_9f3aXmQ7";
function adminCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
}
function checkAdminKey(req) {
  const ak = (req.body && req.body._ak) || req.query._ak || req.headers["x-admin-key"] || "";
  return ak === ADMIN_KEY;
}

exports.adminAgents = onRequest(
  { region: REGION, invoker: "public" },
  async (req, res) => {
    adminCors(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!checkAdminKey(req)) { res.status(403).json({ ok: false, error: "Non autorisé" }); return; }

    const docRef = db.collection("config").doc("agents");

    try {
      if (req.method === "GET") {
        const snap = await docRef.get();
        const agents = snap.exists ? (snap.data().list || []) : [];
        res.json({ ok: true, agents });
        return;
      }

      if (req.method === "POST") {
        const { action, agent } = req.body || {};
        const snap = await docRef.get();
        let agents = snap.exists ? (snap.data().list || []) : [];

        if (action === "add") {
          if (!agent || !agent.user) { res.status(400).json({ ok: false, error: "Agent invalide" }); return; }
          agents = agents.filter(a => a.user !== agent.user); // évite doublons
          agents.push(agent);
        } else if (action === "delete") {
          if (!agent || !agent.user) { res.status(400).json({ ok: false, error: "Agent invalide" }); return; }
          agents = agents.filter(a => a.user !== agent.user);
        } else {
          res.status(400).json({ ok: false, error: "Action inconnue" }); return;
        }

        await docRef.set({ list: agents, updatedAt: new Date() });
        res.json({ ok: true, agents });
        return;
      }

      res.status(405).json({ ok: false, error: "Méthode non autorisée" });
    } catch (e) {
      console.error("adminAgents error:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — ADMIN API : RÉSERVES
// GET  → données actuelles des réserves
// POST → sauvegarde les réserves  body: { reserves: {...} }
// ══════════════════════════════════════════════════════════════════
exports.adminReserves = onRequest(
  { region: REGION, invoker: "public" },
  async (req, res) => {
    adminCors(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!checkAdminKey(req)) { res.status(403).json({ ok: false, error: "Non autorisé" }); return; }

    const docRef = db.collection("config").doc("reserves");

    try {
      if (req.method === "GET") {
        const snap = await docRef.get();
        const reserves = snap.exists ? (snap.data().data || {}) : {};
        res.json({ ok: true, reserves });
        return;
      }

      if (req.method === "POST") {
        const { reserves } = req.body || {};
        if (!reserves || typeof reserves !== "object") {
          res.status(400).json({ ok: false, error: "Données réserves invalides" }); return;
        }
        await docRef.set({ data: reserves, updatedAt: new Date() });
        res.json({ ok: true });
        return;
      }

      res.status(405).json({ ok: false, error: "Méthode non autorisée" });
    } catch (e) {
      console.error("adminReserves error:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — ADMIN API : STATS DASHBOARD
// GET ?period=today|7j|30j|all&_ak=...
// Retourne stats agrégées depuis Firestore (server-side)
// ══════════════════════════════════════════════════════════════════
exports.adminStats = onRequest(
  { region: REGION, invoker: "public" },
  async (req, res) => {
    adminCors(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!checkAdminKey(req)) { res.status(403).json({ ok: false, error: "Non autorisé" }); return; }

    const period = req.query.period || "all";

    try {
      // Calculer la date de début selon la période
      let startDate = null;
      const now = new Date();
      if (period === "today") {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      } else if (period === "7j") {
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        startDate.setHours(0, 0, 0, 0);
      } else if (period === "30j") {
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        startDate.setHours(0, 0, 0, 0);
      }

      // Requêtes Firestore parallèles
      let depotQ  = db.collection("depot_orders");
      let retraitQ = db.collection("retrait_orders");
      if (startDate) {
        depotQ   = depotQ.where("createdAt",  ">=", startDate);
        retraitQ = retraitQ.where("createdAt", ">=", startDate);
      }

      const [depSnap, retSnap] = await Promise.all([depotQ.get(), retraitQ.get()]);

      const depots   = depSnap.docs.map(d => d.data());
      const retraits = retSnap.docs.map(d => d.data());
      const all      = [...depots, ...retraits];

      const confDep = depots.filter(x => x.status === "Crédité avec succès");
      const confRet = retraits.filter(x => x.status === "Payé" || x.status === "Crédité avec succès");
      const pending = all.filter(x => ["En attente","Paiement Reçu","Code Validé"].includes(x.status));
      const fraudes = all.filter(x => x.fraudType || (x.flagRaison && x.flagRaison.toUpperCase().includes("FRAUDE")));

      const totalDep = confDep.reduce((s, x) => s + Number(x.montant || 0), 0);
      const totalRet = confRet.reduce((s, x) => s + Number(x.montant || 0), 0);

      // Chart data : 7 ou 30 derniers jours groupés par jour
      const chartDays = period === "30j" ? 30 : 7;
      const chart = [];
      for (let i = chartDays - 1; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
        const dEnd = new Date(d); dEnd.setHours(23,59,59,999);
        const label = `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
        const dep = confDep.filter(x => {
          const t = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate() : new Date(x.date || 0);
          return t >= d && t <= dEnd;
        }).reduce((s, x) => s + Number(x.montant || 0), 0);
        const ret = confRet.filter(x => {
          const t = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate() : new Date(x.date || 0);
          return t >= d && t <= dEnd;
        }).reduce((s, x) => s + Number(x.montant || 0), 0);
        chart.push({ label, dep, ret });
      }

      res.json({
        ok: true, period,
        stats: {
          totalDepots:  totalDep,
          countDepots:  confDep.length,
          totalRetraits: totalRet,
          countRetraits: confRet.length,
          pending:  pending.length,
          fraudes:  fraudes.length,
          volume:   totalDep + totalRet,
        },
        chart,
      });
    } catch (e) {
      console.error("adminStats error:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — ADMIN : Relancer un dépôt bloqué (echec_permanent / echec_max)
// POST { _ak, orderId, newUserId1xBet? }
// ══════════════════════════════════════════════════════════════════
exports.adminRetryDeposit = onRequest(
  { region: REGION, invoker: "public",
    secrets: [MOBCASH_HASH, MOBCASH_CASHIERPASS, MOBCASH_CASHDESKID, MOBCASH_LOGIN,
              TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID] },
  async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST")    { res.status(405).json({ ok: false, error: "POST requis" }); return; }
    if (!checkAdminKey(req))      { res.status(403).json({ ok: false, error: "Non autorisé" }); return; }

    const { orderId, newUserId1xBet } = req.body || {};
    if (!orderId) { res.status(400).json({ ok: false, error: "orderId requis" }); return; }

    const token   = TELEGRAM_TOKEN.value();
    const adminId = TELEGRAM_ADMIN_ID.value();

    // Cherche l'ordre dans depot_orders
    const snap = await db.collection("depot_orders")
      .where("orderId", "==", orderId).limit(1).get();
    if (snap.empty) { res.status(404).json({ ok: false, error: "Ordre introuvable" }); return; }

    const ordreDoc = snap.docs[0];
    const o        = ordreDoc.data();

    if (o.status !== "Paiement Reçu") {
      res.status(400).json({ ok: false, error: `Statut actuel '${o.status}' — retry uniquement sur 'Paiement Reçu'` });
      return;
    }

    const userId = newUserId1xBet ? String(newUserId1xBet).trim() : (o.userId1xBet || o.id1x || "");
    if (!userId) { res.status(400).json({ ok: false, error: "ID 1xBet manquant" }); return; }

    try {
      await callMobcash("Dépôt", userId, Number(o.montant || 0), "");

      const tid = o.waafitranfertID || o.hash || "";
      if (tid) {
        db.collection("ordre_traite").doc(tid).update({
          status: "credite", creditedAt: FieldValue.serverTimestamp(),
        }).catch(() => {});
      }

      const updates = {
        status: "Crédité avec succès",
        webhookStatus: "ok",
        webhookAt: FieldValue.serverTimestamp(),
        recoveryBy: "admin_retry",
        webhookRetryCount: 0,
      };
      if (newUserId1xBet) updates.userId1xBet = userId;

      await ordreDoc.ref.update(updates);

      await sendTelegram(token, adminId,
        `✅ <b>Retry Admin — Dépôt crédité</b>\n` +
        `Ordre <code>#${orderId}</code> | ID 1xBet: <code>${userId}</code>\n` +
        `${Number(o.montant||0).toLocaleString()} DJF`
      );
      logAudit("depot_admin_retry_ok", { orderId, userId });
      res.json({ ok: true, message: `Ordre #${orderId} crédité avec succès` });

    } catch (err) {
      const errMsg = err.message || "";
      const estPermanente = ["currency does not match", "account currency", "user not found", "invalid user", "account not found"]
        .some((e) => errMsg.toLowerCase().includes(e));

      await ordreDoc.ref.update({
        webhookStatus: estPermanente ? "echec_permanent" : "echec",
        webhookErr: errMsg,
        webhookRetryCount: 0,
        ...(newUserId1xBet ? { userId1xBet: userId } : {}),
      });

      res.status(400).json({ ok: false, error: errMsg, permanent: estPermanente });
    }
  }
);
