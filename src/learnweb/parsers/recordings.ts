/**
 * Discovery + Parsing für Opencast-Vorlesungsaufzeichnungen (mod_opencast).
 *
 * Uni-Münster-Learnweb kennt zwei Seitenformate für Opencast-Aktivitäten:
 *   - NEU: eine Moodle-Aktivität entspricht direkt einer Episode. Die
 *     Player-Metadaten stehen als `window.episode = {...}` (oder
 *     `window.episode = JSON.parse("...")`) eingebettet im HTML.
 *   - ALT: eine Aktivität listet mehrere Episoden über `&e=<uuid>`-Links auf
 *     einer Übersichtsseite; die eigentlichen Stream-URLs liegen erst auf der
 *     jeweiligen Detailseite (dort teils wieder im window.episode-Format,
 *     teils in einem älteren Player-Init-Aufruf ohne window.episode).
 *
 * Reine Parse-Funktionen (HTML → Daten) sind bewusst von der HTTP-
 * Orchestrierung getrennt, damit sie offline gegen Fixtures testbar sind.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { parseCourseOverview } from "./overview";
import { absoluteUrl, normalizeText } from "./common";

export interface ParsedEpisode {
  episodeId: string | null;
  title: string | null;
  mediaUrl: string | null;
  recordedAt: string | null;
  sourceUrl: string | null;
}

// Rekursiv durchsuchbarer JSON-Wert (Ergebnis von JSON.parse).
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Extrahiert den JSON-Text hinter `window.episode = ...;`.
 * Unterstützt sowohl das direkte Objektliteral (`window.episode = {...};`)
 * als auch die String-verpackte Variante (`window.episode = JSON.parse("...");`).
 * Nutzt einen klammerbalancierten Scan statt eines gierigen Regex, damit
 * verschachtelte `{}` in den Metadaten den Schnitt nicht vorzeitig beenden.
 *
 * Iteriert ALLE `window.episode\s*=` Fundstellen (statt nur der ersten) und
 * überspringt Treffer ohne gültige Fortsetzung — Fixture-Kommentare, die
 * "window.episode" nur beiläufig erwähnen (z. B. "...aus window.episode; es
 * gibt keine &e=-Links."), dürfen den echten Script-Block nicht verdecken.
 */
function extractWindowEpisodeJsonText(html: string): string | null {
  const anchorPattern = /window\.episode\s*=\s*/g;
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorPattern.exec(html)) !== null) {
    const extracted = tryExtractEpisodeJsonAt(html, anchorMatch.index + anchorMatch[0].length);
    if (extracted) return extracted;
  }
  return null;
}

function tryExtractEpisodeJsonAt(html: string, start: number): string | null {
  const i = start;

  // Variante: window.episode = JSON.parse("...") bzw. JSON.parse('...')
  if (html.startsWith("JSON.parse", i)) {
    let j = i + "JSON.parse".length;
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] !== "(") return null;
    j++;
    while (j < html.length && /\s/.test(html[j])) j++;
    const quote = html[j];
    if (quote !== '"' && quote !== "'") return null;
    j++;
    let raw = "";
    while (j < html.length && html[j] !== quote) {
      if (html[j] === "\\" && j + 1 < html.length) {
        raw += html[j] + html[j + 1];
        j += 2;
      } else {
        raw += html[j];
        j++;
      }
    }
    try {
      // Stringliteral-Inhalt über JSON.parse dekodieren (Escapes auflösen).
      // Bei Single-Quote-Strings müssen \' entschärft und rohe " maskiert werden.
      const jsonEscaped =
        quote === '"' ? raw : raw.replace(/\\'/g, "'").replace(/"/g, '\\"');
      return JSON.parse(`"${jsonEscaped}"`) as string;
    } catch {
      return null;
    }
  }

  // Variante: window.episode = { ... };  (Objektliteral, balancierte Klammern)
  if (html[i] !== "{") return null;
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let end = -1;
  for (let k = i; k < html.length; k++) {
    const c = html[k];
    if (inString) {
      if (c === "\\") {
        k++; // Escaped Zeichen überspringen (auch das escapte Quote-Zeichen).
        continue;
      }
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = k;
        break;
      }
    }
  }
  if (end === -1) return null;
  return html.slice(i, end + 1);
}

/** Sucht rekursiv die erste String-Property, die auf `.mp4` endet. */
function findMp4Url(value: JsonValue | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    return /\.mp4(\?|#|$)/i.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMp4Url(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      const found = findMp4Url(value[key]);
      if (found) return found;
    }
  }
  return null;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, JsonValue>;
  }
  return {};
}

function asStringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Parst das neue Opencast-Format: `window.episode = {...}` im HTML.
 * Liefert `[]` (kein Fehler), wenn kein window.episode gefunden wird.
 */
export function parseWindowEpisode(html: string, baseUrl: string): ParsedEpisode[] {
  const jsonText = extractWindowEpisodeJsonText(html);
  if (!jsonText) return [];

  let episode: JsonValue;
  try {
    episode = JSON.parse(jsonText) as JsonValue;
  } catch {
    return [];
  }
  if (!episode || typeof episode !== "object" || Array.isArray(episode)) return [];

  const episodeRecord = episode as Record<string, JsonValue>;
  const metadata = asRecord(episodeRecord.metadata);

  const episodeIdRaw =
    asStringOrNull(metadata.id) ??
    asStringOrNull(metadata.episodeId) ??
    asStringOrNull(episodeRecord.id) ??
    asStringOrNull(episodeRecord.episodeId);
  const episodeId = episodeIdRaw ? episodeIdRaw.toLowerCase() : null;

  const titleRaw = asStringOrNull(metadata.title) ?? asStringOrNull(episodeRecord.title);
  const title = titleRaw ? normalizeText(titleRaw) || null : null;

  // recordedAt wird NIE geraten — nur übernommen, wenn im Objekt vorhanden.
  const recordedAt =
    asStringOrNull(metadata.created) ??
    asStringOrNull(metadata.start) ??
    asStringOrNull(episodeRecord.created) ??
    null;

  const mediaUrlRaw =
    findMp4Url(episodeRecord.streams) ??
    findMp4Url(episodeRecord.publications) ??
    findMp4Url(episodeRecord);
  const mediaUrl = mediaUrlRaw ? absoluteUrl(baseUrl, mediaUrlRaw) : null;

  return [
    {
      episodeId,
      title,
      mediaUrl,
      recordedAt,
      sourceUrl: null,
    },
  ];
}

/**
 * Parst das alte Opencast-Format: eine Episodenliste mit `&e=<uuid>`-Links.
 * `mediaUrl` bleibt hier immer `null` — sie ist erst auf der Detailseite
 * auflösbar (siehe `discoverActivityRecordings`).
 *
 * Dedupliziert Sprach-Switch-Duplikate derselben Episode-UUID (bevorzugt
 * `lang=de`, sonst bleibt der erste Treffer stehen).
 */
export function parseLegacyEpisodeList(html: string, baseUrl: string): ParsedEpisode[] {
  const $ = cheerio.load(html);
  const episodes: ParsedEpisode[] = [];
  const indexByEpisodeId = new Map<string, number>();

  $('a[href*="/mod/opencast/view.php"]').each((_, a) => {
    const href = $(a).attr("href") || "";
    const idMatch = href.match(/[?&]e=([0-9a-fA-F-]{36})/);
    if (!idMatch) return;
    const episodeId = idMatch[1].toLowerCase();

    const linkText = normalizeText($(a).text());
    // Reine Sprachumschalter-Links ("de"/"en") sind keine echten Episoden-Titel.
    const isLangSwitchLink = /^(de|en)$/i.test(linkText);
    const langParam = href.match(/[?&]lang=(de|en)\b/i)?.[1]?.toLowerCase();
    const sourceUrl = absoluteUrl(baseUrl, href);

    const existingIndex = indexByEpisodeId.get(episodeId);
    if (existingIndex !== undefined) {
      // Schon gesehen: nur überschreiben, wenn der neue Treffer explizit
      // lang=de ist UND kein reiner Sprachumschalter-Link (sonst würde ein
      // sinnvoller Titel durch den Linktext "de" ersetzt).
      if (langParam === "de" && !isLangSwitchLink) {
        episodes[existingIndex] = {
          episodeId,
          title: linkText || null,
          mediaUrl: null,
          recordedAt: null,
          sourceUrl,
        };
      }
      return;
    }

    indexByEpisodeId.set(episodeId, episodes.length);
    episodes.push({
      episodeId,
      title: isLangSwitchLink ? null : linkText || null,
      mediaUrl: null,
      recordedAt: null,
      sourceUrl,
    });
  });

  return episodes;
}

/**
 * Versucht zuerst das neue window.episode-Format, fällt sonst auf die alte
 * Episodenliste zurück.
 */
export function parseOpencastEpisodes(html: string, baseUrl: string): ParsedEpisode[] {
  const direct = parseWindowEpisode(html, baseUrl);
  if (direct.length > 0) return direct;
  return parseLegacyEpisodeList(html, baseUrl);
}

export interface OpencastRecording {
  cmid: number;
  title: string;
  episode_id: string | null;
  media_url: string;
  recorded_at: string | null;
  source_url: string;
}

/** Roher mp4-Regex-Fallback für Detailseiten, die kein window.episode nutzen. */
function extractMp4UrlFromRawHtml(html: string): string | null {
  const normalized = html.replace(/\\\//g, "/");
  const match = normalized.match(/https?:\/\/[^"'\s]+\.mp4/);
  return match ? match[0] : null;
}

/**
 * Löst die Aufzeichnungen einer einzelnen Opencast-Aktivität auf.
 * Episoden ohne auflösbare mediaUrl werden NICHT ins Ergebnis aufgenommen.
 */
export async function discoverActivityRecordings(
  session: LearnwebSession,
  cmid: number,
  viewUrl: string
): Promise<OpencastRecording[]> {
  const resp = await session.get(viewUrl);
  if (resp.status < 200 || resp.status >= 300) return [];

  const baseUrl = session.getBaseUrl();
  const episodes = parseOpencastEpisodes(resp.data, baseUrl);
  const fallbackSourceUrl = absoluteUrl(baseUrl, viewUrl);

  const results: OpencastRecording[] = [];
  for (const episode of episodes) {
    let mediaUrl = episode.mediaUrl;
    let title = episode.title;
    let recordedAt = episode.recordedAt;
    let episodeId = episode.episodeId;
    const sourceUrl = episode.sourceUrl ?? fallbackSourceUrl;

    if (!mediaUrl && episode.sourceUrl) {
      try {
        const detailResp = await session.get(episode.sourceUrl);
        if (detailResp.status >= 200 && detailResp.status < 300) {
          const detailEpisodes = parseWindowEpisode(detailResp.data, baseUrl);
          if (detailEpisodes.length > 0 && detailEpisodes[0].mediaUrl) {
            mediaUrl = detailEpisodes[0].mediaUrl;
            title = title ?? detailEpisodes[0].title;
            recordedAt = recordedAt ?? detailEpisodes[0].recordedAt;
            episodeId = episodeId ?? detailEpisodes[0].episodeId;
          } else {
            mediaUrl = extractMp4UrlFromRawHtml(detailResp.data);
          }
        }
      } catch (err) {
        // Einzelne Detailseite fehlgeschlagen — Episode überspringen, nicht
        // die ganze Aktivität abbrechen.
        console.error(
          `discoverActivityRecordings: Detailseite für Episode (cmid ${cmid}) konnte nicht geladen werden:`,
          err instanceof Error ? err.message : String(err)
        );
        continue;
      }
    }

    if (!mediaUrl) continue; // ohne Medien-URL kein Sinn

    results.push({
      cmid,
      title: title || `Recording ${cmid}`,
      episode_id: episodeId,
      media_url: mediaUrl,
      recorded_at: recordedAt,
      source_url: sourceUrl,
    });
  }
  return results;
}

export interface CourseRecordingsResult {
  course_id: number;
  course_name: string;
  opencast_activities_found: number;
  recordings: OpencastRecording[];
  parser_degraded?: boolean;
}

export type CourseRecordingsOutcome = CourseRecordingsResult | { error: true; message: string };

/**
 * Löst alle Opencast-Aufzeichnungen eines Kurses auf. Iteriert alle
 * Sections/Activities der Kursübersicht, filtert auf modtype "opencast".
 * Einzelne fehlschlagende Aktivitäten brechen den Kurs-Scan nicht ab —
 * sie werden übersprungen und über `parser_degraded: true` markiert.
 */
export async function discoverCourseRecordings(
  session: LearnwebSession,
  courseId: number
): Promise<CourseRecordingsOutcome> {
  const resp = await session.get(`/course/view.php?id=${courseId}`);
  if (resp.status < 200 || resp.status >= 300) {
    return { error: true, message: `Could not load course ${courseId}.` };
  }

  const overview = parseCourseOverview(resp.data, courseId, session.getBaseUrl());
  const opencastActivities = overview.sections.flatMap((section) =>
    section.activities.filter((activity) => activity.modtype === "opencast")
  );

  const recordings: OpencastRecording[] = [];
  let parserDegraded = false;

  for (const activity of opencastActivities) {
    try {
      const activityRecordings = await discoverActivityRecordings(
        session,
        activity.cmid,
        activity.url
      );
      recordings.push(...activityRecordings);
    } catch (err) {
      parserDegraded = true;
      console.error(
        `discoverCourseRecordings: Opencast-Aktivität ${activity.cmid} in Kurs ${courseId} konnte nicht verarbeitet werden:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  const result: CourseRecordingsResult = {
    course_id: courseId,
    course_name: overview.course_name,
    opencast_activities_found: opencastActivities.length,
    recordings,
  };
  if (parserDegraded) result.parser_degraded = true;
  return result;
}
