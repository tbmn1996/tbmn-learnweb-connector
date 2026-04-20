/**
 * Parser für Moodle-URL-Aktivitäten (mod/url).
 *
 * Moodle bietet hier typischerweise eine Zwischenseite mit
 *   - Titel
 *   - Beschreibung
 *   - Link auf die externe Ziel-URL
 *
 * WICHTIG: Wir rufen die externe Ziel-URL NICHT ab. Der KI-Client kann das
 * selbst tun (mit eigener Rate-/Security-Policy), wir liefern nur die URL.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { absoluteUrl, extractTextFromSelector, normalizeText } from "./common";

export interface UrlContent {
  external_url?: string;
  description?: string;
}

export interface UrlResult {
  title: string;
  content: UrlContent;
  parser_degraded?: boolean;
}

export async function parseUrl(
  session: LearnwebSession,
  cmid: number
): Promise<UrlResult> {
  const path = `/mod/url/view.php?id=${cmid}`;
  const resp = await session.get(path);

  // Manche Moodle-Kurse konfigurieren mod/url so, dass die Ansicht direkt
  // zur externen URL redirected. Wir werten den Location-Header aus.
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers["location"];
    if (location) {
      return {
        title: `URL ${cmid}`,
        content: { external_url: location },
      };
    }
  }

  if (resp.status < 200 || resp.status >= 300) {
    return { title: `URL ${cmid}`, content: {}, parser_degraded: true };
  }

  const $ = cheerio.load(resp.data);
  const title = normalizeText($("h1, h2").first().text()) || `URL ${cmid}`;

  // Der echte externe Link steckt meistens in .urlworkaround a oder
  // in einem a-Tag mit redirect=1 Query-Param. Moodle baut oft ein
  // Wrapper-Link: /mod/url/view.php?id=<cmid>&redirect=1
  let externalUrl: string | undefined;
  const workaround = $(".urlworkaround a").first().attr("href");
  if (workaround) {
    externalUrl = absoluteUrl(session.getBaseUrl(), workaround);
  }
  if (!externalUrl) {
    // Erster Link im Content, der NICHT nach Moodle zeigt.
    $(".box.generalbox a, #intro a, main a").each((_, a) => {
      if (externalUrl) return;
      const href = $(a).attr("href");
      if (!href) return;
      if (href.includes("/mod/url/view.php") || href.includes("/login/")) return;
      if (href.startsWith("/")) return;
      if (href.startsWith(session.getBaseUrl())) return;
      externalUrl = href;
    });
  }

  const description =
    extractTextFromSelector($, ".activity-description", 2000) ||
    extractTextFromSelector($, ".box.generalbox", 2000) ||
    extractTextFromSelector($, "#intro", 2000) ||
    undefined;

  const content: UrlContent = {};
  if (externalUrl) content.external_url = externalUrl;
  if (description) content.description = description;

  const parser_degraded = !externalUrl;
  return {
    title,
    content,
    parser_degraded: parser_degraded || undefined,
  };
}
