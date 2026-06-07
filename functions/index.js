/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           KAFFI PAY — CLOUD FUNCTIONS v3.5                      ║
 * ║  • Confirmation automatique dépôts (Transfer ID)                ║
 * ║  • Fraude permanente (Transfer ID réutilisé)                    ║
 * ║  • Notifications Telegram admin                                 ║
 * ║  • Support client Telegram (logique embarquée)                  ║
 * ║  • Analyse admin (stats Firestore temps réel)                   ║
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

// ── Détection fraude — règles pures, pas d'IA ─────────────────────
function analyserFraude(tx, transferId) {
  const raisons = [];
  let score     = 0;

  const montant = Number(tx.montant || 0);
  const num     = (tx.numeroPayment || "").replace(/\s/g, "");

  if (montant > 100000)      { score += 40; raisons.push("Montant très élevé (> 100 000 DJF)"); }
  else if (montant > 50000)  { score += 20; raisons.push("Montant élevé (> 50 000 DJF)"); }

  if (!transferId) {
    score += 40; raisons.push("Transfer ID manquant");
  } else if (!/^\d{6,}$/.test(String(transferId))) {
    score += 40; raisons.push("Transfer ID invalide (< 6 chiffres ou format incorrect)");
  }

  if (num && !/^77/.test(num)) { score += 20; raisons.push("Numéro expéditeur suspect (ne commence pas par 77)"); }
  if (!num)                    { score += 10; raisons.push("Numéro expéditeur manquant"); }

  score = Math.min(score, 100);
  const risque = score >= 70 ? "élevé" : score >= 40 ? "moyen" : "faible";
  const action = score >= 70 ? "rejeter" : score >= 40 ? "vérifier" : "valider";

  return {
    score_fraude: score,
    risque,
    raisons: raisons.length ? raisons : ["Aucune anomalie détectée"],
    action,
  };
}

// ── Support client — arbre de décision embarqué ───────────────────
function repondreSupport(text, session, orders) {
  const t = text.toLowerCase().trim();

  const ordreMatch    = text.match(/\b(\d{6,8})\b/);
  const ordreNum      = ordreMatch ? ordreMatch[1] : null;
  const hasTransferId = /transfer[- ]?id|tid\b/i.test(t) || /\b\d{8,}\b/.test(text);
  const isGreeting    = /^(bonjour|salut|bonsoir|hello|salam|hi|allo|allô|bjr)\b/.test(t);

  // Client fournit un Transfer ID → escalade admin
  if (hasTransferId && (orders.length > 0 || session.phone)) {
    return {
      reponse_client:
        "Merci pour ces informations. Votre demande a été transmise à notre équipe pour vérification manuelle.\n\n" +
        "Nous reviendrons vers vous dans les plus brefs délais.\n\n— <i>Support Kaffi-Pay</i>",
      decision:       "escalade",
      action_prise:   "Transfer ID fourni — escalade vers admin",
      niveau_urgence: "moyen",
      resume_audit:   "Client a fourni des informations de paiement — vérification manuelle requise",
    };
  }

  // Client donne un numéro d'ordre
  if (ordreNum) {
    if (!session.phone) {
      return {
        reponse_client:
          `Pour vérifier l'ordre <b>#${ordreNum}</b>, merci d'indiquer votre <b>numéro Waafi</b> ` +
          "(8 chiffres, ex: <code>77123456</code>).\n\n— <i>Support Kaffi-Pay</i>",
        decision:       "info_manquante",
        action_prise:   "Numéro Waafi requis pour recherche",
        niveau_urgence: "faible",
        resume_audit:   `Ordre #${ordreNum} donné sans numéro Waafi`,
      };
    }

    const ligne = orders.find((o) => o.includes(`#${ordreNum}`));

    if (ligne) {
      if (ligne.includes("| Confirmé")) {
        return {
          reponse_client:
            `✅ Votre ordre <b>#${ordreNum}</b> est <b>confirmé</b>. ` +
            "Votre compte 1xBet a bien été crédité.\n\n— <i>Support Kaffi-Pay</i>",
          decision:       "résolu",
          action_prise:   "Statut confirmé communiqué au client",
          niveau_urgence: "faible",
          resume_audit:   `Ordre #${ordreNum} confirmé — client informé`,
        };
      }

      if (ligne.includes("| En attente")) {
        return {
          reponse_client:
            `⏳ Votre ordre <b>#${ordreNum}</b> est <b>en cours de traitement</b>. ` +
            "Vous serez notifié automatiquement dès confirmation.\n\n— <i>Support Kaffi-Pay</i>",
          decision:       "résolu",
          action_prise:   "Statut en attente communiqué",
          niveau_urgence: "faible",
          resume_audit:   `Ordre #${ordreNum} en attente — client informé`,
        };
      }

      if (ligne.includes("| Rejeté")) {
        const nonRecu = ligne.toLowerCase().includes("paiement non re") ||
                        ligne.toLowerCase().includes("introuvable");
        const fraude  = ligne.toLowerCase().includes("fraude");

        if (fraude) {
          return {
            reponse_client:
              "❌ Votre ordre a été rejeté pour raison de sécurité.\n\n" +
              "Si vous pensez qu'il s'agit d'une erreur, envoyez votre Transfer ID Waafi pour vérification.\n\n" +
              "— <i>Support Kaffi-Pay</i>",
            decision:       "fraude_signalée",
            action_prise:   "Ordre fraude — réponse prudente",
            niveau_urgence: "élevé",
            resume_audit:   `Ordre #${ordreNum} rejeté fraude — client a contacté support`,
          };
        }

        if (nonRecu) {
          return {
            reponse_client:
              `❌ Votre ordre <b>#${ordreNum}</b> a été rejeté : <b>Paiement non reçu</b>.\n\n` +
              "Raisons possibles :\n" +
              "1. Le Transfer ID saisi ne correspond à aucun paiement reçu\n" +
              "2. Le montant ou numéro expéditeur ne correspond pas\n" +
              "3. Le paiement a été effectué après soumission de l'ordre\n\n" +
              "Pour vérification merci d'envoyer :\n" +
              "• <b>Transfer ID Waafi</b>\n" +
              "• <b>Montant payé (DJF)</b>\n" +
              "• <b>Numéro Waafi expéditeur</b>\n\n" +
              "— <i>Support Kaffi-Pay</i>",
            decision:       "info_manquante",
            action_prise:   "Rejeté paiement non reçu — demande infos complémentaires",
            niveau_urgence: "moyen",
            resume_audit:   `Ordre #${ordreNum} rejeté paiement non reçu — Transfer ID demandé`,
          };
        }

        return {
          reponse_client:
            `❌ Votre ordre <b>#${ordreNum}</b> a été <b>rejeté</b>.\n\n` +
            "Pour plus d'informations, envoyez votre Transfer ID Waafi.\n\n— <i>Support Kaffi-Pay</i>",
          decision:       "info_manquante",
          action_prise:   "Ordre rejeté — demande Transfer ID",
          niveau_urgence: "moyen",
          resume_audit:   `Ordre #${ordreNum} rejeté — client informé`,
        };
      }
    } else {
      return {
        reponse_client:
          `L'ordre <b>#${ordreNum}</b> n'a pas été trouvé pour votre numéro.\n\n` +
          "Vérifiez le numéro d'ordre (6 à 8 chiffres, visible sur kaffi-pay.com).\n\n" +
          "— <i>Support Kaffi-Pay</i>",
        decision:       "info_manquante",
        action_prise:   "Ordre introuvable pour ce numéro",
        niveau_urgence: "faible",
        resume_audit:   `Ordre #${ordreNum} introuvable pour ${session.phone}`,
      };
    }
  }

  // Salutation
  if (isGreeting) {
    return {
      reponse_client:
        "Bonjour ! Je suis le support Kaffi-Pay.\n\n" +
        "Pour vous aider, merci d'indiquer votre <b>numéro d'ordre</b> (ex : <code>2606061</code>).\n\n" +
        "— <i>Support Kaffi-Pay</i>",
      decision:       "info_manquante",
      action_prise:   "Salutation — demande numéro d'ordre",
      niveau_urgence: "faible",
      resume_audit:   "Client a salué — demande numéro d'ordre",
    };
  }

  // Fallback universel
  return {
    reponse_client:
      "Bonjour ! Pour vous aider, merci d'indiquer votre <b>numéro d'ordre</b> (ex : <code>2606061</code>).\n\n" +
      "— <i>Support Kaffi-Pay</i>",
    decision:       "info_manquante",
    action_prise:   "Message non reconnu — demande numéro d'ordre",
    niveau_urgence: "faible",
    resume_audit:   "Message non reconnu — fallback numéro d'ordre",
  };
}

// ── Bot admin — commandes embarquées ──────────────────────────────
function traiterAdminBot(text, orders, notifs) {
  const t = text.toLowerCase().trim();

  // Format ligne ordre: • #ID | Type | MONTANT DJF | Status | N°... | Raison
  function parseMontant(ligne) {
    const m = ligne.match(/\|\s*([\d\s]+)\s*DJF/);
    return m ? parseFloat(m[1].replace(/\s/g, "")) || 0 : 0;
  }

  const ordreNum = (text.match(/\b(\d{6,8})\b/) || [])[1] || null;

  // stats
  if (/^\/stats$/.test(t) || /\b(stats|statistiques|bilan|résumé)\b/.test(t)) {
    const confirmes = orders.filter((o) => o.includes("| Confirmé"));
    const attente   = orders.filter((o) => o.includes("| En attente"));
    const rejetes   = orders.filter((o) => o.includes("| Rejeté"));
    const fraudes   = orders.filter((o) => o.toLowerCase().includes("fraude"));
    const volume    = confirmes.reduce((s, o) => s + parseMontant(o), 0);
    const taux      = orders.length ? Math.round(confirmes.length / orders.length * 100) : 0;
    return (
      "📊 <b>Statistiques (20 derniers ordres)</b>\n\n" +
      `✅ Confirmés : <b>${confirmes.length}</b>\n` +
      `⏳ En attente : <b>${attente.length}</b>\n` +
      `❌ Rejetés : <b>${rejetes.length}</b>\n` +
      `🚨 Fraudes : <b>${fraudes.length}</b>\n` +
      `💰 Volume confirmé : <b>${volume.toLocaleString()} DJF</b>\n` +
      `📈 Taux confirmation : <b>${taux}%</b>`
    );
  }

  // ordres en attente
  if (/^\/ordres$/.test(t) || /\b(attente|ordres)\b/.test(t)) {
    const attente = orders.filter((o) => o.includes("| En attente"));
    if (!attente.length) return "✅ Aucun ordre en attente.";
    return `⏳ <b>Ordres en attente (${attente.length})</b>\n\n${attente.join("\n")}`;
  }

  // fraudes / rejetés
  if (/^\/fraudes$/.test(t) || /\b(fraudes?|rejet)\b/.test(t)) {
    const fraudes = orders.filter((o) => o.toLowerCase().includes("fraude"));
    const rejetes = orders.filter((o) => o.includes("| Rejeté"));
    if (fraudes.length) return `🚨 <b>Fraudes détectées (${fraudes.length})</b>\n\n${fraudes.join("\n")}`;
    if (rejetes.length) return `❌ <b>Ordres rejetés (${rejetes.length})</b>\n\n${rejetes.join("\n")}`;
    return "✅ Aucune fraude ni rejet récent.";
  }

  // sms / waafi
  if (/^\/sms$/.test(t) || /\b(sms|waafi|notif)\b/.test(t)) {
    if (!notifs.length) return "📭 Aucun SMS Waafi reçu récemment.";
    return `📩 <b>Derniers SMS Waafi (${notifs.length})</b>\n\n${notifs.join("\n")}`;
  }

  // recherche par numéro d'ordre
  if (ordreNum) {
    const ligne = orders.find((o) => o.includes(`#${ordreNum}`));
    if (ligne) return `🔍 <b>Ordre #${ordreNum}</b>\n\n${ligne}`;
    return `❓ Ordre <b>#${ordreNum}</b> introuvable dans les 20 derniers.`;
  }

  // aide
  return (
    "🤖 <b>Commandes disponibles</b>\n\n" +
    "📊 <code>stats</code> — Statistiques\n" +
    "⏳ <code>ordres</code> — Ordres en attente\n" +
    "🚨 <code>fraudes</code> — Fraudes / rejetés\n" +
    "📩 <code>sms</code> — Derniers SMS Waafi\n" +
    "🔍 <code>#2606061</code> — Détails d'un ordre\n\n" +
    "<i>Tapez une commande ou un numéro d'ordre.</i>"
  );
}

// ── Helpers Telegram ─────────────────────────────────────────────

async function sendTelegramToBot(token, chatId, text, opts = {}) {
  if (!token || !chatId) {
    console.warn("sendTelegramToBot: token or chatId manquant", { hasToken: !!token, chatId });
    return false;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...opts }),
      signal:  AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.warn("sendTelegramToBot API error:", resp.status, body.substring(0, 300));
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
    if (!resp.ok) {
      const body = await resp.text();
      console.warn("Telegram error:", resp.status, body.substring(0, 200));
    }
  } catch (e) {
    console.warn("Telegram send failed:", e.message);
  }
}

// Évite double-traitement via transaction Firestore
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
// 1. NOUVEL ORDRE → Fraude + Doublons + Alerte Telegram admin
// ══════════════════════════════════════════════════════════════════
exports.onNouvelOrdre = onDocumentCreated(
  {
    document:  "orders/{docId}",
    region:    REGION,
    secrets:   [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID],
    timeoutSeconds: 60,
  },
  async (event) => {
    const tx         = event.data.data();
    const docId      = event.params.docId;
    const ref        = tx.orderId || tx.ref || docId;
    const transferId = tx.waafitranfertID || tx.hash || "";
    const isDepot    = tx.type === "Dépôt";

    // ── 1a. Transfer ID déjà confirmé = fraude permanente ────────────
    if (transferId) {
      const confirmeSnap = await db.collection("orders")
        .where("waafitranfertID", "==", transferId)
        .where("status", "==", "Confirmé")
        .limit(1)
        .get();

      if (!confirmeSnap.empty) {
        const ancienOrdre = confirmeSnap.docs[0].data();
        const ancienRef   = ancienOrdre.orderId || confirmeSnap.docs[0].id;
        await db.collection("orders").doc(docId).update({
          status:     "Rejeté",
          flagRaison: `FRAUDE — Transfer ID ${transferId} déjà utilisé dans l'ordre confirmé #${ancienRef}`,
          flaggedAt:  FieldValue.serverTimestamp(),
        });
        await sendTelegram(
          TELEGRAM_TOKEN.value(),
          TELEGRAM_ADMIN_ID.value(),
          `🚨 <b>FRAUDE détectée</b>\n\n` +
          `Ordre <code>#${ref}</code> rejeté.\n` +
          `Transfer-ID <code>${transferId}</code> déjà utilisé\n` +
          `dans l'ordre confirmé <code>#${ancienRef}</code>.\n\n` +
          `⚠️ Tentative de réutilisation d'un ancien paiement.`
        );
        return;
      }

      // Vérifie aussi les waafi_notifications déjà matchées
      const waafiMatcheSnap = await db.collection("waafi_notifications")
        .where("transferId", "==", transferId)
        .where("status", "==", "matché")
        .limit(1)
        .get();

      if (!waafiMatcheSnap.empty) {
        const ancienWaafi = waafiMatcheSnap.docs[0].data();
        await db.collection("orders").doc(docId).update({
          status:     "Rejeté",
          flagRaison: `FRAUDE — Transfer ID ${transferId} déjà matché avec l'ordre #${ancienWaafi.ordreRef || "?"}`,
          flaggedAt:  FieldValue.serverTimestamp(),
        });
        await sendTelegram(
          TELEGRAM_TOKEN.value(),
          TELEGRAM_ADMIN_ID.value(),
          `🚨 <b>FRAUDE détectée</b>\n\n` +
          `Transfer-ID <code>${transferId}</code> déjà utilisé\n` +
          `pour confirmer l'ordre <code>#${ancienWaafi.ordreRef || "?"}</code>.\n\n` +
          `⚠️ Paiement Waafi réutilisé.`
        );
        return;
      }
    }

    // ── 1b. Transfer ID = seule vérité du paiement ───────────────────
    if (isDepot) {
      const montantOrdre = Number(tx.montant || 0);

      let waafiDoc  = null;
      let waafiData = null;

      if (transferId) {
        const snap = await db.collection("waafi_notifications")
          .where("transferId", "==", transferId)
          .where("status", "==", "nouveau")
          .limit(1)
          .get();
        if (!snap.empty) {
          waafiDoc  = snap.docs[0];
          waafiData = waafiDoc.data();
        }
      }

      // ── Transfer ID trouvé → paiement confirmé ────────────────────
      if (waafiDoc) {
        const montantReel = waafiData.montant  || montantOrdre;
        const numReel     = waafiData.numClient || tx.numeroPayment || "";

        const corrections = [];
        if (waafiData.montant && Math.abs(montantOrdre - waafiData.montant) > 1) {
          corrections.push(`Montant corrigé: ${montantOrdre} → ${waafiData.montant} DJF`);
        }
        if (waafiData.numClient && tx.numeroPayment && waafiData.numClient !== tx.numeroPayment) {
          corrections.push(`N° corrigé: ${tx.numeroPayment} → ${waafiData.numClient}`);
        }

        const claimed = await claimOrder(
          db.collection("orders").doc(docId),
          "En attente", "Confirmé",
          {
            confirmedBy:       "auto_transfer_id",
            montant:           montantReel,
            montantRecu:       montantReel,
            numeroPayment:     numReel,
            expediteurRecu:    numReel,
            correctionApplied: corrections.length > 0,
            corrections:       corrections,
            confirmedAt:       FieldValue.serverTimestamp(),
          }
        );

        if (claimed) {
          await waafiDoc.ref.update({ status: "matché", ordreRef: ref });
          await sendTelegram(
            TELEGRAM_TOKEN.value(),
            TELEGRAM_ADMIN_ID.value(),
            `✅ <b>Dépôt confirmé</b>${corrections.length ? " ✏️ (corrigé)" : ""}\n\n` +
            `Réf: <b>#${ref}</b>\n` +
            `Montant: <b>${Number(montantReel).toLocaleString()} DJF</b>\n` +
            `ID 1xBet: <code>${tx.userId1xBet || "?"}</code>\n` +
            `Transfer-ID: <code>${transferId}</code>\n` +
            `Expéditeur: <code>${numReel}</code>\n` +
            (corrections.length ? `\n✏️ <i>${corrections.join(" | ")}</i>` : "") +
            `\n\n🤖 Transfer ID vérifié — confirmation automatique`
          );
          return;
        }
      }

      // ── Transfer ID introuvable → rejet ───────────────────────────
      await db.collection("orders").doc(docId).update({
        status:     "Rejeté",
        flagRaison: `Paiement non reçu — Transfer ID ${transferId || "(non fourni)"} introuvable dans les notifications Waafi`,
        flaggedAt:  FieldValue.serverTimestamp(),
      });
      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `❌ <b>Ordre rejeté — Paiement non reçu</b>\n\n` +
        `Réf: <code>#${ref}</code>\n` +
        `Transfer-ID soumis: <code>${transferId || "non fourni"}</code>\n` +
        `Montant: <b>${montantOrdre.toLocaleString()} DJF</b>\n` +
        `ID 1xBet: <code>${tx.userId1xBet || "?"}</code>\n\n` +
        `⚠️ Aucun paiement Waafi avec ce Transfer ID.`
      );
      return;
    }

    // ── 1c. Analyse fraude — règles embarquées ────────────────────
    const fraud = analyserFraude(tx, transferId);

    await db.collection("orders").doc(docId).update({
      ia_score_fraude: fraud.score_fraude,
      ia_risque:       fraud.risque,
      ia_raisons:      fraud.raisons,
      ia_action:       fraud.action,
      ia_analysedAt:   FieldValue.serverTimestamp(),
    });

    // ── 1d. Rejet auto si fraude élevée ───────────────────────────
    if (fraud.action === "rejeter" || fraud.risque === "élevé") {
      await db.collection("orders").doc(docId).update({
        status:     "Rejeté",
        flagRaison: "Fraude détectée: " + fraud.raisons.join(", "),
      });
      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `🚨 <b>Ordre rejeté — Fraude détectée</b>\n` +
        `Réf: <code>#${ref}</code>\n` +
        `Score: ${fraud.score_fraude}/100 — ${fraud.risque.toUpperCase()}\n` +
        `Raisons: ${fraud.raisons.join(", ")}`
      );
      return;
    }

    // ── 1e. Notification Telegram admin ──────────────────────────
    const details = isDepot
      ? `ID 1xBet: <code>${tx.userId1xBet || tx.id1x || "?"}</code>\n` +
        `Transfer ID: <code>${transferId || "?"}</code>\n` +
        `Expéditeur: <code>${tx.numeroPayment || "?"}</code>`
      : `Code retrait: <code>${tx.withdrawalCode || tx.code || "?"}</code>\n` +
        `Numéro Waafi: <code>${tx.waafiNumber || tx.tel || "?"}</code>`;

    await sendTelegram(
      TELEGRAM_TOKEN.value(),
      TELEGRAM_ADMIN_ID.value(),
      `${isDepot ? "📥" : "📤"} <b>Nouvel ordre ${tx.type}</b>\n\n` +
      `Réf: <b>#${ref}</b>\n` +
      `Montant: <b>${Number(tx.montant).toLocaleString()} DJF</b>\n` +
      `${details}\n\n` +
      `Risque: <i>${fraud.risque} (${fraud.score_fraude}/100)</i>`
    );
  }
);

// ══════════════════════════════════════════════════════════════════
// 2. ORDRE MIS À JOUR → Notification Telegram admin
// ══════════════════════════════════════════════════════════════════
exports.onOrdreUpdated = onDocumentUpdated(
  {
    document: "orders/{docId}",
    region:   REGION,
    secrets:  [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID],
  },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    if (before.status === after.status) return;

    const ref     = after.orderId || after.ref || event.params.docId;
    const montant = Number(after.montant || 0).toLocaleString();
    const type    = after.type || "Ordre";

    let adminMsg = "";
    if (after.status === "Confirmé") {
      adminMsg =
        `✅ <b>${type} confirmé</b>\n` +
        `#${ref} — ${montant} DJF\n` +
        (after.confirmedBy === "auto_waafi_sms" ? "🤖 Auto-confirmation SMS" : "👤 Confirmé manuellement");
    } else if (after.status === "Rejeté") {
      adminMsg =
        `❌ <b>${type} rejeté</b>\n` +
        `#${ref} — ${after.flagRaison || "Raison inconnue"}`;
    } else if (after.status === "Argent Reçu") {
      adminMsg =
        `💳 <b>Paiement Waafi reçu</b>\n` +
        `#${ref} — ${montant} DJF\n` +
        `Crédit 1xBet en cours…`;
    } else if (after.status === "Correction") {
      adminMsg =
        `✏️ <b>Correction demandée</b>\n` +
        `#${ref}\n` +
        `Message: ${after.correctionMsg || ""}`;
    }

    if (adminMsg) {
      await sendTelegram(TELEGRAM_TOKEN.value(), TELEGRAM_ADMIN_ID.value(), adminMsg);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// 3. ANALYSE ADMIN — stats Firestore temps réel (sans IA)
// ══════════════════════════════════════════════════════════════════
exports.geminiAnalyseAdmin = onCall(
  { region: REGION, secrets: [] },
  async () => {
    const snap = await db.collection("orders")
      .orderBy("ts", "desc")
      .limit(100)
      .get();

    const txs       = snap.docs.map((d) => d.data());
    const confirmes = txs.filter((t) => t.status === "Confirmé");
    const attente   = txs.filter((t) => t.status === "En attente");
    const rejetes   = txs.filter((t) => t.status === "Rejeté");
    const fraudes   = txs.filter((t) => t.flagRaison && t.flagRaison.toUpperCase().includes("FRAUDE"));
    const volume    = confirmes.reduce((s, t) => s + Number(t.montant || 0), 0);
    const taux      = txs.length ? Math.round(confirmes.length / txs.length * 100) : 0;
    const moy       = confirmes.length ? Math.round(volume / confirmes.length) : 0;

    let alerte = null;
    if (attente.length > 10)              alerte = `${attente.length} ordres en attente — vérification requise`;
    else if (fraudes.length > 3)          alerte = `${fraudes.length} fraudes détectées parmi les 100 dernières transactions`;
    else if (taux < 50 && txs.length > 10) alerte = `Taux de confirmation faible : ${taux}% — anomalie possible`;

    return {
      success: true,
      data: {
        resume:            `${confirmes.length} confirmés sur ${txs.length} — volume ${volume.toLocaleString()} DJF. Taux: ${taux}%.`,
        alerte,
        conseil:           attente.length > 5 ? "Vérifier les ordres en attente" : "Opérations normales",
        prediction_demain: moy * Math.max(confirmes.length, 1),
        score_sante:       Math.max(0, Math.min(100, taux - fraudes.length * 10)),
      },
      stats: { confirmes: confirmes.length, attente: attente.length, rejetes: rejetes.length, volume },
    };
  }
);

// ══════════════════════════════════════════════════════════════════
// 5. AUTO-CONFIRMATION — SMS Waafi → Confirme l'ordre + Webhook
// ══════════════════════════════════════════════════════════════════
exports.autoConfirmation = onDocumentCreated(
  {
    document:       "waafi_notifications/{docId}",
    region:         REGION,
    secrets:        [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, MACRO_WEBHOOK_URL, MACRO_SECRET],
    timeoutSeconds: 60,
  },
  async (event) => {
    const sms   = event.data.data();
    const docId = event.params.docId;

    if (sms.status === "traité" || sms.status === "en_cours") return;

    const expectedSecret = MACRO_SECRET.value() || "KaffiPay2026";
    if (sms.secret && sms.secret !== expectedSecret) {
      await db.collection("waafi_notifications").doc(docId).update({
        status: "rejeté_secret_invalide",
      });
      return;
    }

    await db.collection("waafi_notifications").doc(docId).update({
      status:      "en_cours",
      processedAt: FieldValue.serverTimestamp(),
    });

    const notification =
      sms.notification || sms.not_body || sms.message ||
      sms.texte || sms.body || sms.text || "";

    const transferId = extractTransferId(notification);
    const montantSMS = extractMontant(notification);
    const numClient  = extractNumClient(notification);

    console.log(`SMS Waafi → TransferID: ${transferId}, Montant: ${montantSMS} DJF, N°: ${numClient}`);

    if (!transferId && !montantSMS) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "erreur_parsing",
        erreurMsg: "Impossible d'extraire Transfer ID ou Montant du SMS",
      });
      return;
    }

    let ordreSnap = { empty: true };

    if (transferId) {
      ordreSnap = await db.collection("orders")
        .where("waafitranfertID", "==", transferId)
        .where("status", "==", "En attente")
        .limit(1)
        .get();
    }

    if (ordreSnap.empty && numClient && montantSMS) {
      ordreSnap = await db.collection("orders")
        .where("numeroPayment", "==", numClient)
        .where("montant", "==", montantSMS)
        .where("status", "==", "En attente")
        .limit(1)
        .get();
    }

    if (ordreSnap.empty) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:    "non_matché",
        erreurMsg: `Aucun ordre en attente — Transfer ID: ${transferId}, Montant: ${montantSMS} DJF`,
      });
      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>SMS Waafi sans correspondance</b>\n\n` +
        `Transfer-ID: <code>${transferId || "?"}</code>\n` +
        `Montant: <b>${montantSMS ? montantSMS.toLocaleString() : "?"} DJF</b>\n` +
        `Expéditeur: <code>${numClient || "?"}</code>\n\n` +
        `Vérifiez les ordres en attente — paiement manuel peut-être requis.`
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
        status:    "montant_incorrect",
        erreurMsg: `Montant SMS (${montantSMS}) ≠ Montant ordre (${montantOrdre})`,
        ordreRef:  ordreRef,
      });
      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>Montant incorrect</b> pour #${ordreRef}\n` +
        `SMS: ${montantSMS} DJF / Ordre: ${montantOrdre} DJF\n` +
        `Vérification manuelle requise.`
      );
      return;
    }

    const claimed = await claimOrder(ordreDoc.ref, "En attente", "Argent Reçu", {
      confirmedBy:     "auto_waafi_sms",
      waafitranfertID: transferId || ordre.waafitranfertID,
      montantRecu:     mt,
      expediteurRecu:  numClient || "",
      argentRecuAt:    FieldValue.serverTimestamp(),
    });

    if (!claimed) {
      await db.collection("waafi_notifications").doc(docId).update({
        status:   "déjà_traité",
        ordreRef: ordreRef,
      });
      return;
    }

    await db.collection("waafi_notifications").doc(docId).update({
      status:   "matché",
      ordreRef: ordreRef,
    });

    await new Promise((r) => setTimeout(r, 10000));

    await ordreDoc.ref.update({
      status:      "Confirmé",
      confirmedAt: FieldValue.serverTimestamp(),
    });

    await db.collection("waafi_notifications").doc(docId).update({
      status: "traité",
    });

    const id1xbet = ordre.userId1xBet || ordre.id1x || ordre.idUser || "";

    if (id1xbet) {
      const webhookBase = MACRO_WEBHOOK_URL.value() ||
        "https://trigger.macrodroid.com/f3af9af3-7f05-401d-ade2-df70f6880dcb/depot_1xbet";
      try {
        const webhookUrl =
          `${webhookBase}?id1xbet=${encodeURIComponent(id1xbet)}` +
          `&montant=${encodeURIComponent(mt)}` +
          `&ref=${encodeURIComponent(ordreRef)}`;

        const resp = await fetch(webhookUrl, { signal: AbortSignal.timeout(10000) });

        await ordreDoc.ref.update({
          webhookStatus: resp.ok ? "ok" : "erreur_" + resp.status,
          webhookAt:     FieldValue.serverTimestamp(),
        });

        if (!resp.ok) {
          await sendTelegram(
            TELEGRAM_TOKEN.value(),
            TELEGRAM_ADMIN_ID.value(),
            `⚠️ <b>Webhook MacroDroid échoué</b>\n` +
            `Ordre #${ordreRef} — HTTP ${resp.status}\n` +
            `ID 1xBet: <code>${id1xbet}</code> — ${Number(mt).toLocaleString()} DJF\n` +
            `<b>Recharge manuelle requise.</b>`
          );
        }
      } catch (e) {
        await ordreDoc.ref.update({ webhookStatus: "erreur_timeout" });
        await sendTelegram(
          TELEGRAM_TOKEN.value(),
          TELEGRAM_ADMIN_ID.value(),
          `⚠️ <b>MacroDroid injoignable</b>\n` +
          `Ordre #${ordreRef} — ${e.name === "AbortError" ? "Timeout 10s" : e.message}\n` +
          `ID 1xBet: <code>${id1xbet}</code> — ${Number(mt).toLocaleString()} DJF\n` +
          `<b>Recharge manuelle requise.</b>`
        );
      }
    } else {
      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `⚠️ <b>ID 1xBet manquant</b> — Ordre #${ordreRef}\n` +
        `${Number(mt).toLocaleString()} DJF reçu — <b>Recharge manuelle requise.</b>`
      );
    }

    await sendTelegram(
      TELEGRAM_TOKEN.value(),
      TELEGRAM_ADMIN_ID.value(),
      `✅ <b>Dépôt auto-confirmé</b>\n` +
      `#${ordreRef} — ${Number(mt).toLocaleString()} DJF\n` +
      `ID 1xBet: <code>${id1xbet || "?"}</code>\n` +
      (transferId ? `Transfer-ID: <code>${transferId}</code>` : "")
    );
  }
);

// ══════════════════════════════════════════════════════════════════
// 6. WEBHOOK MACRODROID — Reçoit la notif Waafi → Firestore + Telegram
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
    if (secret && secret !== expectedSecret) {
      res.status(403).json({ error: "Secret invalide" });
      return;
    }

    if (!notif) {
      res.status(400).json({ error: "Champ 'notification' requis" });
      return;
    }

    const transferIdParsed = extractTransferId(notif);
    const montantParsed    = extractMontant(notif);
    const numClientParsed  = extractNumClient(notif);

    const docRef = await db.collection("waafi_notifications").add({
      notification: notif,
      transferId:   transferIdParsed,
      montant:      montantParsed,
      numClient:    numClientParsed,
      secret:       expectedSecret,
      source:       "macrodroid",
      status:       "nouveau",
      createdAt:    FieldValue.serverTimestamp(),
    });

    await sendTelegram(
      TELEGRAM_TOKEN.value(),
      TELEGRAM_ADMIN_ID.value(),
      `📩 <b>SMS Waafi reçu</b>\n\n` +
      `Transfer-ID: <code>${transferIdParsed || "?"}</code>\n` +
      `Montant: <b>${montantParsed ? Number(montantParsed).toLocaleString() : "?"} DJF</b>\n` +
      `Expéditeur: <code>${numClientParsed || "?"}</code>\n\n` +
      `<i>Traitement auto en cours…</i>`
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
    let firestoreMs = "?", firestoreStatus = "ok";

    try {
      await db.collection("orders").limit(1).get();
      firestoreMs = `${Date.now() - t0}ms`;
    } catch (e) {
      firestoreMs    = `erreur: ${e.message}`;
      firestoreStatus = "erreur";
    }

    res.json({
      status:    firestoreStatus,
      timestamp: new Date().toISOString(),
      region:    REGION,
      firestore: firestoreMs,
      ai:        "logique embarquée — aucune API externe",
      version:   "3.5",
    });
  }
);

// ══════════════════════════════════════════════════════════════════
// 8. SUPPORT CLIENT TELEGRAM — logique embarquée + audit admin
// ══════════════════════════════════════════════════════════════════
exports.supportClient = onRequest(
  {
    region:         REGION,
    secrets:        [SUPPORT_BOT_TOKEN, TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID],
    timeoutSeconds: 60,
  },
  async (req, res) => {
    res.status(200).send("OK");

    try {
      const update = req.body || {};
      console.log("supportClient reçu:", JSON.stringify(update).substring(0, 300));

      const msg    = update.message || update.edited_message;
      if (!msg) { console.log("Pas de message dans l'update"); return; }

      const chatId    = msg.chat.id;
      const text      = (msg.text || "").trim();
      const fromUser  = msg.from || {};
      const firstName = fromUser.first_name || "Client";

      console.log(`Message de ${firstName} (${chatId}): "${text}"`);

      if (!text) return;

      const supportToken = SUPPORT_BOT_TOKEN.value();
      if (!supportToken) {
        console.error("SUPPORT_BOT_TOKEN vide — secret non configuré");
        return;
      }

      // ── Session client ─────────────────────────────────────────
      const sessionRef  = db.collection("support_sessions").doc(String(chatId));
      const sessionSnap = await sessionRef.get();
      const session     = sessionSnap.exists ? sessionSnap.data() : {};

      const cleanText = text.replace(/\s/g, "");
      const isPhone   = /^(77|78|70|71|21)\d{6}$/.test(cleanText);
      if (isPhone && !session.phone) {
        await sessionRef.set({ phone: cleanText, chatId, startedAt: FieldValue.serverTimestamp() }, { merge: true });
        session.phone = cleanText;
        console.log(`Numéro sauvegardé pour ${chatId}: ${cleanText}`);
      }

      // ── Historique ordres ───────────────────────────────────────
      let orders = [];
      if (session.phone) {
        try {
          const ordersSnap = await db.collection("orders")
            .where("numeroPayment", "==", session.phone)
            .orderBy("ts", "desc")
            .limit(10)
            .get();
          orders = ordersSnap.docs.map((d) => {
            const o = d.data();
            return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status} | ${o.flagRaison || ""}`;
          });
        } catch (e) {
          console.warn("Index manquant, fallback sans orderBy:", e.message);
          try {
            const ordersSnap = await db.collection("orders")
              .where("numeroPayment", "==", session.phone)
              .limit(10)
              .get();
            orders = ordersSnap.docs.map((d) => {
              const o = d.data();
              return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status} | ${o.flagRaison || ""}`;
            });
          } catch (e2) {
            console.warn("Fallback ordres échoué:", e2.message);
          }
        }
      }

      // ── Décision logique embarquée ──────────────────────────────
      const aiDecision = repondreSupport(text, session, orders);
      console.log("Décision support:", aiDecision.decision);

      // ── Réponse au client ───────────────────────────────────────
      await sendTelegramToBot(supportToken, chatId, aiDecision.reponse_client);

      await db.collection("support_sessions").doc(String(chatId))
        .collection("messages").add({
          text,
          decision: aiDecision.decision,
          action:   aiDecision.action_prise,
          urgence:  aiDecision.niveau_urgence,
          ts:       FieldValue.serverTimestamp(),
        });

      // ── Audit Telegram admin ────────────────────────────────────
      const urgenceEmoji = {
        "faible":  "🟢",
        "moyen":   "🟡",
        "élevé":   "🔴",
      }[aiDecision.niveau_urgence] || "⚪";

      const decisionEmoji = {
        "résolu":          "✅",
        "escalade":        "🆘",
        "info_manquante":  "❓",
        "fraude_signalée": "🚨",
      }[aiDecision.decision] || "ℹ️";

      await sendTelegram(
        TELEGRAM_TOKEN.value(),
        TELEGRAM_ADMIN_ID.value(),
        `${urgenceEmoji} <b>Support Client</b> ${decisionEmoji}\n\n` +
        `👤 ${firstName} | <code>${session.phone || "Non renseigné"}</code>\n` +
        `💬 <i>"${text.substring(0, 100)}"</i>\n\n` +
        `🤖 <b>Décision :</b> ${aiDecision.decision.toUpperCase()}\n` +
        `⚡ Action : ${aiDecision.action_prise}\n\n` +
        `📋 ${aiDecision.resume_audit}\n\n` +
        (aiDecision.decision === "escalade"
          ? `⚠️ <b>Intervention manuelle requise.</b>` : "")
      );

    } catch (e) {
      console.error("supportClient crash:", e.message, e.stack);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// 9. BOT ADMIN — Commandes embarquées (admin seulement)
// ══════════════════════════════════════════════════════════════════
exports.adminBot = onRequest(
  {
    region:         REGION,
    secrets:        [TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID],
    timeoutSeconds: 60,
  },
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

      if (chatId !== adminId) {
        console.warn(`adminBot: accès refusé pour chatId ${chatId}`);
        return;
      }

      if (!text) return;
      console.log(`adminBot commande: "${text}"`);

      // Charger les données Firestore
      const [ordersSnap, notifSnap] = await Promise.all([
        db.collection("orders").orderBy("ts", "desc").limit(20).get().catch(() =>
          db.collection("orders").limit(20).get()
        ),
        db.collection("waafi_notifications").orderBy("createdAt", "desc").limit(10).get().catch(() =>
          db.collection("waafi_notifications").limit(10).get()
        ),
      ]);

      const orders = ordersSnap.docs.map((d) => {
        const o = d.data();
        return `• #${o.orderId || d.id} | ${o.type} | ${o.montant} DJF | ${o.status} | N°${o.numeroPayment || "?"} | ${o.flagRaison || ""}`;
      });

      const notifs = notifSnap.docs.map((d) => {
        const n = d.data();
        return `• TransferID:${n.transferId || "?"} | ${n.montant || "?"}DJF | N°${n.numClient || "?"} | ${n.status || "?"}`;
      });

      const reponse = traiterAdminBot(text, orders, notifs);
      await sendTelegram(token, adminId, reponse);

    } catch (e) {
      console.error("adminBot crash:", e.message, e.stack);
    }
  }
);
