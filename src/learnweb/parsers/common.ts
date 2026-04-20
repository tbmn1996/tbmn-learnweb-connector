/**
 * Gemeinsame Helfer für alle Learnweb-Parser.
 * cheerio-Types werden nur aus dem Root-Package importiert (1.x).
 */

import type { CheerioAPI } from "cheerio";

/** Maximale Länge für freien Text (Page-Inhalte, raw_text-Fallback). */
export const MAX_TEXT_LEN = 5000;

/**
 * Kürzt einen String auf `max` Zeichen und hängt ein "…" an, falls gekürzt wurde.
 */
export function truncate(text: string, max = MAX_TEXT_LEN): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/**
 * Erzeugt aus einem möglicherweise relativen Moodle-Link einen absoluten.
 * Gibt bei parse-Fehlern den Originalwert zurück.
 */
export function absoluteUrl(baseUrl: string, href: string): string {
  if (!href) return href;
  try {
    return new URL(href, baseUrl + "/").toString();
  } catch {
    if (href.startsWith("http")) return href;
    return baseUrl + (href.startsWith("/") ? "" : "/") + href;
  }
}

/**
 * Normalisiert sichtbaren Text: zusammenhängende Whitespaces werden auf
 * ein einzelnes Space reduziert, führende/abschließende Whitespaces entfernt.
 */
export function normalizeText(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Extrahiert sichtbaren Text aus einem cheerio-Selektor und truncated ihn.
 * Nutzt den ersten Treffer; gibt leer zurück, wenn der Selektor nichts findet.
 */
export function extractTextFromSelector(
  $: CheerioAPI,
  selector: string,
  maxLen = MAX_TEXT_LEN
): string {
  const el = $(selector).first();
  if (el.length === 0) return "";
  return truncate(normalizeText(el.text()), maxLen);
}

/**
 * Extrahiert die numerische Course-ID aus einer URL wie
 * ".../course/view.php?id=1234"
 */
export function courseIdFromUrl(url: string): number | null {
  const m = url.match(/[?&]id=(\d+)/);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

/**
 * Extrahiert den cmid-Query-Parameter aus einer URL.
 */
export function cmidFromUrl(url: string): number | null {
  const m = url.match(/[?&]id=(\d+)/);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

// Moodle gibt Datums-Strings in der Sprache des Users aus.
// Wir mappen die häufigsten deutschen und englischen Monatsnamen auf ISO-Nummern,
// damit Date.parse auch bei deutscher Locale zuverlässig funktioniert.
const MONTH_MAP: Record<string, string> = {
  januar: "January", februar: "February", märz: "March", april: "April",
  mai: "May", juni: "June", juli: "July", august: "August",
  september: "September", oktober: "October", november: "November", dezember: "December",
  jan: "Jan", feb: "Feb", mär: "Mar", apr: "Apr",
  jun: "Jun", jul: "Jul", aug: "Aug", sep: "Sep", okt: "Oct", nov: "Nov", dez: "Dec",
};

/**
 * Versucht einen Moodle-Datumsstring ("Wednesday, 1 April 2026, 12:20 PM")
 * in ein Date-Objekt zu parsen. Unterstützt englische und deutsche Monatsnamen.
 * Gibt null zurück, wenn kein valides Datum erkannt wird.
 */
export function parseMoodleDate(s: string): Date | null {
  if (!s) return null;
  // Deutsche Monatsnamen durch englische ersetzen.
  let normalized = s;
  for (const [de, en] of Object.entries(MONTH_MAP)) {
    normalized = normalized.replace(new RegExp(`\\b${de}\\b`, "gi"), en);
  }
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}
