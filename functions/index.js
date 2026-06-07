/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  KAFFI PAY — CLOUD FUNCTIONS v5.0                                    ║
 * ║                                                                      ║
 * ║  Architecture : Event-Driven (100% temps réel) + Scheduled           ║
 * ║  Patterns     : State Machine · Circuit Breaker · Rate Limiting      ║
 * ║                 Duplicate Detection · Webhook Retry RT · Recon RT    ║
 * ║                                                                      ║
 * ║  Fonctions (13) :                                                    ║
 * ║  [Triggers]  onNouvelOrdre · onOrdreUpdated · autoConfirmation       ║
 * ║              onWebhookEchoue  ← NOUVEAU (remplace cron horaire)      ║
 * ║  [Scheduled] rapportJournalier · ordresBloqués · nettoyageCompteurs  ║
 * ║  [HTTP]      smsWebhook · healthCheck · supportClient · adminBot     ║
 * ║  [Callable]  analyseAdmin                                            ║
 * ║                                                                      ║
 * ║  Temps réel 24/7 :                                                   ║
 * ║  • SMS reçu → réconciliation IMMÉDIATE (≤ 2 s)                       ║
 * ║  • Nouvel ordre → vérif SMS en attente IMMÉDIATE                     ║
 * ║  • Webhook échoué → 3 retries automatiques (0 s / 30 s / 90 s)      ║
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

// ── Config ────────────────────────────────────────────────────────
const REGION = "europe-west1";
const TZ     = "Africa/Djibouti";

// ── Secrets ───────────────────────────────────────────────────────
const TELEGRAM_TOKEN    = defineSecret("TELEGRAM_TOKEN");
const TELEGRAM_ADMIN_ID = defineSecret("TELEGRAM_ADMIN_CHAT_ID");
const MACRO_WEBHOOK_URL = defineSecret("MACRODROID_WEBHOOK_URL");
const MACRO_SECRET      = defineSecret("MACRODROID_SECRET");
const SUPPORT_BOT_TOKEN = defineSecret("SUPPORT_BOT_TOKEN");

// ══════════════════════════════════════════════════════════════════
// SECTION 1 — STATE MACHINE DES ORDRES
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
// SECTION 2 — MOTEUR FRAUDE (multi-couches)
// ══════════════════════════════════════════════════════════════════
function analyserFraude(tx, transferId) {
  const raisons = [];
  let score     = 0;
  const montant = Number(tx.montant || 0);
  const num     = (tx.numeroPayment || "").replace(/\s/g, "");

  if (montant > 200000)     { score += 50; raisons.push("Montant extrême (> 200 000 DJF)"); }
  else if (montant > 100000){ score += 35; raisons.push("Montant très élevé (> 100 000 DJF)"); }
  else if (montant > 50000) { score += 15; raisons.push("Montant élevé (> 50 000 DJF)"); }
  else if (montant < 50)    { score += 30; raisons.push("Montant suspect (< 50 DJF)"); }

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
// SECTION 3 — RATE LIMITING (Firestore transactionnel)
// ══════════════════════════════════════════════════════════════════
const MAX_PAR_HEURE = 3;

async function verifierRateLimit(phone, type) {
  if (!phone || phone === "—") return { autorise: true };
  const cle     = `${phone}_${type}`;
  const ref     = db.collection("rate_limits").doc(cle);
  const fenetre = 60 * 60 * 1000;
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
      const resetDans = Math.ceil((d.debut + fenetre - maintenant) / 60000);
      return { autorise: false, restant: 0, resetDans };
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

// ══════════════════════════════════════════════════════════════════
// SECTION 6 — QUEUE WEBHOOK ÉCHOUÉ (temps réel via trigger)
// Sauvegarde → onWebhookEchoue se déclenche immédiatement
// ══════════════════════════════════════════════════════════════════
async function sauvegarderWebhookEchoue(ordreRef, id1xbet, montant) {
  await db.collection("failed_webhooks").doc(ordreRef).set({
    ordreRef, id1xbet, montant,
    tentatives: 0, maxTentatives: 3,
    statut: "en_attente",
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ══════════════════════════════════════════════════════════════════
// SECTION 7 — RÉCONCILIATION SMS IMMÉDIATE
// Cherche un ordre En attente correspondant à un SMS non_matché
// Score ≥ 40 → suggestion admin ; Score ≥ 80 → auto-confirmation
// ══════════════════════════════════════════════════════════════════
async function reconcilierSMS(smsDoc, token, adminId) {
  const sms = smsDoc.data();
  if (!sms.montant && !sms.numClient) return false;

  const candidats = [];

  if (sms.numClient) {
    const byPhone = await db.collection("orders")
      .where("numeroPayment", "==", sms.numClient)
      .where("status", "==", "En attente").limit(5).get();
    candidats.push(...byPhone.docs);
  }

  if (sms.montant) {
    const byMontant = await db.collection("orders")
      .where("montant", "==", sms.montant)
      .where("status", "==", "En attente").limit(5).get();
    for (const d of byMontant.docs) {
      if (!candidats.find((c) => c.id === d.id)) candidats.push(d);
    }
  }

  if (!candidats.length) return false;

  let meilleur = null, meilleurScore = 0;
  for (const c of candidats) {
    const o = c.data();
    let score = 0;
    if (sms.numClient && o.numeroPayment === sms.numClient) score += 50;
    if (sms.montant && Math.abs(Number(o.montant) - sms.montant) <= Math.max(5, sms.montant * 0.05)) score += 40;
    if (score > meilleurScore) { meilleur = c; meilleurScore = score; }
  }

  if (!meilleur || meilleurScore < 40) return false;

  const o   = meilleur.data();
  const ref = o.orderId || meilleur.id;

  // Score ≥ 80 = correspondance forte → auto-confirmation directe
  if (meilleurScore >= 80) {
    const claimed = await claimOrder(meilleur.ref, "En attente", "Argent Reçu", {
      confirmedBy: "auto_reconciliation_rt",
      waafitranfertID: sms.transferId || o.waafitranfertID,
      montantRecu: sms.montant || Number(o.montant),
      expediteurRecu: sms.numClient || "",
      argentRecuAt: FieldValue.serverTimestamp(),
    });

    if (claimed) {
      await smsDoc.ref.update({ status: "matché", ordreRef: ref, reconciledAt: FieldValue.serverTimestamp() });
      await new Promise((r) => setTimeout(r, 8000));
      await meilleur.ref.update({ status: "Confirmé", confirmedAt: FieldValue.serverTimestamp() });
      await smsDoc.ref.update({ status: "traité" });
      logAudit("reconciliation_auto_rt", { ref, smsId: smsDoc.id, score: meilleurScore });
      await sendTelegram(token, adminId,
        `✅ <b>Réconciliation temps réel — Auto-confirmé</b>\n\n` +
        `Ordre <code>#${ref}</code> ↔ SMS <code>${sms.transferId || "?"}</code>\n` +
        `${sms.montant ? sms.montant.toLocaleString() : "?"}DJF | N°${sms.numClient || "?"}\n` +
        `Score: <b>${meilleurScore}/90</b>`
      );
      return true;
    }
  }

  // Score 40-79 → suggestion admin
  await smsDoc.ref.update({ status: "suggestion_admin", ordreCandidat: ref });
  await sendTelegram(token, adminId,
    `🔄 <b>Réconciliation temps réel — Suggestion</b>\n\n` +
    `SMS ↔ Ordre <code>#${ref}</code> (score ${meilleurScore}/90)\n` +
    `TID: <code>${sms.transferId || "?"}</code> | ${sms.montant ? sms.montant.toLocaleString() : "?"}DJF | N°${sms.numClient || "?"}\n\n` +
    `Pour confirmer : <code>confirmer ${ref}</code>`
  );
  return false;
}

// ══════════════════════════════════════════════════════════════════
// SECTION 8 — AUDIT LOG
// ══════════════════════════════════════════════════════════════════
function logAudit(action, data) {
  db.collection("audit_logs").add({
    action, data: data || {}, ts: FieldValue.serverTimestamp(), source: "cloud-functions",
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════
// SECTION 9 — SUPPORT CLIENT (arbre décision)
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
        "info_manquante", "Numéro Waafi requis", "faible", `Ordre #${ordreNum} sans numéro Waafi`
      );
    }

    const ligne = orders.find((o) => o.includes(`#${ordreNum}`));
    if (!ligne) {
      return reply(
        `L'ordre <b>#${ordreNum}</b> est introuvable pour votre numéro.\n\nVérifiez le numéro d'ordre (6 à 8 chiffres, visible sur kaffi-pay.com).`,
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
      return reply(`✏️ Votre ordre <b>#${ordreNum}</b> est en <b>vérification</b> par notre équipe.`,
        "escalade", "Correction signalée admin", "moyen", `#${ordreNum} en correction`);

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
          "info_manquante", "Rejeté non reçu — demande infos", "moyen", `#${ordreNum} rejeté non reçu`
        );
      return reply(
        `❌ Ordre <b>#${ordreNum}</b> <b>rejeté</b>. Envoyez votre Transfer ID Waafi pour vérification.`,
        "info_manquante", "Rejeté — Transfer ID demandé", "moyen", `#${ordreNum} rejeté`
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
    "info_manquante", "Message non reconnu", "faible", "Fallback numéro d'ordre"
  );
}

function reply(reponse_client, decision, action_prise, niveau_urgence, resume_audit) {
  return { reponse_client: reponse_client + "\n\n— <i>Support Kaffi-Pay</i>", decision, action_prise, niveau_urgence, resume_audit };
}

// ══════════════════════════════════════════════════════════════════
// SECTION 10 — ADMIN BOT (logique pure)
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
// SECTION 11 — HELPERS
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

async function claimOrder(docRef, expectedStatus, newStatus, extra = {}) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists || snap.data().status !== expectedStatus) return false;
    tx.update(docRef, { status: newStatus, ...extra });
    return true;
  });
}

function extractTransferId(text) {
  const m = text.match(/Transfer-?Id[:\s]+(\d+)/i);
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
// TRIGGER 1 — NOUVEL ORDRE
// + Vérif croisée : SMS non_matché compatible ?  (temps réel)
// ══════════════════════════════════════════════════════════════════
exports.onNouvelOrdre = onDocumentCreated(
  { document: "orders/{docId}", region: REGION, secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID], timeoutSeconds: 60 },
  async (event) => {
    const tx         = event.data.data();
    const docId      = event.params.docId;
    const ref        = tx.orderId || tx.ref || docId;
    const transferId = tx.waafitranfertID || tx.hash || "";
    const isDepot    = tx.type === "Dépôt";
    const phone      = tx.numeroPayment || tx.waafiNumber || "";

    logAudit("nouvel_ordre", { ref, type: tx.type, montant: tx.montant, phone });

    // ── FRAUDE 1 : Transfer ID déjà confirmé ───────────────────
    if (transferId) {
      const [confirmeSnap, matcheSnap] = await Promise.all([
        db.collection("orders").where("waafitranfertID", "==", transferId).where("status", "==", "Confirmé").limit(1).get(),
        db.collection("waafi_notifications").where("transferId", "==", transferId).where("status", "==", "matché").limit(1).get(),
      ]);
      if (!confirmeSnap.empty || !matcheSnap.empty) {
        const source    = !confirmeSnap.empty ? confirmeSnap.docs[0] : matcheSnap.docs[0];
        const ancienRef = source.data().orderId || source.data().ordreRef || source.id;
        await db.collection("orders").doc(docId).update({
          status: "Rejeté",
          flagRaison: `FRAUDE — Transfer ID ${transferId} déjà utilisé (#${ancienRef})`,
          flaggedAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
          `🚨 <b>FRAUDE — Transfer ID réutilisé</b>\n\nOrdre <code>#${ref}</code> rejeté.\n` +
          `Transfer-ID <code>${transferId}</code> déjà utilisé dans <code>#${ancienRef}</code>.`
        );
        logAudit("fraude_transfer_id_reutilise", { ref, transferId, ancienRef });
        return;
      }
    }

    // ── RATE LIMIT ──────────────────────────────────────────────
    if (phone && phone !== "—") {
      const rl = await verifierRateLimit(phone, tx.type);
      if (!rl.autorise) {
        await db.collection("orders").doc(docId).update({
          status: "Rejeté",
          flagRaison: `Rate limit — max ${MAX_PAR_HEURE} ordres/heure. Réessayez dans ${rl.resetDans} min.`,
          flaggedAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
          `⚠️ <b>Rate limit</b>\nN°: <code>${phone}</code> | ${tx.type}\nOrdre <code>#${ref}</code> rejeté.`
        );
        logAudit("rate_limit_declenche", { ref, phone, type: tx.type });
        return;
      }
    }

    // ── DOUBLON ─────────────────────────────────────────────────
    const doublon = await detecterDoublon(phone, Number(tx.montant), tx.type, docId);
    if (doublon) {
      await db.collection("orders").doc(docId).update({
        doublon_suspect: doublon.ordreId, doublon_alerte: true,
        doublon_at: FieldValue.serverTimestamp(),
      });
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>Possible doublon</b>\n\nOrdre <code>#${ref}</code> ≈ <code>#${doublon.ordreId}</code>\n` +
        `Même n° (${phone}), montant similaire, < 30 min.\nVérifiez avant de confirmer.`
      );
    }

    // ── DÉPÔT avec Transfer ID ───────────────────────────────────
    if (isDepot) {
      const montantOrdre = Number(tx.montant || 0);
      let waafiDoc = null, waafiData = null;

      if (transferId) {
        const snap = await db.collection("waafi_notifications")
          .where("transferId", "==", transferId).where("status", "==", "nouveau").limit(1).get();
        if (!snap.empty) { waafiDoc = snap.docs[0]; waafiData = waafiDoc.data(); }
      }

      if (waafiDoc) {
        const montantReel = waafiData.montant  || montantOrdre;
        const numReel     = waafiData.numClient || phone || "";
        const corrections = [];
        if (waafiData.montant && Math.abs(montantOrdre - waafiData.montant) > 1)
          corrections.push(`Montant corrigé: ${montantOrdre} → ${waafiData.montant} DJF`);
        if (waafiData.numClient && phone && waafiData.numClient !== phone)
          corrections.push(`N° corrigé: ${phone} → ${waafiData.numClient}`);

        const claimed = await claimOrder(db.collection("orders").doc(docId), "En attente", "Confirmé", {
          confirmedBy: "auto_transfer_id", montant: montantReel, montantRecu: montantReel,
          numeroPayment: numReel, expediteurRecu: numReel,
          correctionApplied: corrections.length > 0, corrections,
          confirmedAt: FieldValue.serverTimestamp(),
        });

        if (claimed) {
          await waafiDoc.ref.update({ status: "matché", ordreRef: ref });
          await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
            `✅ <b>Dépôt confirmé automatiquement</b>${corrections.length ? " ✏️" : ""}\n\n` +
            `Réf: <b>#${ref}</b> | Montant: <b>${Number(montantReel).toLocaleString()} DJF</b>\n` +
            `Transfer-ID: <code>${transferId}</code> | Expéditeur: <code>${numReel}</code>` +
            (corrections.length ? `\n✏️ <i>${corrections.join(" | ")}</i>` : "")
          );
          logAudit("depot_confirme_auto", { ref, transferId, montant: montantReel });
          return;
        }
      }

      // ── Vérif croisée TEMPS RÉEL : SMS non_matché compatible ? ──
      // Un SMS peut être arrivé avant cet ordre sans trouver de correspondance.
      // On cherche maintenant que l'ordre existe.
      const nonMatcheSnap = await db.collection("waafi_notifications")
        .where("status", "in", ["non_matché", "suggestion_admin"])
        .limit(20).get().catch(() => ({ empty: true, docs: [] }));

      if (!nonMatcheSnap.empty) {
        for (const smsDoc of nonMatcheSnap.docs) {
          const sms = smsDoc.data();
          const matchPhone  = phone && sms.numClient && sms.numClient === phone;
          const matchAmount = sms.montant && Math.abs(montantOrdre - sms.montant) <= Math.max(5, montantOrdre * 0.05);
          const matchTID    = transferId && sms.transferId && sms.transferId === transferId;

          if (matchTID || (matchPhone && matchAmount)) {
            await reconcilierSMS(smsDoc, TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value());
            break;
          }
        }
      }

      // Transfer ID introuvable → rejet
      await db.collection("orders").doc(docId).update({
        status: "Rejeté",
        flagRaison: `Paiement non reçu — Transfer ID ${transferId || "(non fourni)"} introuvable`,
        flaggedAt: FieldValue.serverTimestamp(),
      });
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `❌ <b>Ordre rejeté — Paiement non reçu</b>\nRéf: <code>#${ref}</code>\n` +
        `Transfer-ID: <code>${transferId || "non fourni"}</code> | ${montantOrdre.toLocaleString()} DJF`
      );
      return;
    }

    // ── ANALYSE FRAUDE (retrait) ────────────────────────────────
    const fraud = analyserFraude(tx, transferId);
    await db.collection("orders").doc(docId).update({
      ia_score_fraude: fraud.score_fraude, ia_risque: fraud.risque,
      ia_raisons: fraud.raisons, ia_action: fraud.action,
      ia_analysedAt: FieldValue.serverTimestamp(),
    });

    if (fraud.action === "rejeter" || fraud.risque === "élevé") {
      await db.collection("orders").doc(docId).update({
        status: "Rejeté", flagRaison: "Fraude: " + fraud.raisons.join(", "),
      });
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `🚨 <b>Ordre rejeté — Fraude (score ${fraud.score_fraude}/100)</b>\n` +
        `Réf: <code>#${ref}</code> | ${fraud.raisons.join(", ")}`
      );
      logAudit("ordre_rejete_fraude", { ref, score: fraud.score_fraude });
      return;
    }

    const details = isDepot
      ? `ID 1xBet: <code>${tx.userId1xBet || "?"}</code> | Transfer ID: <code>${transferId || "?"}</code>`
      : `Code: <code>${tx.withdrawalCode || "?"}</code> | N° Waafi: <code>${tx.waafiNumber || "?"}</code>`;

    await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
      `${isDepot ? "📥" : "📤"} <b>Nouvel ordre ${tx.type}</b>\n` +
      `Réf: <b>#${ref}</b> | <b>${Number(tx.montant).toLocaleString()} DJF</b>\n` +
      `${details}${doublon ? "\n⚠️ <i>Doublon possible</i>" : ""}\n` +
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
// TRIGGER 3 — AUTO-CONFIRMATION SMS Waafi (temps réel)
// Déclenché à chaque nouveau document waafi_notifications
// Si non_matché → reconcilierSMS() immédiatement (pas d'attente)
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
    if (sms.status === "traité" || sms.status === "en_cours") return;

    const expectedSecret = MACRO_SECRET.value() || "KaffiPay2026";
    if (sms.secret && sms.secret !== expectedSecret) {
      await db.collection("waafi_notifications").doc(docId).update({ status: "rejeté_secret_invalide" });
      return;
    }

    await db.collection("waafi_notifications").doc(docId).update({
      status: "en_cours", processedAt: FieldValue.serverTimestamp(),
    });

    const notification = sms.notification || sms.not_body || sms.message || sms.texte || sms.body || "";
    const transferId   = extractTransferId(notification);
    const montantSMS   = extractMontant(notification);
    const numClient    = extractNumClient(notification);

    console.log(`SMS Waafi → TID: ${transferId}, Montant: ${montantSMS}, N°: ${numClient}`);

    if (!transferId && !montantSMS) {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "erreur_parsing", erreurMsg: "Impossible d'extraire Transfer ID ou Montant",
      });
      return;
    }

    // Mise à jour des champs parsés pour réconciliation
    await db.collection("waafi_notifications").doc(docId).update({
      transferId, montant: montantSMS, numClient,
    });

    // Recherche 1 : par Transfer ID exact
    let ordreSnap = { empty: true };
    if (transferId) {
      ordreSnap = await db.collection("orders")
        .where("waafitranfertID", "==", transferId).where("status", "==", "En attente").limit(1).get();
    }
    // Recherche 2 : par numéro + montant exact
    if (ordreSnap.empty && numClient && montantSMS) {
      ordreSnap = await db.collection("orders")
        .where("numeroPayment", "==", numClient).where("montant", "==", montantSMS).where("status", "==", "En attente").limit(1).get();
    }
    // Recherche 3 : par montant seul (fuzzy ±5%)
    if (ordreSnap.empty && montantSMS) {
      const byMontant = await db.collection("orders")
        .where("status", "==", "En attente").limit(20).get();
      const tol = Math.max(5, montantSMS * 0.05);
      const match = byMontant.docs.find((d) => Math.abs(Number(d.data().montant) - montantSMS) <= tol);
      if (match) ordreSnap = { empty: false, docs: [match] };
    }

    if (ordreSnap.empty) {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "non_matché",
        erreurMsg: `Aucun ordre — TID: ${transferId}, Montant: ${montantSMS}`,
        transferId, montant: montantSMS, numClient,
      });
      // Tentative immédiate de réconciliation floue
      const smsDocFresh = await db.collection("waafi_notifications").doc(docId).get();
      const reconciled  = await reconcilierSMS(smsDocFresh, TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value());
      if (!reconciled) {
        await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
          `⚠️ <b>SMS Waafi sans correspondance</b>\nTransfer-ID: <code>${transferId || "?"}</code>\n` +
          `Montant: <b>${montantSMS ? montantSMS.toLocaleString() : "?"} DJF</b>\n` +
          `Expéditeur: <code>${numClient || "?"}</code>\n` +
          `<i>Sera re-tenté dès qu'un ordre compatible arrive.</i>`
        );
      }
      return;
    }

    const ordreDoc     = ordreSnap.docs[0];
    const ordre        = ordreDoc.data();
    const ordreRef     = ordre.orderId || ordre.ref || ordreDoc.id;
    const montantOrdre = Number(ordre.montant || 0);
    const mt           = montantSMS || montantOrdre;

    const tolerance = Math.max(5, montantOrdre * 0.05);
    if (montantSMS && Math.abs(montantOrdre - montantSMS) > tolerance) {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "montant_incorrect",
        erreurMsg: `SMS (${montantSMS}) ≠ Ordre (${montantOrdre}), delta: ${Math.abs(montantOrdre - montantSMS)}`,
        ordreRef,
      });
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>Montant incorrect</b> pour #${ordreRef}\n` +
        `SMS: ${montantSMS} DJF / Ordre: ${montantOrdre} DJF (delta: ${Math.abs(montantOrdre - montantSMS)} DJF)`
      );
      return;
    }

    const claimed = await claimOrder(ordreDoc.ref, "En attente", "Argent Reçu", {
      confirmedBy: "auto_waafi_sms", waafitranfertID: transferId || ordre.waafitranfertID,
      montantRecu: mt, expediteurRecu: numClient || "", argentRecuAt: FieldValue.serverTimestamp(),
    });

    if (!claimed) {
      await db.collection("waafi_notifications").doc(docId).update({ status: "déjà_traité", ordreRef });
      return;
    }

    await db.collection("waafi_notifications").doc(docId).update({ status: "matché", ordreRef });
    await new Promise((r) => setTimeout(r, 10000));
    await ordreDoc.ref.update({ status: "Confirmé", confirmedAt: FieldValue.serverTimestamp() });
    await db.collection("waafi_notifications").doc(docId).update({ status: "traité" });

    logAudit("depot_confirme_sms", { ordreRef, transferId, montant: mt });

    const id1xbet     = ordre.userId1xBet || ordre.id1x || "";
    const webhookBase = MACRO_WEBHOOK_URL.value() ||
      "https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet";

    if (id1xbet) {
      try {
        await appelWebhook(webhookBase, ordreRef, mt, id1xbet);
        await ordreDoc.ref.update({ webhookStatus: "ok", webhookAt: FieldValue.serverTimestamp() });
      } catch (e) {
        await ordreDoc.ref.update({ webhookStatus: "echec", webhookError: e.message });
        await sauvegarderWebhookEchoue(ordreRef, id1xbet, mt);
        // Pas de notification ici — onWebhookEchoue va retenter immédiatement
      }
    } else {
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>ID 1xBet manquant</b> — #${ordreRef}\n${Number(mt).toLocaleString()} DJF reçu. Recharge manuelle.`
      );
    }

    await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
      `✅ <b>Dépôt auto-confirmé</b>\n#${ordreRef} — ${Number(mt).toLocaleString()} DJF\n` +
      `ID 1xBet: <code>${id1xbet || "?"}</code>` +
      (transferId ? `\nTransfer-ID: <code>${transferId}</code>` : "")
    );
  }
);

// ══════════════════════════════════════════════════════════════════
// TRIGGER 4 — WEBHOOK ÉCHOUÉ : RETRY TEMPS RÉEL
//
// Se déclenche IMMÉDIATEMENT quand failed_webhooks reçoit un doc.
// 3 tentatives : 0 s → 30 s → 90 s — tout dans une seule exécution.
// Aucune attente horaire nécessaire.
// ══════════════════════════════════════════════════════════════════
exports.onWebhookEchoue = onDocumentCreated(
  {
    document: "failed_webhooks/{docId}", region: REGION,
    secrets: [MACRO_WEBHOOK_URL, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID],
    timeoutSeconds: 300, // 5 min — largement suffisant pour 3 retries
  },
  async (event) => {
    const docId = event.params.docId;
    const w     = event.data.data();

    const webhookBase = MACRO_WEBHOOK_URL.value() ||
      "https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet";

    // Délais entre tentatives : 0 s, 30 s, 90 s
    const delais = [0, 30000, 90000];

    for (let i = 0; i < delais.length; i++) {
      if (delais[i] > 0) await new Promise((r) => setTimeout(r, delais[i]));

      const tentative = i + 1;
      try {
        await appelWebhook(webhookBase, w.ordreRef, w.montant, w.id1xbet);

        // ── Succès ───────────────────────────────────────────────
        await db.collection("failed_webhooks").doc(docId).update({
          statut: "succès", tentatives: tentative, resolvedAt: FieldValue.serverTimestamp(),
        });

        // Mettre à jour le statut webhook sur l'ordre
        const ordresSnap = await db.collection("orders").where("orderId", "==", w.ordreRef).limit(1).get();
        if (!ordresSnap.empty) await ordresSnap.docs[0].ref.update({ webhookStatus: "ok_retry_rt" });

        await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
          `✅ <b>Webhook récupéré (tentative ${tentative}/3)</b>\n` +
          `Ordre <code>#${w.ordreRef}</code> | ID 1xBet: <code>${w.id1xbet}</code>`
        );

        logAudit("webhook_retry_succes_rt", { ordreRef: w.ordreRef, tentative });
        return;

      } catch (e) {
        console.warn(`Webhook retry RT tentative ${tentative}/3 échoué: ${e.message}`);
        await db.collection("failed_webhooks").doc(docId).update({
          tentatives: tentative, dernierEchec: e.message,
        });

        if (tentative === delais.length) {
          // ── Toutes les tentatives épuisées ─────────────────────
          await db.collection("failed_webhooks").doc(docId).update({ statut: "abandonné" });
          await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
            `🔴 <b>Webhook abandonné — 3 tentatives échouées</b>\n\n` +
            `Ordre <code>#${w.ordreRef}</code> | ID 1xBet: <code>${w.id1xbet}</code>\n` +
            `Montant: <b>${Number(w.montant || 0).toLocaleString()} DJF</b>\n` +
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
      `💰 Volume dépôts confirmés: <b>${volume.toLocaleString()} DJF</b>\n\n` +
      (rejetes.length > confirmes.length ? "⚠️ Plus de rejets que de confirmations — vérifiez." :
       fraudes.length > 2 ? "🚨 Activité frauduleuse élevée." : "✅ Journée normale.")
    );

    const yy = String(hier.getFullYear()).slice(-2);
    const mm = String(hier.getMonth() + 1).padStart(2, "0");
    const dd = String(hier.getDate()).padStart(2, "0");
    await db.collection("daily_stats").doc(`${yy}${mm}${dd}`).set({
      date: dateStr, depots: depots.length, retraits: retraits.length,
      confirmes: confirmes.length, rejetes: rejetes.length, fraudes: fraudes.length,
      volume, taux, computedAt: FieldValue.serverTimestamp(),
    });
  }
);

// ══════════════════════════════════════════════════════════════════
// SCHEDULED 2 — ORDRES BLOQUÉS (toutes les 5 min)
// Seul cas où un scheduler est nécessaire : détecter le temps écoulé.
// Alerte si un ordre reste En attente > 30 min.
// ══════════════════════════════════════════════════════════════════
exports.ordresBloqués = onSchedule(
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

    // Anti-spam : 1 alerte max toutes les 30 min
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
      `⚠️ <b>${bloqués.length} ordre(s) bloqué(s) > 30 min</b>\n\n${lignes.join("\n")}\n\n` +
      "<i>Commandes : confirmer #ID | rejeter #ID raison</i>"
    );

    await alertRef.set({ ts: FieldValue.serverTimestamp(), count: bloqués.length });
  }
);

// ══════════════════════════════════════════════════════════════════
// SCHEDULED 3 — NETTOYAGE (chaque nuit à minuit)
// ══════════════════════════════════════════════════════════════════
exports.nettoyageCompteurs = onSchedule(
  { schedule: "0 0 * * *", timeZone: TZ, region: REGION },
  async () => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    const yy = String(cutoff.getFullYear()).slice(-2);
    const mm = String(cutoff.getMonth() + 1).padStart(2, "0");
    const dd = String(cutoff.getDate()).padStart(2, "0");
    const limite = `daily_${yy}${mm}${dd}`;

    const snap = await db.collection("counters")
      .where("__name__", "<=", limite).get().catch(() => ({ docs: [] }));

    if (snap.docs.length > 0) {
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      console.log(`Nettoyage: ${snap.docs.length} compteurs supprimés`);
    }

    // Rate limits expirés
    const rlSnap = await db.collection("rate_limits")
      .where("expiresAt", "<", Date.now()).limit(100).get().catch(() => ({ docs: [] }));
    if (rlSnap.docs.length > 0) {
      const batch2 = db.batch();
      rlSnap.docs.forEach((d) => batch2.delete(d.ref));
      await batch2.commit();
    }

    // Audit logs > 30 jours
    const cutoffAudit = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const auditSnap = await db.collection("audit_logs")
      .where("ts", "<", cutoffAudit).limit(100).get().catch(() => ({ docs: [] }));
    if (auditSnap.docs.length > 0) {
      const batch3 = db.batch();
      auditSnap.docs.forEach((d) => batch3.delete(d.ref));
      await batch3.commit();
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// HTTP — WEBHOOK MACRODROID
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

    await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
      `📩 <b>SMS Waafi reçu</b>\nTransfer-ID: <code>${transferId || "?"}</code>\n` +
      `Montant: <b>${montant ? Number(montant).toLocaleString() : "?"} DJF</b>\n` +
      `Expéditeur: <code>${numClient || "?"}</code>\n<i>Traitement automatique en cours…</i>`
    );

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
      firestore: firestoreMs, ai: "logique embarquée v5.0",
      circuit_breaker: cb, webhooks_en_attente: webhooksAttente,
      mode: "temps_reel_24/7", version: "5.0",
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
          orders = [`• #${o.orderId || snap.docs[0].id} | ${o.type} | ${o.montant} DJF | ${o.status} | ${o.flagRaison || ""}`];
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

      if (chatId !== adminId) return;
      if (!text) return;
      console.log(`adminBot: "${text}"`);

      const t = text.toLowerCase().trim();

      // ── confirmer #ID ───────────────────────────────────────────
      const confirmMatch = text.match(/^confirmer?\s+#?(\d{6,8})\b/i);
      if (confirmMatch) {
        const num  = confirmMatch[1];
        const snap = await db.collection("orders").where("orderId", "==", num).limit(1).get();
        if (snap.empty) { await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`); return; }
        const doc  = snap.docs[0];
        const data = doc.data();
        if (data.status === "Confirmé") { await sendTelegram(token, adminId, `ℹ️ Ordre <b>#${num}</b> déjà confirmé.`); return; }
        if (!transitionValide(data.status, "Confirmé")) {
          await sendTelegram(token, adminId, `⛔ Impossible de confirmer un ordre en statut <b>${data.status}</b>.`); return;
        }
        await doc.ref.update({ status: "Confirmé", confirmedBy: "admin_telegram", confirmedAt: FieldValue.serverTimestamp() });
        logAudit("confirme_admin_telegram", { num, adminId, ancienStatut: data.status });
        await sendTelegram(token, adminId,
          `✅ Ordre <b>#${num}</b> confirmé manuellement.\n` +
          `${Number(data.montant || 0).toLocaleString()} DJF | N°<code>${data.numeroPayment || "?"}</code>`
        );
        return;
      }

      // ── rejeter #ID [raison] ────────────────────────────────────
      const rejectMatch = text.match(/^rejeter?\s+#?(\d{6,8})(?:\s+(.+))?$/i);
      if (rejectMatch) {
        const num    = rejectMatch[1];
        const raison = (rejectMatch[2] || "Rejeté par admin").trim();
        const snap   = await db.collection("orders").where("orderId", "==", num).limit(1).get();
        if (snap.empty) { await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`); return; }
        const doc  = snap.docs[0];
        const data = doc.data();
        if (data.status === "Rejeté") { await sendTelegram(token, adminId, `ℹ️ Ordre <b>#${num}</b> déjà rejeté.`); return; }
        if (!transitionValide(data.status, "Rejeté")) {
          await sendTelegram(token, adminId, `⛔ Impossible de rejeter un ordre en statut <b>${data.status}</b>.`); return;
        }
        await doc.ref.update({ status: "Rejeté", flagRaison: raison, rejectedBy: "admin_telegram", flaggedAt: FieldValue.serverTimestamp() });
        logAudit("rejete_admin_telegram", { num, raison, adminId });
        await sendTelegram(token, adminId, `❌ Ordre <b>#${num}</b> rejeté.\nRaison : <i>${raison}</i>`);
        return;
      }

      // ── client 77XXXXXXX ────────────────────────────────────────
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

      // ── alerte (ordres > 30 min) ────────────────────────────────
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

      // ── nonmatche ───────────────────────────────────────────────
      if (t === "nonmatche" || t === "/nonmatche") {
        const snap = await db.collection("waafi_notifications")
          .where("status", "in", ["non_matché", "suggestion_admin"])
          .orderBy("createdAt", "desc").limit(10).get()
          .catch(() => db.collection("waafi_notifications").where("status", "==", "non_matché").limit(10).get());
        if (snap.empty) { await sendTelegram(token, adminId, "✅ Aucun SMS sans correspondance."); return; }
        const lignes = snap.docs.map((d) => {
          const n = d.data();
          return `• TID:${n.transferId || "?"} | ${n.montant || "?"}DJF | N°${n.numClient || "?"} | ${n.status}${n.ordreCandidat ? " → candidat #" + n.ordreCandidat : ""}`;
        });
        await sendTelegram(token, adminId, `📭 <b>SMS sans correspondance (${snap.size})</b>\n\n${lignes.join("\n")}`);
        return;
      }

      // ── circuit ─────────────────────────────────────────────────
      if (t === "circuit" || t === "/circuit") {
        const snap = await db.collection("circuit_breakers").doc("macrodroid").get();
        if (!snap.exists) { await sendTelegram(token, adminId, "✅ Circuit breaker: <b>closed</b> (jamais utilisé)"); return; }
        const cb = snap.data();
        const ouvertDepuis = cb.ouvertA ? Math.round((Date.now() - cb.ouvertA) / 60000) : null;
        await sendTelegram(token, adminId,
          `🔌 <b>Circuit breaker MacroDroid</b>\n\n` +
          `État: <b>${cb.etat.toUpperCase()}</b>\n` +
          `Échecs: ${cb.echecs || 0}\n` +
          (ouvertDepuis ? `Ouvert depuis: ${ouvertDepuis} min\n` : "") +
          (cb.dernierEchec ? `Dernier échec: <i>${cb.dernierEchec}</i>` : "")
        );
        if (cb.etat === "open")
          await sendTelegram(token, adminId, "Pour réinitialiser : envoyez <code>reset circuit</code>");
        return;
      }

      // ── reset circuit ────────────────────────────────────────────
      if (t === "reset circuit" || t === "/reset_circuit") {
        await db.collection("circuit_breakers").doc("macrodroid").set({ etat: "closed", echecs: 0, resetAt: Date.now() });
        logAudit("circuit_reset", { adminId });
        await sendTelegram(token, adminId, "✅ Circuit breaker réinitialisé — état: <b>CLOSED</b>");
        return;
      }

      // ── Requêtes générales ───────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════
// CALLABLE — ANALYSE ADMIN
// ══════════════════════════════════════════════════════════════════
exports.analyseAdmin = onCall(
  { region: REGION, secrets: [] },
  async () => {
    const snap    = await db.collection("orders").orderBy("ts", "desc").limit(100).get();
    const txs     = snap.docs.map((d) => d.data());
    const conf    = txs.filter((t) => t.status === "Confirmé");
    const att     = txs.filter((t) => t.status === "En attente");
    const rej     = txs.filter((t) => t.status === "Rejeté");
    const fraudes = txs.filter((t) => t.flagRaison?.toUpperCase().includes("FRAUDE"));
    const volume  = conf.reduce((s, t) => s + Number(t.montant || 0), 0);
    const taux    = txs.length ? Math.round(conf.length / txs.length * 100) : 0;
    const moy     = conf.length ? Math.round(volume / conf.length) : 0;

    const wSnap  = await db.collection("failed_webhooks").where("statut", "==", "en_attente").get().catch(() => ({ size: 0 }));
    const cbSnap = await db.collection("circuit_breakers").doc("macrodroid").get().catch(() => null);
    const cbEtat = cbSnap?.exists ? cbSnap.data().etat : "closed";

    let alerte = null;
    if (att.length > 10)               alerte = `${att.length} ordres en attente — vérification requise`;
    else if (fraudes.length > 3)       alerte = `${fraudes.length} fraudes détectées récemment`;
    else if (taux < 50 && txs.length > 10) alerte = `Taux de confirmation faible : ${taux}%`;
    else if (cbEtat === "open")        alerte = "Circuit breaker MacroDroid OUVERT — vérifiez MacroDroid";
    else if (wSnap.size > 0)           alerte = `${wSnap.size} webhook(s) en cours de retry automatique`;

    return {
      success: true,
      data: {
        resume: `${conf.length} confirmés sur ${txs.length} — ${volume.toLocaleString()} DJF. Taux: ${taux}%.`,
        alerte,
        conseil: att.length > 5 ? "Vérifier les ordres en attente" : "Opérations normales",
        prediction_demain: moy * Math.max(conf.length, 1),
        score_sante: Math.max(0, Math.min(100, taux - fraudes.length * 10)),
        circuit_breaker: cbEtat,
        webhooks_en_attente: wSnap.size,
        mode: "temps_reel_24/7",
      },
      stats: { confirmes: conf.length, attente: att.length, rejetes: rej.length, fraudes: fraudes.length, volume },
    };
  }
);

// Alias compatibilité frontend
exports.geminiAnalyseAdmin = exports.analyseAdmin;
