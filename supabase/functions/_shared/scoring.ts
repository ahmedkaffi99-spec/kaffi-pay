export interface Notif {
  transfer_id?: string | null;
  montant?: number | null;
  num_client?: string | null;
}

export interface OrdreData {
  montant?: number | null;
  waafi_transfert_id?: string | null;
  hash?: string | null;
  numero_payment?: string | null;
  waafi_number?: string | null;
}

export function scorerCorrespondance(ordre: OrdreData, notif: Notif) {
  const montantOrdre = Number(ordre.montant || 0);
  const transferId = (ordre.waafi_transfert_id || ordre.hash || "").trim();
  const phone = (ordre.numero_payment || ordre.waafi_number || "").trim();

  let score = 0;
  const mismatches: string[] = [];

  if (!notif.transfer_id || transferId === notif.transfer_id) {
    score++;
  } else {
    mismatches.push(`Transfer-ID incorrect (ordre: ${transferId} / Waafi: ${notif.transfer_id})`);
  }

  if (!notif.montant || Math.abs(montantOrdre - notif.montant) <= 1) {
    score++;
  } else {
    mismatches.push(`Montant incorrect (ordre: ${montantOrdre} DJF / Waafi: ${notif.montant} DJF)`);
  }

  const normPhone = phone.replace(/^\+?253/, "").replace(/\D/g, "");
  const normNotif = (notif.num_client || "").replace(/^\+?253/, "").replace(/\D/g, "");
  if (!normNotif || normPhone === normNotif) {
    score++;
  } else {
    mismatches.push(`N° expéditeur différent (ordre: ${phone} / Waafi: ${notif.num_client})`);
  }

  return { score, mismatches, decision: score >= 3 ? "confirmer" : "rejeter" };
}

export function mismatchToRaison(mismatches: string[]): string {
  const labels: string[] = [];
  for (const m of mismatches) {
    const ml = m.toLowerCase();
    if (ml.includes("transfer")) labels.push("Transfer ID incorrect");
    else if (ml.includes("montant")) labels.push("Montant incorrect");
    else if (ml.includes("xpéditeur") || ml.includes("n°")) labels.push("N° expéditeur incorrect");
    else labels.push("Information incorrecte");
  }
  return labels.join(" + ") || "Informations incorrectes";
}
