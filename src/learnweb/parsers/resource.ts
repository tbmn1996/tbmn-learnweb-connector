/**
 * Parser für Moodle-Ressourcen (mod/resource = Dateien, die als Download
 * oder eingebettet dargestellt werden).
 *
 * WICHTIG: Der Parser lädt die Datei nicht herunter. Er extrahiert nur
 * Metadaten + download_url; der optionale Dateiinhalt läuft über das separate
 * Tool learnweb-download-resource mit Größenlimit.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession, LearnwebResponse } from "../session";
import { absoluteUrl, extractTextFromSelector, normalizeText, truncate } from "./common";

export interface ResourceContent {
  filename?: string;
  filesize?: string;
  download_url?: string;
  description?: string;
}

export interface ResourceResult {
  title: string;
  content: ResourceContent;
  parser_degraded?: boolean;
}

// Regex für Content-Disposition filename, matcht das Python-Pendant.
const FILENAME_RE = /filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i;

/**
 * Liest die View-Seite einer Ressource.
 *
 * Moodle verhält sich hier unterschiedlich:
 *   1. Manche Ressourcen redirecten direkt zur Datei (Location: pluginfile.php/…).
 *   2. Andere liefern HTML mit einem Download-Link (häufig bei PDF-Inline-Viewer).
 *   3. Bei der zweiten Variante steckt der Link meist in <a href="*pluginfile.php*">
 *      oder <a href="*?forcedownload=1">.
 *
 * Wir folgen Redirects NICHT blind (Session könnte abgeschnitten werden, siehe
 * maxRedirects:0 in Session), sondern werten den Location-Header selbst aus.
 */
export async function parseResource(
  session: LearnwebSession,
  cmid: number
): Promise<ResourceResult> {
  const path = `/mod/resource/view.php?id=${cmid}`;
  const resp = await session.get(path);

  // Direct-Redirect auf den Download?
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers["location"];
    if (location) {
      return {
        title: `Resource ${cmid}`,
        content: {
          download_url: absoluteUrl(session.getBaseUrl(), location),
        },
      };
    }
  }

  // HTML-Seite mit eingebettetem Download-Link.
  if (resp.status >= 200 && resp.status < 300) {
    return parseResourceHtml(resp, cmid, session.getBaseUrl());
  }

  // Unerwarteter Status — degraded liefern statt werfen, damit der
  // KI-Client wenigstens etwas Kontext bekommt.
  return {
    title: `Resource ${cmid}`,
    content: {},
    parser_degraded: true,
  };
}

function parseResourceHtml(
  resp: LearnwebResponse,
  cmid: number,
  baseUrl: string
): ResourceResult {
  const $ = cheerio.load(resp.data);
  const title =
    normalizeText($("h1, h2").first().text()) || `Resource ${cmid}`;

  // Beschreibung (oft im div.activity-description oder #intro).
  const description =
    extractTextFromSelector($, ".activity-description", 2000) ||
    extractTextFromSelector($, ".box.generalbox", 2000) ||
    extractTextFromSelector($, "#intro", 2000) ||
    undefined;

  // Download-Link: Priorität 1 = pluginfile, 2 = forcedownload.
  let downloadUrl: string | undefined;
  $('a[href*="pluginfile.php"]').each((_, a) => {
    if (downloadUrl) return;
    const href = $(a).attr("href");
    if (href) downloadUrl = absoluteUrl(baseUrl, href);
  });
  if (!downloadUrl) {
    $('a[href*="forcedownload"]').each((_, a) => {
      if (downloadUrl) return;
      const href = $(a).attr("href");
      if (href) downloadUrl = absoluteUrl(baseUrl, href);
    });
  }

  // Filename + Filesize: Moodle zeigt diese oft in einem .resourceworkaround
  // oder in einer Dateiliste.
  let filename: string | undefined;
  let filesize: string | undefined;
  const resourceSection = $(".resourcecontent, .resourceworkaround, .filedetails").first();
  if (resourceSection.length > 0) {
    const text = normalizeText(resourceSection.text());
    const sizeMatch = text.match(/(\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|Bytes?))/i);
    if (sizeMatch) filesize = sizeMatch[1];
  }
  // Filename aus letztem Pfadsegment der Download-URL ableiten.
  if (downloadUrl) {
    try {
      const u = new URL(downloadUrl);
      const last = decodeURIComponent(u.pathname.split("/").pop() || "");
      if (last) filename = last;
    } catch {
      // ignore
    }
  }

  const content: ResourceContent = {};
  if (filename) content.filename = filename;
  if (filesize) content.filesize = filesize;
  if (downloadUrl) content.download_url = downloadUrl;
  if (description) content.description = truncate(description, 2000);

  const parser_degraded = !downloadUrl && !description;
  return {
    title,
    content,
    parser_degraded: parser_degraded || undefined,
  };
}

/** Exportiert für Testbarkeit. */
export const _testing = { FILENAME_RE };
