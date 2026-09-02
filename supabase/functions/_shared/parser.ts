export function extractTransferId(text: string): string | null {
  const m = text.match(/Transfer[-\s]?Id\s*[:\s]+\s*(\d+)/i)
    || text.match(/\bTID\s*[:\s]+\s*(\d+)/i)
    || text.match(/\bRef(?:erence)?\s*[:\s]+\s*(\d{6,})/i);
  return m ? m[1].trim() : null;
}

export function extractMontant(text: string): number | null {
  const m = text.match(/Received\s+DJF\s+([\d,]+)/i)
    || text.match(/transferred\s+DJF\s+([\d,]+)/i)
    || text.match(/DJF\s*([\d,]+)/i);
  if (!m) return null;
  const val = parseFloat(m[1].replace(/,(?=\d{3})/g, "").replace(",", "."));
  return isNaN(val) ? null : val;
}

export function extractNumClient(text: string, own = "77275572"): string | null {
  const ms = (text.match(/\((\d{8})\)/g) || []).map((s) => s.replace(/[()]/g, ""));
  const others = ms.filter((n) => n !== own);
  if (others.length) return others[0];
  const m = text.match(/from\s+(77\d{6})/i) || text.match(/de\s+(77\d{6})/i);
  return m ? m[1] : (ms[0] || null);
}
