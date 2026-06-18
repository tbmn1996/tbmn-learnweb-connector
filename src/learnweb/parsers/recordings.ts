/**
 * Erkennt und löst Aufzeichnungs-Quellen aus Kursaktivitäten auf.
 *
 * Discovery-Befunde (Uni Münster Learnweb, Juni 2026):
 *   - modtype "opencast" (mod_opencast, "eLectures Videos"): Listenseite
 *     /mod/opencast/view.php?id=<cmid> verlinkt Episoden (&e=<uuid>). Die
 *     Episoden-Detailseite bettet direkte mp4-Streams auf ele-cdn.uni-muenster.de
 *     ein (öffentlich abrufbar, kein Auth nötig).
 *   - modtype "resource": direkte Mediendatei (mp4) via pluginfile.php (Auth).
 *   - modtype "folder": kann Medien (mp3/mp4) enthalten ("Audio Recordings"),
 *     oft aber nur Folien (PDF) — Letztere werden über die Endung gefiltert.
 *
 * Reine Parse-Funktionen (HTML → Daten) sind von der HTTP-Orchestrierung
 * getrennt, damit sie offline gegen Fixtures testbar sind.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import type { LearnwebActivity } from "./overview";
import { absoluteUrl, normalizeText } from "./common";
import { parseResource } from "./resource";
import { parseFolder } from "./folder";

export type RecordingKind = "opencast" | "file";

export interface RecordingSource {
  title: string;
  kind: RecordingKind;
  /** Direkt abrufbare Medien-URL (mp4/mp3 …). */
  mediaUrl: string;
  /** true → Moodle-Session-Cookies nötig (pluginfile); false → öffentlich (ele-cdn). */
  needsAuth: boolean;
  /** Stabiler Diskriminator für den Manifest-Key (Episode-UUID oder Medien-URL). */
  discriminator: string;
  episodeId?: string;
  durationSeconds?: number;
}

// Medien-Endungen, die wir transkribieren (Video oder Audio).
const MEDIA_EXT_RE = /\.(mp4|m4v|m4a|mp3|webm|mov|mkv|aac|wav|ogg|opus)(\?|#|$)/i;

export function isMediaUrl(url: string): boolean {
  return MEDIA_EXT_RE.test(url);
}

/** "1:50:00" / "50:00" / "90" → Sekunden. */
export function parseDurationText(text?: string): number | undefined {
  if (!text) return undefined;
  const parts = text.trim().split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return undefined;
}

export interface OpencastEpisodeRef {
  episodeId: string;
  title: string;
  detailUrl: string;
  durationText?: string;
}

/** Parsed die mod_opencast-Episodenliste (Tabelle mit &e=<uuid>-Links). */
export function parseOpencastList(html: string, baseUrl: string): OpencastEpisodeRef[] {
  const $ = cheerio.load(html);
  const episodes: OpencastEpisodeRef[] = [];
  const seen = new Set<string>();

  $('a[href*="/mod/opencast/view.php"]').each((_, a) => {
    const rawHref = ($(a).attr("href") || "").replace(/&amp;/g, "&");
    const m = rawHref.match(/[?&]e=([0-9a-fA-F-]{36})/);
    if (!m) return;
    const episodeId = m[1].toLowerCase();
    if (seen.has(episodeId)) return;

    const title = normalizeText($(a).text());
    // Lang-Switch-Links ("de"/"en") auf dieselbe Episode überspringen.
    if (/^(de|en)$/i.test(title)) return;
    seen.add(episodeId);

    const durationText =
      normalizeText($(a).closest("tr").find("td").eq(1).text()) || undefined;
    episodes.push({
      episodeId,
      title: title || `Episode ${episodeId.slice(0, 8)}`,
      detailUrl: absoluteUrl(baseUrl, rawHref),
      durationText,
    });
  });

  return episodes;
}

/**
 * Extrahiert direkte mp4-Stream-URLs aus einer Opencast-Episode-Detailseite.
 * Die URLs stehen JSON-escaped (`https:\/\/…`) im eingebetteten Player-Config.
 */
export function parseOpencastEpisode(html: string): {
  mp4Urls: string[];
  durationSeconds?: number;
} {
  const mp4Urls: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+?\.mp4/gi)) {
    const url = m[0].replace(/\\\//g, "/");
    if (!seen.has(url)) {
      seen.add(url);
      mp4Urls.push(url);
    }
  }
  const durMatch = html.match(/"duration"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
  const durationSeconds = durMatch ? Math.round(Number.parseFloat(durMatch[1])) : undefined;
  return { mp4Urls, durationSeconds };
}

async function extractOpencast(
  session: LearnwebSession,
  activity: LearnwebActivity
): Promise<RecordingSource[]> {
  const baseUrl = session.getBaseUrl();
  const listResp = await session.get(`/mod/opencast/view.php?id=${activity.cmid}`);
  if (listResp.status < 200 || listResp.status >= 300) return [];

  const episodes = parseOpencastList(listResp.data, baseUrl);
  const sources: RecordingSource[] = [];
  for (const ep of episodes) {
    const detResp = await session.get(`/mod/opencast/view.php?id=${activity.cmid}&e=${ep.episodeId}`);
    if (detResp.status < 200 || detResp.status >= 300) continue;
    const { mp4Urls, durationSeconds } = parseOpencastEpisode(detResp.data);
    if (mp4Urls.length === 0) continue;
    sources.push({
      title: ep.title,
      kind: "opencast",
      mediaUrl: mp4Urls[0], // ein Track genügt — der Audiotrack ist in allen identisch
      needsAuth: false, // ele-cdn ist öffentlich
      discriminator: ep.episodeId,
      episodeId: ep.episodeId,
      durationSeconds: durationSeconds ?? parseDurationText(ep.durationText),
    });
  }
  return sources;
}

async function extractResource(
  session: LearnwebSession,
  activity: LearnwebActivity
): Promise<RecordingSource[]> {
  const r = await parseResource(session, activity.cmid);
  const url = r.content.download_url;
  if (!url || !isMediaUrl(url)) return [];
  return [
    {
      title: activity.name || r.title,
      kind: "file",
      mediaUrl: url,
      needsAuth: true,
      discriminator: url,
    },
  ];
}

async function extractFolder(
  session: LearnwebSession,
  activity: LearnwebActivity
): Promise<RecordingSource[]> {
  const r = await parseFolder(session, activity.cmid);
  return r.content.entries
    .filter((e) => isMediaUrl(e.download_url) || isMediaUrl(e.name))
    .map((e) => ({
      title: e.name,
      kind: "file" as const,
      mediaUrl: e.download_url,
      needsAuth: true,
      discriminator: e.download_url,
    }));
}

/**
 * Löst die Aufzeichnungs-Quellen einer Aktivität auf. Liefert [] für
 * Aktivitäten ohne transkribierbares Medium (z. B. Folien-PDFs).
 */
export async function extractRecordings(
  session: LearnwebSession,
  activity: LearnwebActivity
): Promise<RecordingSource[]> {
  switch (activity.modtype) {
    case "opencast":
      return extractOpencast(session, activity);
    case "resource":
      return extractResource(session, activity);
    case "folder":
      return extractFolder(session, activity);
    default:
      return [];
  }
}
