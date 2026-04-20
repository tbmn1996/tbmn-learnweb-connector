/**
 * Parser für Moodle-Page-Aktivitäten (mod/page).
 * Eine "Page" in Moodle ist ein eigener HTML-Inhalt, den Dozierende direkt
 * im Kurs redigieren. Wir extrahieren den Haupttext und truncaten auf
 * MAX_TEXT_LEN, damit Tool-Responses nicht explodieren.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { normalizeText, truncate } from "./common";

export interface PageContent {
  text: string;
}

export interface PageResult {
  title: string;
  content: PageContent;
  parser_degraded?: boolean;
}

export async function parsePage(
  session: LearnwebSession,
  cmid: number
): Promise<PageResult> {
  const path = `/mod/page/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return {
      title: `Page ${cmid}`,
      content: { text: "" },
      parser_degraded: true,
    };
  }

  const $ = cheerio.load(resp.data);
  const title = normalizeText($("h1, h2").first().text()) || `Page ${cmid}`;

  // Der Page-Content liegt typischerweise im Element mit role="main" oder
  // in einem div.no-overflow bzw. #region-main.
  const candidates = [
    "#region-main .box.generalbox",
    "[role='main'] .box.generalbox",
    "#region-main",
    "[role='main']",
    "main",
  ];
  let text = "";
  for (const selector of candidates) {
    const el = $(selector).first();
    if (el.length > 0) {
      text = normalizeText(el.text());
      if (text.length > 0) break;
    }
  }

  return {
    title,
    content: { text: truncate(text) },
    parser_degraded: text.length === 0 ? true : undefined,
  };
}
