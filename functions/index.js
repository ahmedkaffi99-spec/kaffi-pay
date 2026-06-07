/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           KAFFI PAY — CLOUD FUNCTIONS v3.6                      ║
 * ║  • Confirmation automatique dépôts (Transfer ID)                ║
 * ║  • Détection fraude (règles embarquées)                         ║
 * ║  • Support client — arbre décision complet + FAQ                ║
 * ║  • Admin bot — actions Firestore + requêtes avancées            ║
 * ║  • Webhook MacroDroid SMS Waafi                                 ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest }                    = require("firebase-functions/v2/https");
const { defineSecret }                         = require("firebase-functions/params");
const { initializeApp }                        = require("firebase-admin/app");
const { getFirestore, FieldValue }             = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const REGION = "europe-west1";

// ── Secrets ────────────────────────────────────────────────────────
const TELEGRAM_TOKEN    = defineSecret("TELEGRAM_TOKEN");
const TELEGRAM_ADMIN_ID = defineSecret("TELEGRAM_ADMIN_CHAT_ID");
const MACRO_WEBHOOK_URL = defineSecret("MACRODROID_WEBHOOK_URL");
const MACRO_SECRET      = defineSecret("MACRODROID_SECRET");
const SUPPORT_BOT_TOKEN = defineSecret("SUPPORT_BOT_TOKEN");

// ══════════════════════════════════════════════════════════════════
// LOGIQUE FRAUDE — règles pures, aucune IA externe
// ══════════════════════════════════════════════════════════════════
function analyserFraude(tx, transferId) {
  const raisons = [];
  let score     = 0;

  const montant = Number(tx.montant || 0);
  const num     = (tx.numeroPayment || "").replace(/\s/g, "");

  if (montant > 100000)     { score += 40; raisons.push("Montant très élevé (> 100 000 DJF)"); }
  else if (montant > 50000) { score += 20; raisons.push("Montant élevé (> 50 000 DJF)"); }

  if (!transferId) {
    score += 40; raisons.push("Transfer ID manquant");
  } else if (!/^\d{6,}$/.test(String(transferId))) {
    score += 40; raisons.push("Transfer ID invalide (< 6 chiffres)");
  }

  if (num && !/^77/.test(num)) { score += 20; raisons.push("N° expéditeur suspect (ne commence pas par 77)"); }
  if (!num)                    { score += 10; raisons.push("N° expéditeur manquant"); }

  score = Math.min(score, 100);
  const risque = score >= 70 ? "élevé" : score >= 40 ? "moyen" : "faible";
  const action = score >= 70 ? "rejeter" : score >= 40 ? "vérifier" : "valider";

  return { score_fraude: score, risque, raisons: raisons.length ? raisons : ["Aucune anomalie"], action };
}

// ══════════════════════════════════════════════════════════════════
// SUPPORT CLIENT — arbre décision complet + FAQ
// ══════════════════════════════════════════════════════════════════
function repondreSupport(text, session, orders) {
  const t = text.toLowerCase().trim();

  // ── Extraction patterns ──────────────────────────────────────
  const ordreMatch    = text.match(/(?:#\s*|n[°o]\.?\s*)?(\d{6,8})\b/i);
  const ordreNum      = ordreMatch ? ordreMatch[1] : null;
  const hasTransferId = /transfer[- ]?id|tid\b/i.test(t) || /\b\d{9,}\b/.test(text);
  const isGreeting    = /^(bonjour|salut|bonsoir|hello|salam|hi|allo|allô|bjr|bj)\b/.test(t);

  // ── FAQ ──────────────────────────────────────────────────────
  if (/comment.*(fonc|march|utilis|process)|étape|procédure|comment faire/.test(t)) {
    return {
      reponse_client:
        "ℹ️ <b>Comment fonctionne Kaffi-Pay ?</b>\n\n" +
        "1. Soumettez votre ordre sur <b>kaffi-pay.com</b>\n" +
        "2. Effectuez le paiement Waafi avec le <b>Transfer ID</b> fourni\n" +
        "3. Votre compte 1xBet est crédité <b>automatiquement</b>\n\n" +
        "Pour suivre un ordre, envoyez votre <b>numéro d'ordre</b>.\n\n— <i>Support Kaffi-Pay</i>",
      decision: "résolu", action_prise: "FAQ fonctionnement envoyée",
      niveau_urgence: "faible", resume_audit: "Client a demandé le fonctionnement",
    };
  }

  if (/(?:combien.*temps|délai|durée|quand.*confirm|temps.*traitement|traité.*quand)/.test(t)) {
    return {
      reponse_client:
        "⏱️ <b>Délais de traitement</b>\n\n" +
        "• Confirmation automatique : <b>immédiat à 5 minutes</b>\n" +
        "• Vérification manuelle si besoin : <b>moins de 30 minutes</b>\n\n" +
        "Kaffi-Pay est disponible <b>24h/24 — 7j/7</b>.\n\n— <i>Support Kaffi-Pay</i>",
      decision: "résolu", action_prise: "FAQ délais envoyée",
      niveau_urgence: "faible", resume_audit: "Client a demandé les délais",
    };
  }

  if (/\b(frais|commission|taux|prix|coût)\b/.test(t)) {
    return {
      reponse_client:
        "💰 Les frais sont affichés sur <b>kaffi-pay.com</b> avant de soumettre votre ordre.\n\n— <i>Support Kaffi-Pay</i>",
      decision: "résolu", action_prise: "FAQ frais envoyée",
      niveau_urgence: "faible", resume_audit: "Client a demandé les frais",
    };
  }

  if (/\b(annul|cancel|retrait|rembours)\b/.test(t)) {
    return {
      reponse_client:
        "ℹ️ Pour une demande d'annulation ou de remboursement, contactez notre équipe avec votre <b>numéro d'ordre</b> et <b>Transfer ID</b>.\n\n— <i>Support Kaffi-Pay</i>",
      decision: "escalade", action_prise: "Demande annulation/remboursement — escalade",
      niveau_urgence: "moyen", resume_audit: "Client demande annulation ou remboursement",
    };
  }

  // ── Transfer ID fourni → escalade admin ──────────────────────
  if (hasTransferId && (orders.length > 0 || session.phone)) {
    return {
      reponse_client:
        "Merci pour ces informations. Votre demande a été transmise à notre équipe pour vérification.\n\n" +
        "Nous vous répondrons dans les plus brefs délais.\n\n— <i>Support Kaffi-Pay</i>",
      decision: "escalade", action_prise: "Transfer ID reçu — escalade vers admin",
      niveau_urgence: "moyen",
      resume_audit: "Client a fourni Transfer ID ou infos paiement — vérification manuelle requise",
    };
  }

  // ── Numéro d'ordre fourni ────────────────────────────────────
  if (ordreNum) {
    if (!session.phone) {
      return {
        reponse_client:
          `Pour vérifier l'ordre <b>#${ordreNum}</b>, merci d'indiquer votre ` +
          "<b>numéro Waafi</b> (8 chiffres, ex: <code>77123456</code>).\n\n— <i>Support Kaffi-Pay</i>",
        decision: "info_manquante", action_prise: "Numéro Waafi requis pour vérification",
        niveau_urgence: "faible", resume_audit: `Ordre #${ordreNum} donné sans numéro Waafi`,
      };
    }

    const ligne = orders.find((o) => o.includes(`#${ordreNum}`));

    if (!ligne) {
      return {
        reponse_client:
          `L'ordre <b>#${ordreNum}</b> est introuvable pour votre numéro.\n\n` +
          "Vérifiez le numéro d'ordre (6 à 8 chiffres, visible sur kaffi-pay.com).\n\n" +
          "— <i>Support Kaffi-Pay</i>",
        decision: "info_manquante", action_prise: "Ordre introuvable pour ce numéro",
        niveau_urgence: "faible",
        resume_audit: `Ordre #${ordreNum} introuvable pour ${session.phone}`,
      };
    }

    // Statut : Confirmé
    if (ligne.includes("| Confirmé")) {
      return {
        reponse_client:
          `✅ Votre ordre <b>#${ordreNum}</b> est <b>confirmé</b>. ` +
          "Votre compte 1xBet a bien été crédité.\n\n— <i>Support Kaffi-Pay</i>",
        decision: "résolu", action_prise: "Statut Confirmé communiqué",
        niveau_urgence: "faible", resume_audit: `Ordre #${ordreNum} confirmé — client informé`,
      };
    }

    // Statut : Argent Reçu
    if (ligne.includes("| Argent Reçu")) {
      return {
        reponse_client:
          `💳 Votre ordre <b>#${ordreNum}</b> : paiement <b>reçu</b>, crédit 1xBet en cours.\n\n` +
          "Confirmation sous quelques minutes.\n\n— <i>Support Kaffi-Pay</i>",
        decision: "résolu", action_prise: "Statut Argent Reçu communiqué",
        niveau_urgence: "faible", resume_audit: `Ordre #${ordreNum} argent reçu — crédit en cours`,
      };
    }

    // Statut : En attente
    if (ligne.includes("| En attente")) {
      return {
        reponse_client:
          `⏳ Votre ordre <b>#${ordreNum}</b> est <b>en cours de traitement</b>.\n\n` +
          "Vous serez notifié automatiquement dès confirmation.\n\n— <i>Support Kaffi-Pay</i>",
        decision: "résolu", action_prise: "Statut En attente communiqué",
        niveau_urgence: "faible", resume_audit: `Ordre #${ordreNum} en attente — client informé`,
      };
    }

    // Statut : Correction
    if (ligne.includes("| Correction")) {
      return {
        reponse_client:
          `✏️ Votre ordre <b>#${ordreNum}</b> est en <b>vérification</b> par notre équipe.\n\n` +
          "Nous reviendrons vers vous sous peu.\n\n— <i>Support Kaffi-Pay</i>",
        decision: "escalade", action_prise: "Statut Correction — escalade signalée",
        niveau_urgence: "moyen", resume_audit: `Ordre #${ordreNum} en correction — admin notifié`,
      };
    }

    // Statut : Rejeté
    if (ligne.includes("| Rejeté")) {
      const nonRecu = ligne.toLowerCase().includes("paiement non re") ||
                      ligne.toLowerCase().includes("introuvable");
      const fraude  = ligne.toLowerCase().includes("fraude");

      if (fraude) {
        return {
          reponse_client:
            "❌ Votre ordre a été rejeté pour raison de sécurité.\n\n" +
            "Si vous pensez qu'il s'agit d'une erreur, envoyez :\n" +
            "• <b>Transfer ID Waafi</b>\n• <b>Montant payé</b>\n• <b>N° expéditeur</b>\n\n" +
            "— <i>Support Kaffi-Pay</i>",
          decision: "fraude_signalée", action_prise: "Fraude — client demande explication",
          niveau_urgence: "élevé",
          resume_audit: `Ordre #${ordreNum} rejeté fraude — client a contacté support`,
        };
      }

      if (nonRecu) {
        return {
          reponse_client:
            `❌ Votre ordre <b>#${ordreNum}</b> est rejeté : <b>Paiement non reçu</b>.\n\n` +
            "<b>Causes possibles :</b>\n" +
            "• Transfer ID incorrect ou non reçu par Kaffi-Pay\n" +
            "• Montant ou numéro expéditeur différent\n" +
            "• Paiement effectué après soumission de l'ordre\n\n" +
            "Pour correction, envoyez :\n" +
            "📌 <b>Transfer ID Waafi</b>\n" +
            "📌 <b>Montant payé (DJF)</b>\n" +
            "📌 <b>Numéro Waafi expéditeur</b>\n\n" +
            "— <i>Support Kaffi-Pay</i>",
          decision: "info_manquante",
          action_prise: "Rejeté paiement non reçu — demande Transfer ID + infos",
          niveau_urgence: "moyen",
          resume_audit: `Ordre #${ordreNum} rejeté paiement non reçu — infos demandées`,
        };
      }

      return {
        reponse_client:
          `❌ Votre ordre <b>#${ordreNum}</b> a été <b>rejeté</b>.\n\n` +
          "Pour plus d'informations, envoyez votre Transfer ID Waafi.\n\n— <i>Support Kaffi-Pay</i>",
        decision: "info_manquante", action_prise: "Rejeté — Transfer ID demandé",
        niveau_urgence: "moyen", resume_audit: `Ordre #${ordreNum} rejeté — client informé`,
      };
    }
  }

  // ── Salutation ───────────────────────────────────────────────
  if (isGreeting) {
    const suite = session.phone
      ? "Que puis-je faire pour vous ?\n\nIndiquez votre <b>numéro d'ordre</b> pour le suivi."
      : "Pour vous aider, indiquez votre <b>numéro d'ordre</b> (ex : <code>2606061</code>).";
    return {
      reponse_client: `Bonjour ! Je suis le support Kaffi-Pay.\n\n${suite}\n\n— <i>Support Kaffi-Pay</i>`,
      decision: "info_manquante", action_prise: "Salutation",
      niveau_urgence: "faible", resume_audit: "Client a salué",
    };
  }

  // ── Fallback ─────────────────────────────────────────────────
  return {
    reponse_client:
      "Bonjour ! Pour vous aider, indiquez votre <b>numéro d'ordre</b> (ex : <code>2606061</code>).\n\n" +
      "— <i>Support Kaffi-Pay</i>",
    decision: "info_manquante", action_prise: "Message non reconnu — demande numéro d'ordre",
    niveau_urgence: "faible", resume_audit: "Message non reconnu — fallback",
  };
}

// ══════════════════════════════════════════════════════════════════
// ADMIN BOT — logique pure (requêtes statiques)
// ══════════════════════════════════════════════════════════════════
function traiterAdminBot(text, orders, notifs) {
  const t = text.toLowerCase().trim();

  function parseMontant(ligne) {
    const m = ligne.match(/\|\s*([\d\s]+)\s*DJF/);
    return m ? parseFloat(m[1].replace(/\s/g, "")) || 0 : 0;
  }

  const ordreNum = (text.match(/(?:#\s*)?(\d{6,8})\b/) || [])[1] || null;

  // stats
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

  // ordres à traiter
  if (/^\/ordres?$/.test(t) || t === "ordres" || /\b(attente|pending)\b/.test(t)) {
    const aTraiter = orders.filter((o) =>
      o.includes("| En attente") || o.includes("| Argent Reçu")
    );
    if (!aTraiter.length) return "✅ Aucun ordre en attente.";
    return (
      `⏳ <b>Ordres à traiter (${aTraiter.length})</b>\n\n${aTraiter.join("\n")}\n\n` +
      "<i>confirmer #ID | rejeter #ID raison</i>"
    );
  }

  // fraudes
  if (/^\/fraudes?$/.test(t) || t === "fraudes" || t === "fraude") {
    const fraudes = orders.filter((o) => o.toLowerCase().includes("fraude"));
    if (!fraudes.length) return "✅ Aucune fraude récente.";
    return `🚨 <b>Fraudes (${fraudes.length})</b>\n\n${fraudes.join("\n")}`;
  }

  // rejetés
  if (/^\/rejet/.test(t) || t === "rejetés" || t === "rejetes") {
    const rejetes = orders.filter((o) => o.includes("| Rejeté"));
    if (!rejetes.length) return "✅ Aucun ordre rejeté récemment.";
    return `❌ <b>Rejetés (${rejetes.length})</b>\n\n${rejetes.join("\n")}`;
  }

  // sms / waafi
  if (/^\/sms$/.test(t) || /\b(sms|waafi|notif)\b/.test(t)) {
    if (!notifs.length) return "📭 Aucun SMS Waafi reçu récemment.";
    return `📩 <b>Derniers SMS Waafi (${notifs.length})</b>\n\n${notifs.join("\n")}`;
  }

  // recherche par numéro d'ordre
  if (ordreNum) {
    const ligne = orders.find((o) => o.includes(`#${ordreNum}`));
    if (ligne) {
      return (
        `🔍 <b>Ordre #${ordreNum}</b>\n\n${ligne}\n\n` +
        `<i>Actions : confirmer ${ordreNum} | rejeter ${ordreNum} [raison]</i>`
      );
    }
    return (
      `❓ Ordre <b>#${ordreNum}</b> introuvable dans les 20 derniers.\n` +
      "<i>Essayez : client 77XXXXXXX</i>"
    );
  }

  // menu aide
  return (
    "🤖 <b>Commandes disponibles</b>\n\n" +
    "📊 <code>stats</code> — Statistiques complètes\n" +
    "⏳ <code>ordres</code> — À traiter\n" +
    "🚨 <code>fraudes</code> — Fraudes détectées\n" +
    "❌ <code>rejetés</code> — Ordres rejetés\n" +
    "📩 <code>sms</code> — Derniers SMS Waafi\n" +
    "🔍 <code>#2606061</code> — Détails d'un ordre\n" +
    "👤 <code>client 77123456</code> — Ordres d'un client\n" +
    "⚠️ <code>alerte</code> — En attente > 30 min\n" +
    "📭 <code>nonmatche</code> — SMS sans correspondance\n" +
    "✅ <code>confirmer 2606061</code> — Confirmer\n" +
    "❌ <code>rejeter 2606061 raison</code> — Rejeter"
  );
}

// ── Helpers Telegram ──────────────────────────────────────────────

async function sendTelegramToBot(token, chatId, text, opts = {}) {
  if (!token || !chatId) return false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...opts }),
      signal:  AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      console.warn("sendTelegramToBot error:", resp.status, (await resp.text()).substring(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.warn("sendTelegramToBot failed:", e.message);
    return false;
  }
}

async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal:  AbortSignal.timeout(8000),
    });
    if (!resp.ok) console.warn("Telegram error:", resp.status, (await resp.text()).substring(0, 200));
  } catch (e) {
    console.warn("Telegram send failed:", e.message);
  }
}

async function claimOrder(docRef, expectedStatus, newStatus, extraFields = {}) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists || snap.data().status !== expectedStatus) return false;
    tx.update(docRef, { status: newStatus, ...extraFields });
    return true;
  });
}

function extractTransferId(text) {
  const m = text.match(/Transfer-?Id[:\s]+(\d+)/i);
  return m ? m[1].trim() : null;
}

function extractMontant(text) {
  const m =
    text.match(/Received\s+DJF\s+([\d,]+)/i) ||
    text.match(/transferred\s+DJF\s+([\d,]+)/i) ||
    text.match(/DJF\s*([\d,]+)/i);
  if (!m) return null;
  const val = parseFloat(m[1].replace(/,(?=\d{3})/g, "").replace(",", "."));
  return isNaN(val) ? null : val;
}

function extractNumClient(text, ownNumber = "77275572") {
  const matches = (text.match(/\((\d{8})\)/g) || []).map((s) => s.replace(/[()]/g, ""));
  const others  = matches.filter((n) => n !== ownNumber);
  if (others.length > 0) return others[0];
  const m = text.match(/from\s+(77\d{6})/i) || text.match(/de\s+(77\d{6})/i);
  return m ? m[1] : (matches[0] || null);
}

// ══════════════════════════════════════════════════════════════════
// 1. NOUVEL ORDRE → Fraude + Doublons + Alerte admin
// ══════════════════════════════════════════════════════════════════
exports.onNouvelOrdre = onDocumentCreated(
  {
    document: "orders/{docId}",
    region:   REGION,
    secrets:  [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID],
    timeoutSeconds: 60,
  },
  async (event) => {
    const tx         = event.data.data();
    const docId      = event.params.docId;
    const ref        = tx.orderId || tx.ref || docId;
    const transferId = tx.waafitranfertID || tx.hash || "";
    const isDepot    = tx.type === "Dépôt";

    // ── Fraude : Transfer ID déjà confirmé ───────────────────────
    if (transferId) {
      const confirmeSnap = await db.collection("orders")
        .where("waafitranfertID", "==", transferId)
        .where("status", "==", "Confirmé")
        .limit(1).get();

      if (!confirmeSnap.empty) {
        const ancienRef = confirmeSnap.docs[0].data().orderId || confirmeSnap.docs[0].id;
        await db.collection("orders").doc(docId).update({
          status: "Rejeté",
          flagRaison: `FRAUDE — Transfer ID ${transferId} déjà utilisé dans l'ordre confirmé #${ancienRef}`,
          flaggedAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
          `🚨 <b>FRAUDE détectée</b>\n\nOrdre <code>#${ref}</code> rejeté.\n` +
          `Transfer-ID <code>${transferId}</code> déjà utilisé dans <code>#${ancienRef}</code>.\n` +
          `⚠️ Tentative de réutilisation d'un ancien paiement.`
        );
        return;
      }

      const waafiMatcheSnap = await db.collection("waafi_notifications")
        .where("transferId", "==", transferId)
        .where("status", "==", "matché")
        .limit(1).get();

      if (!waafiMatcheSnap.empty) {
        const ancienWaafi = waafiMatcheSnap.docs[0].data();
        await db.collection("orders").doc(docId).update({
          status: "Rejeté",
          flagRaison: `FRAUDE — Transfer ID ${transferId} déjà matché avec #${ancienWaafi.ordreRef || "?"}`,
          flaggedAt: FieldValue.serverTimestamp(),
        });
        await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
          `🚨 <b>FRAUDE détectée</b>\n\nTransfer-ID <code>${transferId}</code> déjà utilisé\n` +
          `pour l'ordre <code>#${ancienWaafi.ordreRef || "?"}</code>.\n⚠️ Paiement Waafi réutilisé.`
        );
        return;
      }
    }

    // ── Dépôt : vérification Transfer ID ────────────────────────
    if (isDepot) {
      const montantOrdre = Number(tx.montant || 0);
      let waafiDoc = null, waafiData = null;

      if (transferId) {
        const snap = await db.collection("waafi_notifications")
          .where("transferId", "==", transferId)
          .where("status", "==", "nouveau")
          .limit(1).get();
        if (!snap.empty) { waafiDoc = snap.docs[0]; waafiData = waafiDoc.data(); }
      }

      if (waafiDoc) {
        const montantReel = waafiData.montant  || montantOrdre;
        const numReel     = waafiData.numClient || tx.numeroPayment || "";
        const corrections = [];
        if (waafiData.montant && Math.abs(montantOrdre - waafiData.montant) > 1)
          corrections.push(`Montant corrigé: ${montantOrdre} → ${waafiData.montant} DJF`);
        if (waafiData.numClient && tx.numeroPayment && waafiData.numClient !== tx.numeroPayment)
          corrections.push(`N° corrigé: ${tx.numeroPayment} → ${waafiData.numClient}`);

        const claimed = await claimOrder(
          db.collection("orders").doc(docId), "En attente", "Confirmé",
          {
            confirmedBy: "auto_transfer_id", montant: montantReel, montantRecu: montantReel,
            numeroPayment: numReel, expediteurRecu: numReel,
            correctionApplied: corrections.length > 0, corrections,
            confirmedAt: FieldValue.serverTimestamp(),
          }
        );
        if (claimed) {
          await waafiDoc.ref.update({ status: "matché", ordreRef: ref });
          await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
            `✅ <b>Dépôt confirmé</b>${corrections.length ? " ✏️" : ""}\n\n` +
            `Réf: <b>#${ref}</b>\nMontant: <b>${Number(montantReel).toLocaleString()} DJF</b>\n` +
            `ID 1xBet: <code>${tx.userId1xBet || "?"}</code>\n` +
            `Transfer-ID: <code>${transferId}</code>\nExpéditeur: <code>${numReel}</code>` +
            (corrections.length ? `\n✏️ <i>${corrections.join(" | ")}</i>` : "") +
            `\n\n🤖 Confirmation automatique`
          );
          return;
        }
      }

      await db.collection("orders").doc(docId).update({
        status: "Rejeté",
        flagRaison: `Paiement non reçu — Transfer ID ${transferId || "(non fourni)"} introuvable`,
        flaggedAt: FieldValue.serverTimestamp(),
      });
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `❌ <b>Ordre rejeté — Paiement non reçu</b>\n\nRéf: <code>#${ref}</code>\n` +
        `Transfer-ID: <code>${transferId || "non fourni"}</code>\n` +
        `Montant: <b>${montantOrdre.toLocaleString()} DJF</b>\n` +
        `ID 1xBet: <code>${tx.userId1xBet || "?"}</code>\n⚠️ Aucun paiement Waafi avec ce Transfer ID.`
      );
      return;
    }

    // ── Analyse fraude règles embarquées ─────────────────────────
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
        `🚨 <b>Ordre rejeté — Fraude détectée</b>\nRéf: <code>#${ref}</code>\n` +
        `Score: ${fraud.score_fraude}/100 — ${fraud.risque.toUpperCase()}\n` +
        `Raisons: ${fraud.raisons.join(", ")}`
      );
      return;
    }

    const details = isDepot
      ? `ID 1xBet: <code>${tx.userId1xBet || "?"}</code>\nTransfer ID: <code>${transferId || "?"}</code>\nExpéditeur: <code>${tx.numeroPayment || "?"}</code>`
      : `Code retrait: <code>${tx.withdrawalCode || "?"}</code>\nN° Waafi: <code>${tx.waafiNumber || "?"}</code>`;

    await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
      `${isDepot ? "📥" : "📤"} <b>Nouvel ordre ${tx.type}</b>\n\n` +
      `Réf: <b>#${ref}</b>\nMontant: <b>${Number(tx.montant).toLocaleString()} DJF</b>\n` +
      `${details}\n\nRisque: <i>${fraud.risque} (${fraud.score_fraude}/100)</i>`
    );
  }
);

// ══════════════════════════════════════════════════════════════════
// 2. ORDRE MIS À JOUR → Notification admin
// ══════════════════════════════════════════════════════════════════
exports.onOrdreUpdated = onDocumentUpdated(
  { document: "orders/{docId}", region: REGION, secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID] },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;

    const ref     = after.orderId || after.ref || event.params.docId;
    const montant = Number(after.montant || 0).toLocaleString();
    const type    = after.type || "Ordre";

    let msg = "";
    if (after.status === "Confirmé")
      msg = `✅ <b>${type} confirmé</b>\n#${ref} — ${montant} DJF\n` +
            (after.confirmedBy === "admin_telegram" ? "👤 Confirmé via bot admin"
              : after.confirmedBy === "auto_waafi_sms" ? "🤖 Auto-confirmation SMS"
              : "👤 Confirmé manuellement");
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
// 3. ANALYSE ADMIN — stats Firestore temps réel
// ══════════════════════════════════════════════════════════════════
exports.geminiAnalyseAdmin = onCall(
  { region: REGION, secrets: [] },
  async () => {
    const snap    = await db.collection("orders").orderBy("ts", "desc").limit(100).get();
    const txs     = snap.docs.map((d) => d.data());
    const conf    = txs.filter((t) => t.status === "Confirmé");
    const att     = txs.filter((t) => t.status === "En attente");
    const rej     = txs.filter((t) => t.status === "Rejeté");
    const fraudes = txs.filter((t) => t.flagRaison && t.flagRaison.toUpperCase().includes("FRAUDE"));
    const volume  = conf.reduce((s, t) => s + Number(t.montant || 0), 0);
    const taux    = txs.length ? Math.round(conf.length / txs.length * 100) : 0;
    const moy     = conf.length ? Math.round(volume / conf.length) : 0;

    let alerte = null;
    if (att.length > 10)               alerte = `${att.length} ordres en attente — vérification requise`;
    else if (fraudes.length > 3)       alerte = `${fraudes.length} fraudes détectées parmi les 100 dernières`;
    else if (taux < 50 && txs.length > 10) alerte = `Taux de confirmation faible : ${taux}%`;

    return {
      success: true,
      data: {
        resume:            `${conf.length} confirmés sur ${txs.length} — ${volume.toLocaleString()} DJF. Taux: ${taux}%.`,
        alerte,
        conseil:           att.length > 5 ? "Vérifier les ordres en attente" : "Opérations normales",
        prediction_demain: moy * Math.max(conf.length, 1),
        score_sante:       Math.max(0, Math.min(100, taux - fraudes.length * 10)),
      },
      stats: { confirmes: conf.length, attente: att.length, rejetes: rej.length, volume },
    };
  }
);

// ══════════════════════════════════════════════════════════════════
// 5. AUTO-CONFIRMATION — SMS Waafi → Confirme l'ordre + Webhook
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

    const notification = sms.notification || sms.not_body || sms.message || sms.texte || sms.body || sms.text || "";
    const transferId   = extractTransferId(notification);
    const montantSMS   = extractMontant(notification);
    const numClient    = extractNumClient(notification);

    console.log(`SMS Waafi → TransferID: ${transferId}, Montant: ${montantSMS} DJF, N°: ${numClient}`);

    if (!transferId && !montantSMS) {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "erreur_parsing", erreurMsg: "Impossible d'extraire Transfer ID ou Montant",
      });
      return;
    }

    let ordreSnap = { empty: true };
    if (transferId) {
      ordreSnap = await db.collection("orders")
        .where("waafitranfertID", "==", transferId).where("status", "==", "En attente").limit(1).get();
    }
    if (ordreSnap.empty && numClient && montantSMS) {
      ordreSnap = await db.collection("orders")
        .where("numeroPayment", "==", numClient).where("montant", "==", montantSMS).where("status", "==", "En attente").limit(1).get();
    }

    if (ordreSnap.empty) {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "non_matché", erreurMsg: `Aucun ordre — TID: ${transferId}, Montant: ${montantSMS}`,
      });
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>SMS Waafi sans correspondance</b>\n\nTransfer-ID: <code>${transferId || "?"}</code>\n` +
        `Montant: <b>${montantSMS ? montantSMS.toLocaleString() : "?"} DJF</b>\n` +
        `Expéditeur: <code>${numClient || "?"}</code>\n\n<i>Vérifiez les ordres en attente.</i>`
      );
      return;
    }

    const ordreDoc     = ordreSnap.docs[0];
    const ordre        = ordreDoc.data();
    const ordreRef     = ordre.orderId || ordre.ref || ordreDoc.id;
    const montantOrdre = Number(ordre.montant || 0);
    const mt           = montantSMS || montantOrdre;

    if (montantSMS && Math.abs(montantOrdre - montantSMS) > 5) {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "montant_incorrect",
        erreurMsg: `SMS (${montantSMS}) ≠ Ordre (${montantOrdre})`, ordreRef,
      });
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>Montant incorrect</b> pour #${ordreRef}\n` +
        `SMS: ${montantSMS} DJF / Ordre: ${montantOrdre} DJF\nVérification manuelle requise.`
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

    const id1xbet = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";
    if (id1xbet) {
      const webhookBase = MACRO_WEBHOOK_URL.value() ||
        "https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet";
      try {
        const url  = `${webhookBase}?id1xbet=${encodeURIComponent(id1xbet)}&montant=${encodeURIComponent(mt)}&ref=${encodeURIComponent(ordreRef)}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
        await ordreDoc.ref.update({ webhookStatus: resp.ok ? "ok" : "erreur_" + resp.status, webhookAt: FieldValue.serverTimestamp() });
        if (!resp.ok)
          await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
            `⚠️ <b>Webhook échoué</b> — Ordre #${ordreRef} HTTP ${resp.status}\n` +
            `ID 1xBet: <code>${id1xbet}</code> — <b>Recharge manuelle requise.</b>`
          );
      } catch (e) {
        await ordreDoc.ref.update({ webhookStatus: "erreur_timeout" });
        await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
          `⚠️ <b>MacroDroid injoignable</b> — Ordre #${ordreRef}\n` +
          `ID 1xBet: <code>${id1xbet}</code> — <b>Recharge manuelle requise.</b>`
        );
      }
    } else {
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>ID 1xBet manquant</b> — Ordre #${ordreRef}\n${Number(mt).toLocaleString()} DJF reçu — <b>Recharge manuelle requise.</b>`
      );
    }

    await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
      `✅ <b>Dépôt auto-confirmé</b>\n#${ordreRef} — ${Number(mt).toLocaleString()} DJF\n` +
      `ID 1xBet: <code>${id1xbet || "?"}</code>\n` +
      (transferId ? `Transfer-ID: <code>${transferId}</code>` : "")
    );
  }
);

// ══════════════════════════════════════════════════════════════════
// 6. WEBHOOK MACRODROID
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

    const transferIdParsed = extractTransferId(notif);
    const montantParsed    = extractMontant(notif);
    const numClientParsed  = extractNumClient(notif);

    const docRef = await db.collection("waafi_notifications").add({
      notification: notif, transferId: transferIdParsed, montant: montantParsed,
      numClient: numClientParsed, secret: expectedSecret,
      source: "macrodroid", status: "nouveau", createdAt: FieldValue.serverTimestamp(),
    });

    await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
      `📩 <b>SMS Waafi reçu</b>\n\nTransfer-ID: <code>${transferIdParsed || "?"}</code>\n` +
      `Montant: <b>${montantParsed ? Number(montantParsed).toLocaleString() : "?"} DJF</b>\n` +
      `Expéditeur: <code>${numClientParsed || "?"}</code>\n\n<i>Traitement auto en cours…</i>`
    );

    res.json({ success: true, id: docRef.id });
  }
);

// ══════════════════════════════════════════════════════════════════
// 7. HEALTH CHECK
// ══════════════════════════════════════════════════════════════════
exports.healthCheck = onRequest(
  { region: REGION, secrets: [] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const t0 = Date.now();
    let firestoreMs = "?", status = "ok";
    try {
      await db.collection("orders").limit(1).get();
      firestoreMs = `${Date.now() - t0}ms`;
    } catch (e) {
      firestoreMs = `erreur: ${e.message}`; status = "erreur";
    }

    res.json({ status, timestamp: new Date().toISOString(), region: REGION, firestore: firestoreMs, ai: "logique embarquée", version: "3.6" });
  }
);

// ══════════════════════════════════════════════════════════════════
// 8. SUPPORT CLIENT — arbre décision + audit admin
// ══════════════════════════════════════════════════════════════════
exports.supportClient = onRequest(
  { region: REGION, secrets: [SUPPORT_BOT_TOKEN, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID], timeoutSeconds: 60 },
  async (req, res) => {
    res.status(200).send("OK");
    try {
      const update = req.body || {};
      const msg    = update.message || update.edited_message;
      if (!msg) return;

      const chatId    = msg.chat.id;
      const text      = (msg.text || "").trim();
      const fromUser  = msg.from || {};
      const firstName = fromUser.first_name || "Client";

      if (!text) return;

      const supportToken = SUPPORT_BOT_TOKEN.value();
      if (!supportToken) { console.error("SUPPORT_BOT_TOKEN vide"); return; }

      // ── Session ───────────────────────────────────────────────
      const sessionRef  = db.collection("support_sessions").doc(String(chatId));
      const sessionSnap = await sessionRef.get();
      const session     = sessionSnap.exists ? sessionSnap.data() : {};

      const cleanText = text.replace(/\s/g, "");
      const isPhone   = /^(77|78|70|71|21)\d{6}$/.test(cleanText);
      if (isPhone && !session.phone) {
        await sessionRef.set({ phone: cleanText, chatId, startedAt: FieldValue.serverTimestamp() }, { merge: true });
        session.phone = cleanText;
      }

      // Extraire numéro d'ordre du message pour session
      const ordreInMsg = (text.match(/(?:#\s*)?(\d{6,8})\b/i) || [])[1] || null;
      if (ordreInMsg) {
        await sessionRef.set({ lastOrder: ordreInMsg }, { merge: true });
      }

      // ── Historique ordres ─────────────────────────────────────
      let orders = [];
      if (session.phone) {
        try {
          const snap = await db.collection("orders")
            .where("numeroPayment", "==", session.phone)
            .orderBy("ts", "desc").limit(10).get();
          orders = snap.docs.map((d) => {
            const o = d.data();
            return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status} | ${o.flagRaison || ""}`;
          });
        } catch {
          try {
            const snap = await db.collection("orders")
              .where("numeroPayment", "==", session.phone).limit(10).get();
            orders = snap.docs.map((d) => {
              const o = d.data();
              return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status} | ${o.flagRaison || ""}`;
            });
          } catch (e2) { console.warn("Fallback ordres échoué:", e2.message); }
        }
      }

      // Cherche aussi par orderId directement (si numéro d'ordre fourni sans phone)
      if (ordreInMsg && !session.phone && orders.length === 0) {
        try {
          const snap = await db.collection("orders").where("orderId", "==", ordreInMsg).limit(1).get();
          if (!snap.empty) {
            const o = snap.docs[0].data();
            orders = [`• #${o.orderId || snap.docs[0].id} | ${o.type} | ${o.montant} DJF | ${o.status} | ${o.flagRaison || ""}`];
          }
        } catch { /* ignore */ }
      }

      // ── Décision logique embarquée ────────────────────────────
      const aiDecision = repondreSupport(text, session, orders);

      await sendTelegramToBot(supportToken, chatId, aiDecision.reponse_client);

      await db.collection("support_sessions").doc(String(chatId)).collection("messages").add({
        text, decision: aiDecision.decision, action: aiDecision.action_prise,
        urgence: aiDecision.niveau_urgence, ts: FieldValue.serverTimestamp(),
      });

      const urgEmoji = { faible: "🟢", moyen: "🟡", "élevé": "🔴" }[aiDecision.niveau_urgence] || "⚪";
      const decEmoji = { résolu: "✅", escalade: "🆘", info_manquante: "❓", fraude_signalée: "🚨" }[aiDecision.decision] || "ℹ️";

      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(),
        `${urgEmoji} <b>Support Client</b> ${decEmoji}\n\n` +
        `👤 ${firstName} | <code>${session.phone || "Non renseigné"}</code>\n` +
        `💬 <i>"${text.substring(0, 100)}"</i>\n\n` +
        `🤖 <b>Décision :</b> ${aiDecision.decision.toUpperCase()}\n` +
        `⚡ ${aiDecision.action_prise}\n\n📋 ${aiDecision.resume_audit}` +
        (aiDecision.decision === "escalade" ? "\n\n⚠️ <b>Intervention manuelle requise.</b>" : "")
      );
    } catch (e) {
      console.error("supportClient crash:", e.message, e.stack);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// 9. BOT ADMIN — actions Firestore + requêtes avancées
// ══════════════════════════════════════════════════════════════════
exports.adminBot = onRequest(
  { region: REGION, secrets: [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID], timeoutSeconds: 60 },
  async (req, res) => {
    res.status(200).send("OK");
    try {
      const update = req.body || {};
      const msg    = update.message || update.edited_message;
      if (!msg) return;

      const chatId  = String(msg.chat.id);
      const text    = (msg.text || "").trim();
      const adminId = String(TELEGRAM_ADMIN_ID.value());
      const token   = TELEGRAM_TOKEN.value();

      if (chatId !== adminId) { console.warn(`adminBot: accès refusé ${chatId}`); return; }
      if (!text) return;
      console.log(`adminBot: "${text}"`);

      const t = text.toLowerCase().trim();

      // ── ACTION : confirmer #ID ────────────────────────────────
      const confirmMatch = text.match(/^confirmer?\s+#?(\d{6,8})\b/i);
      if (confirmMatch) {
        const num  = confirmMatch[1];
        const snap = await db.collection("orders").where("orderId", "==", num).limit(1).get();
        if (snap.empty) {
          await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`);
        } else {
          const doc  = snap.docs[0];
          const data = doc.data();
          if (data.status === "Confirmé") {
            await sendTelegram(token, adminId, `ℹ️ Ordre <b>#${num}</b> est déjà confirmé.`);
          } else {
            await doc.ref.update({ status: "Confirmé", confirmedBy: "admin_telegram", confirmedAt: FieldValue.serverTimestamp() });
            await sendTelegram(token, adminId,
              `✅ Ordre <b>#${num}</b> confirmé manuellement.\n` +
              `Client: <code>${data.numeroPayment || "?"}</code> | ${Number(data.montant || 0).toLocaleString()} DJF`
            );
          }
        }
        return;
      }

      // ── ACTION : rejeter #ID [raison] ─────────────────────────
      const rejectMatch = text.match(/^rejeter?\s+#?(\d{6,8})(?:\s+(.+))?$/i);
      if (rejectMatch) {
        const num    = rejectMatch[1];
        const raison = (rejectMatch[2] || "Rejeté par admin").trim();
        const snap   = await db.collection("orders").where("orderId", "==", num).limit(1).get();
        if (snap.empty) {
          await sendTelegram(token, adminId, `❓ Ordre <b>#${num}</b> introuvable.`);
        } else {
          const doc = snap.docs[0];
          if (doc.data().status === "Rejeté") {
            await sendTelegram(token, adminId, `ℹ️ Ordre <b>#${num}</b> est déjà rejeté.`);
          } else {
            await doc.ref.update({ status: "Rejeté", flagRaison: raison, rejectedBy: "admin_telegram", flaggedAt: FieldValue.serverTimestamp() });
            await sendTelegram(token, adminId, `❌ Ordre <b>#${num}</b> rejeté.\nRaison : <i>${raison}</i>`);
          }
        }
        return;
      }

      // ── QUERY : client 77XXXXXXX ──────────────────────────────
      const clientMatch = text.match(/^client\s+((?:77|78|70|71|21)\d{6})\b/i);
      if (clientMatch) {
        const phone = clientMatch[1];
        const snap  = await db.collection("orders")
          .where("numeroPayment", "==", phone)
          .orderBy("ts", "desc").limit(10)
          .get().catch(() => db.collection("orders").where("numeroPayment", "==", phone).limit(10).get());
        if (snap.empty) {
          await sendTelegram(token, adminId, `❓ Aucun ordre trouvé pour <code>${phone}</code>.`);
        } else {
          const lignes = snap.docs.map((d) => {
            const o = d.data();
            return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status}`;
          });
          await sendTelegram(token, adminId,
            `👤 <b>Ordres du client <code>${phone}</code> (${snap.size})</b>\n\n${lignes.join("\n")}`
          );
        }
        return;
      }

      // ── QUERY : alerte (en attente > 30 min) ─────────────────
      if (t === "alerte" || t === "alertes" || t === "/alerte") {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000);
        const snap   = await db.collection("orders")
          .where("status", "==", "En attente")
          .orderBy("ts", "asc").get()
          .catch(() => db.collection("orders").where("status", "==", "En attente").get());
        const vieux  = snap.docs.filter((d) => {
          const ts = d.data().ts;
          if (!ts) return false;
          return (ts.toDate ? ts.toDate() : new Date(ts)) < cutoff;
        });
        if (!vieux.length) {
          await sendTelegram(token, adminId, "✅ Aucun ordre en attente > 30 minutes.");
        } else {
          const lignes = vieux.map((d) => {
            const o   = d.data();
            const age = Math.round((Date.now() - (o.ts.toDate ? o.ts.toDate() : new Date(o.ts)).getTime()) / 60000);
            return `• #${o.orderId || d.id} | ${o.montant} DJF | ⏱ ${age}min | N°${o.numeroPayment || "?"}`;
          });
          await sendTelegram(token, adminId,
            `⚠️ <b>En attente > 30min (${vieux.length})</b>\n\n${lignes.join("\n")}\n\n` +
            "<i>confirmer #ID | rejeter #ID raison</i>"
          );
        }
        return;
      }

      // ── QUERY : nonmatche (SMS sans correspondance) ───────────
      if (t === "nonmatche" || t === "non_matché" || t === "/nonmatche") {
        const snap = await db.collection("waafi_notifications")
          .where("status", "==", "non_matché")
          .orderBy("createdAt", "desc").limit(10)
          .get().catch(() => db.collection("waafi_notifications").where("status", "==", "non_matché").limit(10).get());
        if (snap.empty) {
          await sendTelegram(token, adminId, "✅ Aucun SMS sans correspondance.");
        } else {
          const lignes = snap.docs.map((d) => {
            const n = d.data();
            return `• TID:${n.transferId || "?"} | ${n.montant || "?"}DJF | N°${n.numClient || "?"} | ${n.erreurMsg || ""}`;
          });
          await sendTelegram(token, adminId,
            `📭 <b>SMS sans correspondance (${snap.size})</b>\n\n${lignes.join("\n")}`
          );
        }
        return;
      }

      // ── Requêtes statiques via fonction pure ──────────────────
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
        return `• TID:${n.transferId || "?"} | ${n.montant || "?"}DJF | N°${n.numClient || "?"} | ${n.status || "?"}`;
      });

      await sendTelegram(token, adminId, traiterAdminBot(text, orders, notifs));

    } catch (e) {
      console.error("adminBot crash:", e.message, e.stack);
    }
  }
);
