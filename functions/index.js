/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  KAFFI PAY — CLOUD FUNCTIONS v5.1                                    ║
 * ║                                                                      ║
 * ║  FLOW CORRECT :                                                      ║
 * ║  1. User paie Waafi → SMS → waafi_notifications (STATUS: prêt)       ║
 * ║  2. User soumet ordre avec Transfer ID                               ║
 * ║  3. onNouvelOrdre cherche la notif correspondante → confirme         ║
 * ║                                                                      ║
 * ║  autoConfirmation = parse SMS + alerte admin + cas rare (délai SMS)  ║
 * ║  onNouvelOrdre    = moteur principal de confirmation dépôt           ║
 * ║  onWebhookEchoue  = retry webhook temps réel (0s / 30s / 90s)       ║
 * ║                                                                      ║
 * ║  Fonctions (13) :                                                    ║
 * ║  [Triggers]  onNouvelOrdre · onOrdreUpdated · autoConfirmation       ║
 * ║              onWebhookEchoue                                         ║
 * ║  [Scheduled] rapportJournalier · ordresBloqués · nettoyageCompteurs  ║
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
const TZ     = "Africa/Djibouti";

const TELEGRAM_TOKEN    = defineSecret("TELEGRAM_TOKEN");
const TELEGRAM_ADMIN_ID = defineSecret("TELEGRAM_ADMIN_CHAT_ID");
const MACRO_WEBHOOK_URL = defineSecret("MACRODROID_WEBHOOK_URL");
const MACRO_SECRET      = defineSecret("MACRODROID_SECRET");
const SUPPORT_BOT_TOKEN = defineSecret("SUPPORT_BOT_TOKEN");

// ══════════════════════════════════════════════════════════════════
// SECTION 1 — STATE MACHINE
// ══════════════════════════════════════════════════════════════════
const TRANSITIONS_VALIDES = {
  "En attente":  ["Confirmé", "Rejeté", "Argent Reçu", "Correction"],
  "Argent Reçu": ["Confirmé", "Rejeté"],
  "Correction":  ["Confirmé", "Rejeté", "En attente"],
  "Confirmé":    [],
  "Rejeté":      [],
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
// SECTION 5 — CIRCUIT BREAKER MacroDroid
// ══════════════════════════════════════════════════════════════════
const CB_SEUIL   = 3;
const CB_TIMEOUT = 5 * 60 * 1000;

async function appelWebhook(url, ordreRef, montant, id1xbet) {
  const cbRef  = db.collection("circuit_breakers").doc("macrodroid");
  const cbSnap = await cbRef.get();
  const cb     = cbSnap.exists ? cbSnap.data() : { etat: "closed", echecs: 0 };

  if (cb.etat === "open") {
    const tempsRestant = (cb.ouvertA || 0) + CB_TIMEOUT - Date.now();
    if (tempsRestant > 0)
      throw new Error(`Circuit breaker OPEN — réessai dans ${Math.ceil(tempsRestant / 60000)} min`);
    await cbRef.update({ etat: "half-open" });
  }

  try {
    const webhookUrl = `${url}?id1xbet=${encodeURIComponent(id1xbet)}&montant=${encodeURIComponent(montant)}&ref=${encodeURIComponent(ordreRef)}`;
    const resp       = await fetch(webhookUrl, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await cbRef.set({ etat: "closed", echecs: 0, dernierSucces: Date.now() });
    return resp;
  } catch (e) {
    const echecs = (cb.echecs || 0) + 1;
    if (echecs >= CB_SEUIL)
      await cbRef.set({ etat: "open", echecs, ouvertA: Date.now(), dernierEchec: e.message });
    else
      await cbRef.set({ etat: "closed", echecs, dernierEchec: e.message }, { merge: true });
    throw e;
  }
}

async function sauvegarderWebhookEchoue(ordreRef, id1xbet, montant) {
  await db.collection("failed_webhooks").doc(ordreRef).set({
    ordreRef, id1xbet, montant,
    tentatives: 0, maxTentatives: 3, statut: "en_attente",
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
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
// Appelé par onNouvelOrdre (flux principal) et autoConfirmation (cas rare)
// waafiDoc = document waafi_notifications correspondant
// ordreDoc = document orders à confirmer
// ══════════════════════════════════════════════════════════════════
async function confirmerDepot(ordreDoc, waafiDoc, webhookBase, token, adminId) {
  const ordre        = ordreDoc.data();
  const notif        = waafiDoc.data();
  const ordreRef     = ordre.orderId || ordre.ref || ordreDoc.id;
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
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ordreDoc.ref);
    if (!snap.exists || snap.data().status !== "En attente") return false;
    tx.update(ordreDoc.ref, {
      status: "Confirmé",
      confirmedBy: "auto_match_waafi",
      montantRecu: montantNotif,
      expediteurRecu: numReel,
      correctionApplied: corrections.length > 0,
      corrections,
      confirmedAt: FieldValue.serverTimestamp(),
    });
    tx.update(waafiDoc.ref, { status: "matché", ordreRef });
    return true;
  });

  if (!claimed) {
    await waafiDoc.ref.update({ status: "déjà_traité", ordreRef });
    return false;
  }

  logAudit("depot_confirme_match", { ordreRef, transferId: notif.transferId, montant: montantNotif });

  await sendTelegram(token, adminId,
    `✅ <b>Dépôt confirmé automatiquement</b>${corrections.length ? " ✏️" : ""}\n\n` +
    `Réf: <b>#${ordreRef}</b> | <b>${Number(montantNotif).toLocaleString()} DJF</b>\n` +
    `Transfer-ID: <code>${notif.transferId || "?"}</code> | N°: <code>${numReel}</code>` +
    (corrections.length ? `\n✏️ <i>${corrections.join(" | ")}</i>` : "")
  );

  // Appel webhook MacroDroid (crédit 1xBet)
  const id1xbet = ordre.userId1xBet || ordre.id1x || "";
  if (id1xbet) {
    try {
      await appelWebhook(webhookBase, ordreRef, montantNotif, id1xbet);
      await ordreDoc.ref.update({ webhookStatus: "ok", webhookAt: FieldValue.serverTimestamp() });
    } catch (e) {
      await ordreDoc.ref.update({ webhookStatus: "echec", webhookError: e.message });
      await sauvegarderWebhookEchoue(ordreRef, id1xbet, montantNotif);
      // onWebhookEchoue va retenter immédiatement (0s / 30s / 90s)
    }
  } else {
    await sendTelegram(token, adminId,
      `⚠️ <b>ID 1xBet manquant</b> — #${ordreRef}\n${Number(montantNotif).toLocaleString()} DJF confirmé. Recharge manuelle.`
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
// ══════════════════════════════════════════════════════════════════
function repondreSupport(text, session, orders) {
  const t = text.toLowerCase().trim();

  const ordreMatch    = text.match(/(?:#\s*|n[°o]\.?\s*)?(\d{6,8})\b/i);
  const ordreNum      = ordreMatch ? ordreMatch[1] : null;
  const hasTransferId = /transfer[- ]?id|tid\b/i.test(t) || /\b\d{9,}\b/.test(text);
  const isGreeting    = /^(bonjour|salut|bonsoir|hello|salam|hi|allo|allô|bjr|bj)\b/.test(t);

  if (/comment.*(fonc|march|utilis|process)|étape|procédure|comment faire/.test(t)) {
    return reply(
      "ℹ️ <b>Comment fonctionne Kaffi-Pay ?</b>\n\n" +
      "1. Soumettez votre ordre sur <b>kaffi-pay.com</b>\n" +
      "2. Effectuez le paiement Waafi avec le <b>Transfer ID</b> fourni\n" +
      "3. Votre compte 1xBet est crédité <b>automatiquement</b>\n\n" +
      "Pour suivre un ordre, envoyez votre <b>numéro d'ordre</b>.",
      "résolu", "FAQ fonctionnement", "faible", "FAQ comment ça marche"
    );
  }

  if (/(?:combien.*temps|délai|durée|quand.*confirm|temps.*traitement)/.test(t)) {
    return reply(
      "⏱️ <b>Délais de traitement</b>\n\n" +
      "• Confirmation automatique : <b>immédiat</b>\n" +
      "• Vérification manuelle si besoin : <b>moins de 30 minutes</b>\n\n" +
      "Kaffi-Pay est disponible <b>24h/24 — 7j/7</b>.",
      "résolu", "FAQ délais", "faible", "FAQ délais"
    );
  }

  if (/\b(frais|commission|taux|prix|coût)\b/.test(t)) {
    return reply(
      "💰 Les frais sont affichés sur <b>kaffi-pay.com</b> avant de soumettre votre ordre.",
      "résolu", "FAQ frais", "faible", "FAQ frais"
    );
  }

  if (/\b(annul|cancel|retrait|rembours)\b/.test(t)) {
    return reply(
      "ℹ️ Pour une demande d'annulation ou de remboursement, envoyez votre <b>numéro d'ordre</b> et votre <b>Transfer ID</b>.",
      "escalade", "Demande annulation", "moyen", "Demande annulation/remboursement"
    );
  }

  if (hasTransferId && (orders.length > 0 || session.phone)) {
    return reply(
      "Merci pour ces informations. Votre demande a été transmise à notre équipe pour vérification.\n\nNous vous répondrons dans les plus brefs délais.",
      "escalade", "Transfer ID reçu — escalade admin", "moyen",
      "Client a fourni infos paiement — vérification requise"
    );
  }

  if (ordreNum) {
    if (!session.phone) {
      return reply(
        `Pour vérifier l'ordre <b>#${ordreNum}</b>, merci d'indiquer votre <b>numéro Waafi</b> (ex: <code>77123456</code>).`,
        "info_manquante", "Numéro Waafi requis", "faible", `Ordre #${ordreNum} sans numéro`
      );
    }
    const ligne = orders.find((o) => o.includes(`#${ordreNum}`));
    if (!ligne) {
      return reply(
        `L'ordre <b>#${ordreNum}</b> est introuvable pour votre numéro.\n\nVérifiez le numéro d'ordre (6 à 8 chiffres).`,
        "info_manquante", "Ordre introuvable", "faible", `Ordre #${ordreNum} introuvable`
      );
    }
    if (ligne.includes("| Confirmé"))
      return reply(`✅ Votre ordre <b>#${ordreNum}</b> est <b>confirmé</b>. Votre compte 1xBet a bien été crédité.`,
        "résolu", "Confirmé communiqué", "faible", `#${ordreNum} confirmé`);
    if (ligne.includes("| Argent Reçu"))
      return reply(`💳 Ordre <b>#${ordreNum}</b> : paiement <b>reçu</b>, crédit 1xBet en cours.`,
        "résolu", "Argent Reçu communiqué", "faible", `#${ordreNum} argent reçu`);
    if (ligne.includes("| En attente"))
      return reply(`⏳ Votre ordre <b>#${ordreNum}</b> est <b>en cours de traitement</b>. Vous serez notifié dès confirmation.`,
        "résolu", "En attente communiqué", "faible", `#${ordreNum} en attente`);
    if (ligne.includes("| Correction"))
      return reply(
        `✏️ Votre ordre <b>#${ordreNum}</b> a été retourné en <b>correction</b>.\n\n` +
        "Il y a une discordance entre les informations soumises et votre paiement Waafi.\n\n" +
        "Veuillez vérifier votre <b>Transfer ID</b>, <b>montant</b> et <b>numéro Waafi</b>, puis <b>resoumettre un nouvel ordre</b>.",
        "info_manquante", "Correction — client invité à resoumettre", "moyen", `#${ordreNum} en correction`
      );
    if (ligne.includes("| Rejeté")) {
      const nonRecu = ligne.toLowerCase().includes("paiement non re") || ligne.toLowerCase().includes("introuvable");
      const fraude  = ligne.toLowerCase().includes("fraude");
      if (fraude)
        return reply(
          "❌ Votre ordre a été rejeté pour raison de sécurité.\n\nSi vous pensez qu'il s'agit d'une erreur, envoyez votre Transfer ID Waafi.",
          "fraude_signalée", "Fraude — réponse prudente", "élevé", `#${ordreNum} fraude`
        );
      if (nonRecu)
        return reply(
          `❌ Ordre <b>#${ordreNum}</b> rejeté : <b>Paiement non reçu</b>.\n\n` +
          "<b>Causes possibles :</b>\n• Transfer ID incorrect\n• Montant ou numéro expéditeur différent\n\n" +
          "Pour correction :\n📌 <b>Transfer ID Waafi</b> — <b>Montant payé</b> — <b>N° expéditeur</b>",
          "info_manquante", "Rejeté non reçu", "moyen", `#${ordreNum} rejeté non reçu`
        );
      return reply(
        `❌ Ordre <b>#${ordreNum}</b> <b>rejeté</b>. Envoyez votre Transfer ID Waafi pour vérification.`,
        "info_manquante", "Rejeté — TID demandé", "moyen", `#${ordreNum} rejeté`
      );
    }
  }

  if (isGreeting) {
    const suite = session.phone
      ? "Que puis-je faire pour vous ?\n\nIndiquez votre <b>numéro d'ordre</b> pour le suivi."
      : "Pour vous aider, indiquez votre <b>numéro d'ordre</b> (ex : <code>2606061</code>).";
    return reply(`Bonjour ! Je suis le support Kaffi-Pay.\n\n${suite}`, "info_manquante", "Salutation", "faible", "Salutation");
  }

  return reply(
    "Bonjour ! Pour vous aider, indiquez votre <b>numéro d'ordre</b> (ex : <code>2606061</code>).",
    "info_manquante", "Message non reconnu", "faible", "Fallback"
  );
}

function reply(reponse_client, decision, action_prise, niveau_urgence, resume_audit) {
  return { reponse_client: reponse_client + "\n\n— <i>Support Kaffi-Pay</i>", decision, action_prise, niveau_urgence, resume_audit };
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
    return `⏳ <b>À traiter (${aTraiter.length})</b>\n\n${aTraiter.join("\n")}\n\n<i>confirmer #ID | rejeter #ID raison</i>`;
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
    "🤖 <b>Commandes</b>\n\n" +
    "📊 <code>stats</code>  ⏳ <code>ordres</code>  🚨 <code>fraudes</code>\n" +
    "❌ <code>rejetés</code>  📩 <code>sms</code>  🔍 <code>#2606061</code>\n" +
    "👤 <code>client 77123456</code>  ⚠️ <code>alerte</code>\n" +
    "📭 <code>nonmatche</code>  🔄 <code>circuit</code>\n" +
    "✅ <code>confirmer 2606061</code>\n" +
    "❌ <code>rejeter 2606061 raison</code>"
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
    secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, MACRO_WEBHOOK_URL, MACRO_SECRET],
    timeoutSeconds: 60,
  },
  async (event) => {
    const tx         = event.data.data();
    const docId      = event.params.docId;
    const ref        = tx.orderId || tx.ref || docId;
    const transferId = (tx.waafitranfertID || tx.hash || "").trim();
    const isDepot    = tx.type === "Dépôt";
    const phone      = (tx.numeroPayment || tx.waafiNumber || "").trim();
    const token      = TELEGRAM_TOKEN.value();
    const adminId    = TELEGRAM_ADMIN_ID.value();

    logAudit("nouvel_ordre", { ref, type: tx.type, montant: tx.montant, phone });

    // ── FRAUDE 1 : Transfer ID déjà utilisé pour un autre ordre ─
    // Vérifie 3 sources : ordre confirmé, notif matchée, notif traitée.
    // Si trouvé → tentative de réutilisation d'un paiement = FRAUDE.
    if (transferId) {
      const [confirmeSnap, matcheSnap, traiteSnap] = await Promise.all([
        db.collection("orders")
          .where("waafitranfertID", "==", transferId)
          .where("status", "==", "Confirmé").limit(1).get(),
        db.collection("waafi_notifications")
          .where("transferId", "==", transferId)
          .where("status", "==", "matché").limit(1).get(),
        db.collection("waafi_notifications")
          .where("transferId", "==", transferId)
          .where("status", "==", "traité").limit(1).get(),
      ]);

      const srcConfirme = confirmeSnap.docs[0];
      const srcMatch    = matcheSnap.docs[0] || traiteSnap.docs[0];

      if (srcConfirme || srcMatch) {
        // Récupérer la référence de l'ordre d'origine
        let ancienRef = "inconnu";
        if (srcConfirme) {
          ancienRef = srcConfirme.data().orderId || srcConfirme.id;
        } else if (srcMatch) {
          ancienRef = srcMatch.data().ordreRef || srcMatch.data().orderId || srcMatch.id;
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
          `Nouvel ordre : <code>#${ref}</code>\n` +
          `Transfer-ID : <code>${transferId}</code>\n` +
          `Ce TID a déjà été utilisé pour l'ordre <code>#${ancienRef}</code>.\n\n` +
          `⛔ Ordre <b>rejeté automatiquement</b>.`
        );

        logAudit("fraude_tid_reutilise", { ref, transferId, ancienRef, phone });
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
          `⚠️ <b>Rate limit</b>\nN°: <code>${phone}</code> | ${tx.type}\nOrdre <code>#${ref}</code> rejeté.`
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
        `⚠️ <b>Possible doublon</b>\nOrdre <code>#${ref}</code> ≈ <code>#${doublon.ordreId}</code>\n` +
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
          flagRaison: "Transfer ID manquant — paiement Waafi introuvable",
          flaggedAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(token, adminId,
          `❌ <b>Dépôt rejeté — Transfer ID manquant</b>\nRéf: <code>#${ref}</code>`
        );
        return;
      }

      const webhookBase = MACRO_WEBHOOK_URL.value() ||
        "https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet";

      // Recherche 1 : par Transfer ID exact dans les notifs prêtes
      let waafiDoc = null;
      const byTID = await db.collection("waafi_notifications")
        .where("transferId", "==", transferId)
        .where("status", "in", ["prêt", "nouveau"])
        .limit(1).get();

      if (!byTID.empty) {
        waafiDoc = byTID.docs[0];
      }

      // Recherche 2 (fallback) : par numéro + montant ±5% si TID pas encore parsé
      if (!waafiDoc && phone) {
        const montantOrdre = Number(tx.montant || 0);
        const tolerance    = Math.max(5, montantOrdre * 0.05);
        const byPhone = await db.collection("waafi_notifications")
          .where("numClient", "==", phone)
          .where("status", "in", ["prêt", "nouveau"])
          .limit(10).get();

        for (const d of byPhone.docs) {
          const n = d.data();
          if (n.montant && Math.abs(montantOrdre - n.montant) <= tolerance) {
            waafiDoc = d; break;
          }
        }
      }

      if (waafiDoc) {
        // Notation trouvée → vérifier les 3 critères
        const ordreSnap  = await db.collection("orders").doc(docId).get();
        const { score, mismatches, decision } = scorerCorrespondance(tx, waafiDoc.data());

        if (decision === "confirmer") {
          // 3/3 — confirmation automatique
          await confirmerDepot(ordreSnap, waafiDoc, webhookBase, token, adminId);
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
          await waafiDoc.ref.update({ status: "correction_requise", ordreRef: ref });
          await sendTelegram(token, adminId,
            `✏️ <b>Correspondance partielle (${score}/3) — Correction requise</b>\n\n` +
            `Ordre <code>#${ref}</code> | ${Number(tx.montant || 0).toLocaleString()} DJF\n\n` +
            `${msgDetails}\n\n` +
            `<i>Le client doit corriger et resoumettre l'ordre.</i>\n` +
            `Forcer si OK : <code>confirmer ${ref}</code>`
          );
          logAudit("depot_correction_partielle", { ref, score, mismatches });
          return;
        }

        // score ≤ 1 — données trop éloignées → rejet même si notif trouvée
        const msgDetails = mismatches.map((m) => `• ${m}`).join("\n");
        await db.collection("orders").doc(docId).update({
          status: "Rejeté",
          flagRaison: `Données incorrectes (${score}/3) — ${mismatches.join(", ")}`,
          flaggedAt: FieldValue.serverTimestamp(),
        });
        await waafiDoc.ref.update({ status: "rejeté_mauvaise_correspondance", ordreRef: ref });
        await sendTelegram(token, adminId,
          `❌ <b>Dépôt rejeté — Correspondance insuffisante (${score}/3)</b>\n\n` +
          `Ordre <code>#${ref}</code>\n${msgDetails}`
        );
        logAudit("depot_rejete_mauvaise_correspondance", { ref, score, mismatches });
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
        `Réf: <code>#${ref}</code>\n` +
        `Transfer-ID: <code>${transferId}</code>\n` +
        `Montant: ${Number(tx.montant || 0).toLocaleString()} DJF\n\n` +
        `<i>Aucune notification Waafi correspondante trouvée.</i>`
      );
      logAudit("depot_rejete_tId_introuvable", { ref, transferId });
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
        `Réf: <code>#${ref}</code> | ${fraud.raisons.join(", ")}`
      );
      logAudit("ordre_rejete_fraude", { ref, score: fraud.score_fraude });
      return;
    }

    await sendTelegram(token, adminId,
      `📤 <b>Nouveau Retrait</b>\n` +
      `Réf: <b>#${ref}</b> | <b>${Number(tx.montant).toLocaleString()} DJF</b>\n` +
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
  { document: "orders/{docId}", region: REGION, secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID] },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;

    if (!transitionValide(before.status, after.status)) {
      console.warn(`Transition invalide ignorée: ${before.status} → ${after.status}`);
      return;
    }

    const ref     = after.orderId || after.ref || event.params.docId;
    const montant = Number(after.montant || 0).toLocaleString();
    const type    = after.type || "Ordre";

    logAudit("transition_statut", { ref, de: before.status, vers: after.status, par: after.confirmedBy || "?" });

    let msg = "";
    if (after.status === "Confirmé")
      msg = `✅ <b>${type} confirmé</b>\n#${ref} — ${montant} DJF\n` +
            (after.confirmedBy === "admin_telegram" ? "👤 Via bot admin"
              : after.confirmedBy?.startsWith("auto") ? "🤖 Automatique" : "👤 Manuel");
    else if (after.status === "Rejeté")
      msg = `❌ <b>${type} rejeté</b>\n#${ref} — ${after.flagRaison || "Raison inconnue"}`;
    else if (after.status === "Argent Reçu")
      msg = `💳 <b>Paiement Waafi reçu</b>\n#${ref} — ${montant} DJF\nCrédit 1xBet en cours…`;
    else if (after.status === "Correction")
      msg = `✏️ <b>Correction demandée</b>\n#${ref}\n${after.correctionMsg || ""}`;

    if (msg) await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(), msg);
  }
);

// ══════════════════════════════════════════════════════════════════
// TRIGGER 3 — NOTIFICATION WAAFI REÇUE
//
//  RÔLE PRINCIPAL : parser le SMS + alerter admin + stocker "prêt"
//  RÔLE SECONDAIRE (cas rare) : si un ordre En attente existe déjà
//    avec ce Transfer ID (délai SMS ou ordre soumis avant paiement)
//    → confirmer directement
//
//  Le flux normal : autoConfirmation stocke "prêt",
//  puis onNouvelOrdre vient chercher la notif quand l'ordre arrive.
// ══════════════════════════════════════════════════════════════════
exports.autoConfirmation = onDocumentCreated(
  {
    document: "waafi_notifications/{docId}", region: REGION,
    secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, MACRO_WEBHOOK_URL, MACRO_SECRET],
    timeoutSeconds: 60,
  },
  async (event) => {
    const sms   = event.data.data();
    const docId = event.params.docId;
    const token  = TELEGRAM_TOKEN.value();
    const adminId = TELEGRAM_ADMIN_ID.value();

    if (sms.status === "traité" || sms.status === "en_cours" || sms.status === "prêt") return;

    const expectedSecret = MACRO_SECRET.value() || "KaffiPay2026";
    if (sms.secret && sms.secret !== expectedSecret) {
      await db.collection("waafi_notifications").doc(docId).update({ status: "rejeté_secret_invalide" });
      return;
    }

    // Extraire les données du SMS
    const notification = sms.notification || sms.not_body || sms.message || sms.texte || sms.body || "";
    const transferId   = sms.transferId   || extractTransferId(notification);
    const montantSMS   = sms.montant      || extractMontant(notification);
    const numClient    = sms.numClient    || extractNumClient(notification);

    if (!transferId && !montantSMS) {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "erreur_parsing", erreurMsg: "Impossible d'extraire Transfer ID ou Montant",
      });
      return;
    }

    // Stocker les champs parsés, status = "prêt" → onNouvelOrdre viendra matcher
    await db.collection("waafi_notifications").doc(docId).update({
      status: "prêt", transferId, montant: montantSMS, numClient,
      processedAt: FieldValue.serverTimestamp(),
    });

    await sendTelegram(token, adminId,
      `💰 <b>Paiement Waafi reçu</b>\n` +
      `Transfer-ID: <code>${transferId || "?"}</code>\n` +
      `Montant: <b>${montantSMS ? Number(montantSMS).toLocaleString() : "?"} DJF</b>\n` +
      `Expéditeur: <code>${numClient || "?"}</code>\n` +
      `<i>En attente de la soumission de l'ordre par le client.</i>`
    );

    // ── CAS RARE : ordre déjà soumis avant que le SMS arrive ────
    // (ex: délai SMS, ou client soumet très vite après paiement)
    // onNouvelOrdre n'a pas trouvé la notif → ordre toujours En attente
    if (!transferId) return; // pas de TID, impossible de matcher avec certitude

    const ordreSnap = await db.collection("orders")
      .where("waafitranfertID", "==", transferId)
      .where("status", "==", "En attente")
      .limit(1).get();

    if (ordreSnap.empty) return; // cas normal — ordre pas encore soumis

    // Ordre trouvé → confirmer maintenant (cas rare mais géré)
    const ordreDoc    = ordreSnap.docs[0];
    const waafiDocRef = db.collection("waafi_notifications").doc(docId);
    const waafiSnap   = await waafiDocRef.get();

    const webhookBase = MACRO_WEBHOOK_URL.value() ||
      "https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet";

    // Même règle de scoring pour le cas rare
    const { score, mismatches, decision } = scorerCorrespondance(ordreDoc.data(), waafiSnap.data());
    const ordreRef2 = ordreDoc.data().orderId || ordreDoc.id;

    if (decision === "confirmer") {
      await confirmerDepot(ordreDoc, waafiSnap, webhookBase, token, adminId);
    } else if (decision === "correction") {
      const msgDetails = mismatches.map((m) => `• ${m}`).join("\n");
      await ordreDoc.ref.update({
        status: "Correction",
        correctionMsg: `Correspondance partielle (${score}/3) — corrigez et resoumettez.\n${mismatches.join(" | ")}`,
        correctionDetails: mismatches, correctionScore: score,
        correctionAt: FieldValue.serverTimestamp(),
      });
      await waafiDocRef.update({ status: "correction_requise", ordreRef: ordreRef2 });
      await sendTelegram(token, adminId,
        `✏️ <b>Correction requise (${score}/3)</b>\n\nOrdre <code>#${ordreRef2}</code>\n${msgDetails}\n\n` +
        `<i>Le client doit corriger et resoumettre.</i>`
      );
    } else {
      const msgDetails = mismatches.map((m) => `• ${m}`).join("\n");
      await ordreDoc.ref.update({
        status: "Rejeté",
        flagRaison: `Données incorrectes (${score}/3) — ${mismatches.join(", ")}`,
        flaggedAt: FieldValue.serverTimestamp(),
      });
      await waafiDocRef.update({ status: "rejeté_mauvaise_correspondance", ordreRef: ordreRef2 });
      await sendTelegram(token, adminId,
        `❌ <b>Correspondance insuffisante (${score}/3)</b>\nOrdre <code>#${ordreRef2}</code>\n${msgDetails}`
      );
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// TRIGGER 4 — WEBHOOK ÉCHOUÉ : RETRY TEMPS RÉEL
// Déclenché IMMÉDIATEMENT sur création failed_webhooks
// 3 tentatives : 0 s → 30 s → 90 s dans une seule exécution
// ══════════════════════════════════════════════════════════════════
exports.onWebhookEchoue = onDocumentCreated(
  {
    document: "failed_webhooks/{docId}", region: REGION,
    secrets: [MACRO_WEBHOOK_URL, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID],
    timeoutSeconds: 300,
  },
  async (event) => {
    const docId = event.params.docId;
    const w     = event.data.data();
    const token  = TELEGRAM_TOKEN.value();
    const adminId = TELEGRAM_ADMIN_ID.value();

    const webhookBase = MACRO_WEBHOOK_URL.value() ||
      "https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet";

    // Délais : immédiat, puis 30 s, puis 90 s
    const delais = [0, 30000, 90000];

    for (let i = 0; i < delais.length; i++) {
      if (delais[i] > 0) await new Promise((r) => setTimeout(r, delais[i]));
      const tentative = i + 1;

      try {
        await appelWebhook(webhookBase, w.ordreRef, w.montant, w.id1xbet);

        await db.collection("failed_webhooks").doc(docId).update({
          statut: "succès", tentatives: tentative, resolvedAt: FieldValue.serverTimestamp(),
        });
        const s = await db.collection("orders").where("orderId", "==", w.ordreRef).limit(1).get();
        if (!s.empty) await s.docs[0].ref.update({ webhookStatus: "ok_retry_rt" });

        await sendTelegram(token, adminId,
          `✅ <b>Webhook récupéré (${tentative}/3)</b>\n` +
          `Ordre <code>#${w.ordreRef}</code> | ID 1xBet: <code>${w.id1xbet}</code>`
        );
        logAudit("webhook_retry_succes_rt", { ordreRef: w.ordreRef, tentative });
        return;

      } catch (e) {
        await db.collection("failed_webhooks").doc(docId).update({
          tentatives: tentative, dernierEchec: e.message,
        });
        if (tentative === delais.length) {
          await db.collection("failed_webhooks").doc(docId).update({ statut: "abandonné" });
          await sendTelegram(token, adminId,
            `🔴 <b>Webhook abandonné — 3 tentatives échouées</b>\n\n` +
            `Ordre <code>#${w.ordreRef}</code> | ID 1xBet: <code>${w.id1xbet}</code>\n` +
            `<b>⚠️ Recharge manuelle REQUISE.</b>`
          );
          logAudit("webhook_abandonne_rt", { ordreRef: w.ordreRef, erreur: e.message });
        }
      }
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// SCHEDULED 1 — RAPPORT JOURNALIER (08:00 Africa/Djibouti)
// ══════════════════════════════════════════════════════════════════
exports.rapportJournalier = onSchedule(
  { schedule: "0 8 * * *", timeZone: TZ, region: REGION, secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID] },
  async () => {
    const hier  = new Date(); hier.setDate(hier.getDate() - 1);
    const debut = new Date(hier); debut.setHours(0, 0, 0, 0);
    const fin   = new Date(hier); fin.setHours(23, 59, 59, 999);

    const snap = await db.collection("orders")
      .where("ts", ">=", debut.getTime()).where("ts", "<=", fin.getTime())
      .get().catch(() => db.collection("orders").get());

    const ordres    = snap.docs.map((d) => d.data());
    const depots    = ordres.filter((o) => o.type === "Dépôt");
    const retraits  = ordres.filter((o) => o.type === "Retrait");
    const confirmes = ordres.filter((o) => o.status === "Confirmé");
    const rejetes   = ordres.filter((o) => o.status === "Rejeté");
    const fraudes   = ordres.filter((o) => o.flagRaison?.toUpperCase().includes("FRAUDE"));
    const volume    = depots.filter((o) => o.status === "Confirmé").reduce((s, o) => s + Number(o.montant || 0), 0);
    const taux      = ordres.length ? Math.round(confirmes.length / ordres.length * 100) : 0;

    const dateStr = hier.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

    await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
      `📅 <b>Rapport ${dateStr}</b>\n\n` +
      `📥 Dépôts: <b>${depots.length}</b>  📤 Retraits: <b>${retraits.length}</b>\n` +
      `✅ Confirmés: <b>${confirmes.length}</b>  ❌ Rejetés: <b>${rejetes.length}</b>\n` +
      `🚨 Fraudes: <b>${fraudes.length}</b>  📈 Taux: <b>${taux}%</b>\n` +
      `💰 Volume: <b>${volume.toLocaleString()} DJF</b>\n\n` +
      (rejetes.length > confirmes.length ? "⚠️ Plus de rejets que de confirmations." :
       fraudes.length > 2 ? "🚨 Activité frauduleuse élevée." : "✅ Journée normale.")
    );

    const yy = String(hier.getFullYear()).slice(-2);
    const mm = String(hier.getMonth() + 1).padStart(2, "0");
    const dd = String(hier.getDate()).padStart(2, "0");
    await db.collection("daily_stats").doc(`${yy}${mm}${dd}`).set({
      date: dateStr, depots: depots.length, retraits: retraits.length,
      confirmes: confirmes.length, rejetes: rejetes.length,
      fraudes: fraudes.length, volume, taux,
      computedAt: FieldValue.serverTimestamp(),
    });
  }
);

// ══════════════════════════════════════════════════════════════════
// SCHEDULED 2 — ORDRES BLOQUÉS (toutes les 5 min)
// Seul cas time-based : détecter le temps écoulé depuis création
// ══════════════════════════════════════════════════════════════════
exports.ordresBloques = onSchedule(
  { schedule: "every 5 minutes", region: REGION, secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID] },
  async () => {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);

    const snap = await db.collection("orders")
      .where("status", "==", "En attente").orderBy("ts", "asc")
      .get().catch(() => db.collection("orders").where("status", "==", "En attente").get());

    const bloqués = snap.docs.filter((d) => {
      const ts = d.data().ts;
      return ts && new Date(ts) < cutoff;
    });

    if (!bloqués.length) return;

    const alertRef  = db.collection("alertes_etat").doc("ordres_bloques");
    const alertSnap = await alertRef.get();
    if (alertSnap.exists) {
      const last = alertSnap.data().ts?.toDate?.() || new Date(0);
      if (Date.now() - last.getTime() < 30 * 60 * 1000) return;
    }

    const lignes = bloqués.map((d) => {
      const o   = d.data();
      const age = Math.round((Date.now() - o.ts) / 60000);
      return `• #${o.orderId || d.id} | ${o.montant} DJF | ⏱ ${age}min | N°${o.numeroPayment || "?"}`;
    });

    await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
      `⚠️ <b>${bloqués.length} ordre(s) en attente > 30 min</b>\n\n${lignes.join("\n")}\n\n` +
      "<i>confirmer #ID | rejeter #ID raison</i>"
    );

    await alertRef.set({ ts: FieldValue.serverTimestamp(), count: bloqués.length });
  }
);

// ══════════════════════════════════════════════════════════════════
// SCHEDULED 3 — NETTOYAGE (minuit)
// ══════════════════════════════════════════════════════════════════
exports.nettoyageCompteurs = onSchedule(
  { schedule: "0 0 * * *", timeZone: TZ, region: REGION },
  async () => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    const yy = String(cutoff.getFullYear()).slice(-2);
    const mm = String(cutoff.getMonth() + 1).padStart(2, "0");
    const dd = String(cutoff.getDate()).padStart(2, "0");

    const snap = await db.collection("counters")
      .where("__name__", "<=", `daily_${yy}${mm}${dd}`).get().catch(() => ({ docs: [] }));
    if (snap.docs.length > 0) {
      const b = db.batch(); snap.docs.forEach((d) => b.delete(d.ref)); await b.commit();
    }

    const rlSnap = await db.collection("rate_limits")
      .where("expiresAt", "<", Date.now()).limit(100).get().catch(() => ({ docs: [] }));
    if (rlSnap.docs.length > 0) {
      const b = db.batch(); rlSnap.docs.forEach((d) => b.delete(d.ref)); await b.commit();
    }

    const auditSnap = await db.collection("audit_logs")
      .where("ts", "<", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
      .limit(100).get().catch(() => ({ docs: [] }));
    if (auditSnap.docs.length > 0) {
      const b = db.batch(); auditSnap.docs.forEach((d) => b.delete(d.ref)); await b.commit();
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — WEBHOOK MACRODROID (réception SMS Waafi)
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
      secret: expectedSecret, source: "macrodroid", status: "nouveau",
      createdAt: FieldValue.serverTimestamp(),
    });

    // autoConfirmation va parser et stocker status="prêt" immédiatement
    res.json({ success: true, id: docRef.id });
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

    let cb = "non testé";
    try {
      const cbSnap = await db.collection("circuit_breakers").doc("macrodroid").get();
      cb = cbSnap.exists ? cbSnap.data().etat : "closed (jamais utilisé)";
    } catch { /* ignore */ }

    let webhooksAttente = 0;
    try {
      const wSnap = await db.collection("failed_webhooks").where("statut", "==", "en_attente").limit(1).get();
      webhooksAttente = wSnap.size;
    } catch { /* ignore */ }

    res.json({
      statut, timestamp: new Date().toISOString(), region: REGION,
      firestore: firestoreMs, version: "5.1",
      flow: "waafi_notification_first → ordre_second",
      circuit_breaker: cb, webhooks_en_attente: webhooksAttente,
    });
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — SUPPORT CLIENT
// ══════════════════════════════════════════════════════════════════
exports.supportClient = onRequest(
  { region: REGION, secrets: [SUPPORT_BOT_TOKEN, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID], timeoutSeconds: 60 },
  async (req, res) => {
    res.status(200).send("OK");
    try {
      const msg = (req.body || {}).message || (req.body || {}).edited_message;
      if (!msg) return;

      const chatId    = msg.chat.id;
      const text      = (msg.text || "").trim();
      const firstName = (msg.from || {}).first_name || "Client";
      if (!text) return;

      const supportToken = SUPPORT_BOT_TOKEN.value();
      if (!supportToken) return;

      const sessionRef  = db.collection("support_sessions").doc(String(chatId));
      const sessionSnap = await sessionRef.get();
      const session     = sessionSnap.exists ? sessionSnap.data() : {};

      const cleanText = text.replace(/\s/g, "");
      const isPhone   = /^(77|78|70|71|21)\d{6}$/.test(cleanText);
      if (isPhone && !session.phone) {
        await sessionRef.set({ phone: cleanText, chatId, startedAt: FieldValue.serverTimestamp() }, { merge: true });
        session.phone = cleanText;
      }

      const ordreInMsg = (text.match(/(?:#\s*)?(\d{6,8})\b/i) || [])[1] || null;
      if (ordreInMsg) await sessionRef.set({ lastOrder: ordreInMsg }, { merge: true });

      let orders = [];
      if (session.phone) {
        try {
          const snap = await db.collection("orders")
            .where("numeroPayment", "==", session.phone).orderBy("ts", "desc").limit(10).get();
          orders = snap.docs.map((d) => {
            const o = d.data();
            return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status} | ${o.flagRaison || ""}`;
          });
        } catch {
          const snap = await db.collection("orders").where("numeroPayment", "==", session.phone).limit(10).get().catch(() => ({ docs: [] }));
          orders = snap.docs.map((d) => { const o = d.data(); return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status}`; });
        }
      }

      if (ordreInMsg && !session.phone && orders.length === 0) {
        const snap = await db.collection("orders").where("orderId", "==", ordreInMsg).limit(1).get().catch(() => ({ docs: [] }));
        if (snap.docs.length) {
          const o = snap.docs[0].data();
          orders = [`• #${o.orderId || snap.docs[0].id} | ${o.type} | ${o.montant} DJF | ${o.status}`];
        }
      }

      const aiDecision = repondreSupport(text, session, orders);
      await sendTelegramToBot(supportToken, chatId, aiDecision.reponse_client);

      await db.collection("support_sessions").doc(String(chatId)).collection("messages").add({
        text, decision: aiDecision.decision, action: aiDecision.action_prise,
        urgence: aiDecision.niveau_urgence, ts: FieldValue.serverTimestamp(),
      });

      const urg = { faible: "🟢", moyen: "🟡", "élevé": "🔴" }[aiDecision.niveau_urgence] || "⚪";
      const dec = { résolu: "✅", escalade: "🆘", info_manquante: "❓", fraude_signalée: "🚨" }[aiDecision.decision] || "ℹ️";

      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `${urg} <b>Support</b> ${dec} | 👤 ${firstName} | <code>${session.phone || "?"}</code>\n` +
        `💬 <i>"${text.substring(0, 80)}"</i>\n⚡ ${aiDecision.action_prise}` +
        (aiDecision.decision === "escalade" ? "\n⚠️ <b>Intervention manuelle requise.</b>" : "")
      );
    } catch (e) { console.error("supportClient crash:", e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — ADMIN BOT
// ══════════════════════════════════════════════════════════════════
exports.adminBot = onRequest(
  { region: REGION, secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID], timeoutSeconds: 60 },
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
      const confirmMatch = text.match(/^confirmer?\s+#?(\d{6,8})\b/i);
      if (confirmMatch) {
        const num  = confirmMatch[1];
        const snap = await db.collection("orders").where("orderId", "==", num).limit(1).get();
        if (snap.empty) { await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`); return; }
        const doc  = snap.docs[0]; const data = doc.data();
        if (data.status === "Confirmé") { await sendTelegram(token, adminId, `ℹ️ <b>#${num}</b> déjà confirmé.`); return; }
        if (!transitionValide(data.status, "Confirmé")) {
          await sendTelegram(token, adminId, `⛔ Impossible de confirmer un ordre en statut <b>${data.status}</b>.`); return;
        }
        await doc.ref.update({ status: "Confirmé", confirmedBy: "admin_telegram", confirmedAt: FieldValue.serverTimestamp() });
        logAudit("confirme_admin_telegram", { num, adminId, ancienStatut: data.status });
        await sendTelegram(token, adminId,
          `✅ Ordre <b>#${num}</b> confirmé.\n${Number(data.montant || 0).toLocaleString()} DJF | N°<code>${data.numeroPayment || "?"}</code>`
        );
        return;
      }

      // rejeter #ID [raison]
      const rejectMatch = text.match(/^rejeter?\s+#?(\d{6,8})(?:\s+(.+))?$/i);
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

      // nonmatche
      if (t === "nonmatche" || t === "/nonmatche") {
        const snap = await db.collection("waafi_notifications")
          .where("status", "in", ["non_matché", "montant_incorrect", "prêt"])
          .orderBy("createdAt", "desc").limit(10).get()
          .catch(() => db.collection("waafi_notifications").where("status", "==", "non_matché").limit(10).get());
        if (snap.empty) { await sendTelegram(token, adminId, "✅ Aucun SMS en attente."); return; }
        const lignes = snap.docs.map((d) => {
          const n = d.data();
          return `• TID:${n.transferId || "?"} | ${n.montant || "?"}DJF | N°${n.numClient || "?"} | ${n.status}`;
        });
        await sendTelegram(token, adminId, `📭 <b>SMS en attente (${snap.size})</b>\n\n${lignes.join("\n")}`);
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
