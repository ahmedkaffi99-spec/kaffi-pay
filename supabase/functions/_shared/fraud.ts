export function analyserFraude(montant: number, transferId: string | null, num: string) {
  const raisons: string[] = [];
  let score = 0;

  if (montant > 200000) { score += 50; raisons.push("Montant extrême (> 200 000 DJF)"); }
  else if (montant > 100000) { score += 35; raisons.push("Montant très élevé (> 100 000 DJF)"); }
  else if (montant > 50000) { score += 15; raisons.push("Montant élevé (> 50 000 DJF)"); }
  else if (montant < 50) { score += 30; raisons.push("Montant suspect (< 50 DJF)"); }

  if (!transferId) {
    score += 40; raisons.push("Transfer ID manquant");
  } else if (!/^\d{6,}$/.test(String(transferId))) {
    score += 40; raisons.push("Transfer ID invalide (< 6 chiffres)");
  } else if (String(transferId).length > 12) {
    score += 20; raisons.push("Transfer ID anormalement long");
  }

  if (!num) { score += 10; raisons.push("Numéro expéditeur manquant"); }
  else if (!/^77/.test(num)) { score += 20; raisons.push("Numéro suspect (ne commence pas par 77)"); }

  score = Math.min(score, 100);
  const risque = score >= 70 ? "élevé" : score >= 40 ? "moyen" : "faible";
  const action = score >= 70 ? "rejeter" : score >= 40 ? "vérifier" : "valider";
  return { score_fraude: score, risque, raisons: raisons.length ? raisons : ["Aucune anomalie"], action };
}
