/**
 * Parser für Moodle-Lektionen (mod/lesson).
 *
 * Struktur (Moodle 4.x):
 *   div.activity-description → Beschreibung
 *   div.activity-header → Öffnungs-/Schließzeiten
 *   .lesson-infosummary / .generalbox → Zusammenfassung (z.B. Score, Versuche)
 *
 * Lektionen enthalten interaktive Inhalte (Seiten + Fragen); wir lesen
 * ausschließlich die Metadaten der Einstiegsseite.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { extractTextFromSelector, normalizeText, truncate } from "./common";

export interface LessonContent {
  description?: string;
  opens?: string;
  closes?: string;
  attempts_used?: number;
  best_score?: string;
}

export interface LessonResult {
  title: string;
  content: LessonContent;
  parser_degraded?: boolean;
}

export async function parseLesson(
  session: LearnwebSession,
  cmid: number
): Promise<LessonResult> {
  const path = `/mod/lesson/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return { title: `Lesson ${cmid}`, content: {}, parser_degraded: true };
  }

  const $ = cheerio.load(resp.data);
  const title = normalizeText($("h1, h2").first().text()) || `Lesson ${cmid}`;
  const content: LessonContent = {};

  const description =
    extractTextFromSelector($, ".activity-description", 2000) ||
    extractTextFromSelector($, "#intro", 2000) ||
    undefined;
  if (description) content.description = description;

  $(".activity-header .activity-dates div, .activity-header div").each((_, div) => {
    const text = normalizeText($(div).text());
    const m = text.match(/^(Opens?|Closes?|Available|Deadline)\s*:?\s*(.+)$/i);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key.startsWith("open") || key.startsWith("avail")) content.opens = value;
    else if (key.startsWith("close") || key.startsWith("dead")) content.closes = value;
  });

  // Zusammenfassungsblock.
  $(".lesson-infosummary p, .generalbox p, #region-main p").each((_, p) => {
    const text = normalizeText($(p).text());
    const attempts = text.match(/^(?:Number of|Anzahl\s+der)\s+Attempts?\s*:\s*(\d+)/i);
    if (attempts) {
      content.attempts_used = parseInt(attempts[1], 10);
      return;
    }
    const score = text.match(/^(?:Best|Bester)?\s*(?:Score|Punktzahl)\s*:\s*(.+)$/i);
    if (score) content.best_score = truncate(score[1].trim(), 100);
  });

  const hasAnything = Object.keys(content).length > 0;
  return { title, content, parser_degraded: hasAnything ? undefined : true };
}
