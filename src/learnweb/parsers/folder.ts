/**
 * Parser für Moodle-Ordner (mod/folder).
 *
 * Struktur (Moodle 4.x):
 *   div.activity-description → Beschreibung
 *   div.foldertree / .fp-filename-icon → Dateiliste mit pluginfile.php-Links
 *
 * Wir liefern Datei-Metadaten (Name + Download-URL), kein tatsächlicher Download.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { absoluteUrl, extractTextFromSelector, normalizeText, truncate } from "./common";

export interface FolderEntry {
  name: string;
  download_url: string;
  size?: string;
}

export interface FolderContent {
  description?: string;
  entries: FolderEntry[];
}

export interface FolderResult {
  title: string;
  content: FolderContent;
  parser_degraded?: boolean;
}

export async function parseFolder(
  session: LearnwebSession,
  cmid: number
): Promise<FolderResult> {
  const path = `/mod/folder/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return { title: `Folder ${cmid}`, content: { entries: [] }, parser_degraded: true };
  }

  const $ = cheerio.load(resp.data);
  const title = normalizeText($("h1, h2").first().text()) || `Folder ${cmid}`;

  const description =
    extractTextFromSelector($, ".activity-description", 2000) ||
    extractTextFromSelector($, "#intro", 2000) ||
    undefined;

  const entries: FolderEntry[] = [];

  // Moodle 4.x: Ordner-Ansicht hat Links auf pluginfile.php.
  // Mehrere mögliche Wrapper: .foldertree, .fp-filename-icon, oder einfach region-main-Links.
  const linkSelectors = [
    ".foldertree a[href*='pluginfile.php']",
    ".fp-filename-icon a[href*='pluginfile.php']",
    ".filemanager a[href*='pluginfile.php']",
    "#region-main a[href*='pluginfile.php']",
    "a[href*='pluginfile.php']",
  ];

  const seen = new Set<string>();
  for (const sel of linkSelectors) {
    $(sel).each((_, a) => {
      const href = $(a).attr("href");
      if (!href || seen.has(href)) return;
      seen.add(href);

      const absUrl = absoluteUrl(session.getBaseUrl(), href);
      // Dateiname: aus span.fp-filename, eigenem Text oder URL.
      const nameEl = $(a).find(".fp-filename, .filename").first();
      const rawName = normalizeText(nameEl.text() || $(a).text());
      const name = rawName || decodeURIComponent(href.split("/").pop()?.split("?")[0] ?? "Unbekannte Datei");

      // Dateigröße: ggf. im nächsten Geschwisterelement.
      const sizeText = normalizeText($(a).closest("li, tr").find(".fp-size, .filesize").first().text());

      entries.push({
        name: truncate(name, 300),
        download_url: absUrl,
        size: sizeText || undefined,
      });
    });
    if (entries.length > 0) break;
  }

  const hasAnything = description !== undefined || entries.length > 0;
  return {
    title,
    content: { description, entries },
    parser_degraded: hasAnything ? undefined : true,
  };
}
