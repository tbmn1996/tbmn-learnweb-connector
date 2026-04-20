/**
 * Fallback-Parser für unbekannte oder (noch) nicht spezialisierte Modtypes.
 *
 * Wir liefern den sichtbaren body-Text (truncated) plus Titel und markieren
 * das Ergebnis als parser_degraded: true, damit KI-Clients wissen,
 * dass keine strukturierten Daten verfügbar sind.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { normalizeText, truncate } from "./common";

export interface FallbackContent {
  raw_text: string;
}

export interface FallbackResult {
  title: string;
  content: FallbackContent;
  parser_degraded: true;
}

export async function parseFallback(
  session: LearnwebSession,
  cmid: number,
  modtype: string
): Promise<FallbackResult> {
  const path = `/mod/${modtype}/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return {
      title: `${modtype} ${cmid}`,
      content: { raw_text: "" },
      parser_degraded: true,
    };
  }

  const $ = cheerio.load(resp.data);
  const title =
    normalizeText($("h1, h2").first().text()) || `${modtype} ${cmid}`;

  // Entferne offensichtliches UI-Chrome: Navigation, Sidebars, Footer.
  $("nav, header, footer, .navbar, #nav-drawer, [role='navigation']").remove();
  $("script, style, noscript").remove();

  // Bevorzuge den Hauptcontent-Bereich, wenn vorhanden.
  const mainCandidates = ["#region-main", "[role='main']", "main", "body"];
  let text = "";
  for (const selector of mainCandidates) {
    const el = $(selector).first();
    if (el.length > 0) {
      text = normalizeText(el.text());
      if (text.length > 0) break;
    }
  }

  return {
    title,
    content: { raw_text: truncate(text) },
    parser_degraded: true,
  };
}
