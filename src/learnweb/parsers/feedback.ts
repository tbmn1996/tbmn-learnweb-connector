/**
 * Parser für Moodle-Feedback (mod/feedback).
 *
 * Struktur (Moodle 4.x):
 *   div.activity-description → Beschreibung
 *   div.activity-header → Öffnungs-/Schließzeiten
 *   .feedbackbox / .feedbacksummary → Status (bereits ausgefüllt?)
 *
 * Feedback-Inhalte (Fragen) werden nicht extrahiert.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { extractTextFromSelector, normalizeText, truncate } from "./common";

export interface FeedbackContent {
  description?: string;
  opens?: string;
  closes?: string;
  already_submitted?: boolean;
  submission_count?: number;
}

export interface FeedbackResult {
  title: string;
  content: FeedbackContent;
  parser_degraded?: boolean;
}

export async function parseFeedback(
  session: LearnwebSession,
  cmid: number
): Promise<FeedbackResult> {
  const path = `/mod/feedback/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return { title: `Feedback ${cmid}`, content: {}, parser_degraded: true };
  }

  const $ = cheerio.load(resp.data);
  const title = normalizeText($("h1, h2").first().text()) || `Feedback ${cmid}`;
  const content: FeedbackContent = {};

  const description =
    extractTextFromSelector($, ".activity-description", 2000) ||
    extractTextFromSelector($, "#intro", 2000) ||
    undefined;
  if (description) content.description = description;

  $(".activity-header .activity-dates div, .activity-header div").each((_, div) => {
    const text = normalizeText($(div).text());
    const m = text.match(/^(Opens?|Closes?)\s*:?\s*(.+)$/i);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key.startsWith("open")) content.opens = value;
    else if (key.startsWith("close")) content.closes = value;
  });

  // Prüfen ob User bereits abgestimmt hat.
  const bodyText = $("body").text();
  if (/already\s+submitted|bereits\s+ausgefüllt|bereits\s+abgegeben/i.test(bodyText)) {
    content.already_submitted = true;
  }

  // Anzahl Antworten (öffentlich sichtbar bei anonymem Feedback).
  $(".feedbacksummary p, .generalbox p, #region-main p").each((_, p) => {
    const text = normalizeText($(p).text());
    const m = text.match(/(\d+)\s+(?:responses?|Antworten)/i);
    if (m) content.submission_count = parseInt(m[1], 10);
  });

  const hasAnything = Object.keys(content).length > 0;
  return { title, content, parser_degraded: hasAnything ? undefined : true };
}
