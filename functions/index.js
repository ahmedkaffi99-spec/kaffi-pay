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

  // Signature step 2 : MD5(summa + cashierpass + cashdeskId) — identique pour Dépôt et Retrait
  const part2 = crypto.createHash("md5")
    .update(`summa=${montant}&cashierpass=${cashierpass}&cashdeskid=${cashdeskId}`)
    .digest("hex");

  // Signature step 3 : SHA256(part1 + part2) → header "sign"
  const sign = crypto.createHash("sha256").update(part1 + part2).digest("hex");

  // confirm = MD5(userId:hash) → body
  const confirm = crypto.createHash("md5").update(`${userId}:${hash}`).digest("hex");

  const body = isDepot
    ? { cashdeskid: Number(cashdeskId), lng, summa: montant, confirm }
    : { cashdeskid: Number(cashdeskId), lng, summa: montant, code: String(withdrawalCode || ""), confirm };

  const resp = await fetch(`${MOBCASH_BASE}/Deposit/${userId}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "sign": sign },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`MobCash ${endpoint} HTTP ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  if (data.success === false || (data.messageId && data.messageId !== 0))
    throw new Error(`MobCash ${endpoint}: ${data.message || JSON.stringify(data)}`);
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
      ? "⏳ <b>En attente</b> — Traitement en cours. Veuillez ne pas annuler le code sur votre application 1xbet."
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
    "📋 <code>macro jobs</code> — file d'attente MacroDroid\n" +
    "🔄 <code>test macro</code> — tester le webhook\n" +
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

    // Recherche 1 : par Transfer ID exact
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
        if (!n.montant || Math.abs(montantOrdre - n.montant) > tolerance) continue;
        const dejaTID = n.transferId
          ? (await db.collection("ordre_traite").where("transferId", "==", n.transferId).limit(1).get()).empty
          : true;
        if (dejaTID) { waafiDoc = d; break; }
      }
    }

    if (waafiDoc) {
      const ordreSnap = await db.collection("depot_orders").doc(docId).get();
      const { score, mismatches, decision } = scorerCorrespondance(tx, waafiDoc.data());

      if (decision === "confirmer") {
        await confirmerDepot(ordreSnap, waafiDoc, token, adminId);
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

    // Aucune notification trouvée → Transfer ID invalide/frauduleux
    await db.collection("depot_orders").doc(docId).update({
      status: "Paiement Non Reçu",
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

    const userId1xBet = (tx.userId1xBet || tx.id1x || "").trim();
    if (!userId1xBet) {
      await sendTelegram(token, adminId,
        `⚠️ <b>Retrait sans ID 1xBet</b> — #${ordreId}\nID 1xBet manquant, intervention manuelle requise.`);
      return;
    }

    try {
      const mobcashData    = await callMobcash("Retrait", userId1xBet, montantVal, tidRetrait);
      const montantMobcash = Number(
        mobcashData.summa ?? mobcashData.amount ?? mobcashData.sum ?? montantVal
      );

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

      const ussd    = `*200*${waafiNum}*${montantMobcash}#`;
      const ussdUrl = `tel:${ussd.replace(/#/g, "%23")}`;
      await sendTelegramKeyboard(token, adminId,
        `📤 <b>Retrait à payer — #${ordreId}</b>\n\n` +
        `Montant : <b>${montantMobcash.toLocaleString()} DJF</b>\n` +
        `N° Waafi : <code>${waafiNum}</code>\n` +
        `Code retrait : <code>${tidRetrait}</code>\n\n` +
        `📱 USSD : <code>${ussd}</code>\n\n` +
        `<i>1. Composez le USSD → 2. Confirmez → 3. Cliquez Terminer.</i>`,
        [
          [{ text: `📞 ${ussd}`, url: ussdUrl }],
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
      await event.data.after.ref.update({ webhookStatus: "echec", webhookErr: e.message });
      await sendTelegram(token, adminId,
        `⚠️ <b>MobCash Dépôt échoué</b> — #${ordreId}\n<code>${e.message}</code>\n` +
        `<i>Le scheduler relancera dans 5 min.</i>`);
      logAudit("depot_mobcash_echec", { ordreId, err: e.message });
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
    // MobCash Deposit n'a pas crédité 1xBet. Re-tente automatiquement.
    const snapDepotRecu = await db.collection("depot_orders")
      .where("status", "==", "Paiement Reçu")
      .get().catch(() => ({ docs: [] }));

    for (const ordreDoc of snapDepotRecu.docs) {
      const o         = ordreDoc.data();
      const ordreId   = o.orderId || ordreDoc.id;
      const id1xbet   = o.userId1xBet || o.id1x || "";
      const wbOk      = o.webhookStatus === "ok" || o.webhookStatus === "ok_recovery";

      if (wbOk) continue;
      if (!id1xbet) continue;

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
        await ordreDoc.ref.update({ webhookStatus: "echec", webhookErr: err.message });
        await sendTelegram(token, adminId,
          `⚠️ <b>Recovery Dépôt échoué</b> — #${ordreId}\n<code>${err.message}</code>`
        );
      }
    }

  }
);


// ══════════════════════════════════════════════════════════════════
// HTTP — WEBHOOK MACRODROID (réception SMS Waafi)
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
          `⚠️ Un ordre <b>Crédité</b> ne peut pas être annulé.\n\n` +
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
        const orderDoc = await findOrder(ordreId).catch(() => null);
        if (!orderDoc) {
          await send(
            `❓ Ordre <b>#${ordreId}</b> introuvable.\n\n` +
            `Vérifiez votre numéro d'ordre sur <b>kaffi-pay.com</b>.\n` +
            `Le numéro d'ordre fait 5 à 8 chiffres (ex: <code>#06073</code>).`
          );
          return;
        }
        const o          = orderDoc.data();
        const oRef       = orderDoc.ref;
        const wbOk       = o.webhookStatus === "ok" || o.webhookStatus === "ok_retry_rt";
        const adminToken = TELEGRAM_TOKEN.value();
        const adminId2   = TELEGRAM_ADMIN_ID.value();

        // ── Paiement reçu mais crédit échoué → support bot relance MobCash ──
        if (o.status === "Paiement Reçu" && !wbOk) {
          const id1xbet = o.userId1xBet || o.id1x || "";
          if (!id1xbet) {
            await send(
              `⚠️ Votre paiement est reçu mais votre <b>ID 1xBet est manquant</b>.\n` +
              `Notre équipe va vous contacter sous peu.`
            );
            await sendTelegram(adminToken, adminId2,
              `🆘 <b>ID 1xBet manquant</b> — 👤 ${firstName}\nOrdre <b>#${ordreId}</b> | ${Number(o.montant||0).toLocaleString()} DJF`);
            return;
          }
          await send(
            `💳 <b>Paiement reçu — Crédit en cours</b>\n\n` +
            `Ordre : <b>#${ordreId}</b> | ${Number(o.montant||0).toLocaleString()} DJF\n` +
            `ID 1xBet : <code>${id1xbet}</code>\n\n` +
            `⏱️ Votre compte sera crédité sous peu.`
          );
          await sendTelegram(adminToken, adminId2,
            `📋 <b>Support → relance MobCash</b> — 👤 ${firstName}\nOrdre <b>#${ordreId}</b> | <code>${id1xbet}</code>`);
          try {
            const orderType = o.type || "Dépôt";
            await callMobcash(orderType, id1xbet, o.montant || 0, o.withdrawalCode || "");
            const tid2 = o.waafitranfertID || o.hash || "";
            if (tid2) db.collection("ordre_traite").doc(tid2).update({ status: "credite", creditedAt: FieldValue.serverTimestamp() }).catch(() => {});
            await oRef.update({ status: "Crédité avec succès", webhookStatus: "ok", webhookAt: FieldValue.serverTimestamp() });
            logAudit("mobcash_ok_support", { ordreId, clientName: firstName });
          } catch (err) {
            await oRef.update({ webhookStatus: "echec", webhookErr: err.message });
            await sendTelegram(adminToken, adminId2,
              `⚠️ MobCash échoué (support) — #${ordreId}\n<code>${err.message}</code>`);
          }
          return;
        }

        // ── Crédité mais client réclame → alerte admin ──
        if (o.status === "Crédité avec succès") {
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
        if (o.status === "Paiement Non Reçu") {
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
        await sendTelegram(token, adminId, `👤 <b>Ordres ${phone} (${snap.size})</b>\n\n${lignes.join("\n")}`);
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
