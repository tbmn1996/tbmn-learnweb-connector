/**
 * Parser für Moodle-Assignments (mod/assign).
 *
 * Struktur (Moodle 4.x, siehe test/fixtures/learnweb/assign.html):
 *   div.activity-header → enthält "Due:" / "Opens:" / "Closes:"
 *   div.activity-description → Beschreibung
 *   div.submissionstatustable table (submissionsummarytable)
 *     tr: th.c0 (Label) | td.c1 (Value)
 *     bekannte Labels: Submission status, Grading status, Grade,
 *                      Time remaining, Last modified, Group, Online text
 *
 * Wir liefern strukturierte Metadaten, aber KEIN Submission-Content
 * (kein Hochladen, kein Download) — das bleibt dem KI-Client überlassen,
 * wenn er das über andere Tools möchte.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { extractTextFromSelector, normalizeText, truncate } from "./common";

export interface AssignContent {
  description?: string;
  deadline?: string;
  opens?: string;
  closes?: string;
  submission_status?: string;
  grading_status?: string;
  grade?: string;
  time_remaining?: string;
  last_modified?: string;
  group?: string;
}

export interface AssignResult {
  title: string;
  content: AssignContent;
  parser_degraded?: boolean;
}

// Label → Feldname im Output (lowercase-Mapping).
// Wir halten die Liste bewusst kompakt; unbekannte Labels landen nirgendwo,
// bleiben aber im raw_text-Fallback sichtbar, falls parser_degraded.
const LABEL_MAP: Record<string, keyof AssignContent> = {
  "submission status": "submission_status",
  "grading status": "grading_status",
  "grade": "grade",
  "time remaining": "time_remaining",
  "last modified": "last_modified",
  "group": "group",
};

export async function parseAssign(
  session: LearnwebSession,
  cmid: number
): Promise<AssignResult> {
  const path = `/mod/assign/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return {
      title: `Assignment ${cmid}`,
      content: {},
      parser_degraded: true,
    };
  }

  const $ = cheerio.load(resp.data);
  const title =
    normalizeText($("h1, h2").first().text()) || `Assignment ${cmid}`;

  const content: AssignContent = {};

  // Description.
  const description =
    extractTextFromSelector($, ".activity-description", 2000) ||
    extractTextFromSelector($, "#intro", 2000) ||
    undefined;
  if (description) content.description = description;

  // Due/Opens/Closes stehen meist im activity-header als <strong>Label:</strong> Value.
  $(".activity-header .activity-dates div, .activity-header div").each((_, div) => {
    const text = normalizeText($(div).text());
    const m = text.match(/^(Due|Opens?|Closes?|Fällig|Fälligkeit)\s*:?\s*(.+)$/i);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key.startsWith("due") || key.startsWith("fäll")) content.deadline = value;
    else if (key.startsWith("open")) content.opens = value;
    else if (key.startsWith("close")) content.closes = value;
  });

  // Submission-Status-Tabelle durchgehen.
  $(".submissionstatustable tr, .submissionsummarytable tr").each((_, tr) => {
    const $tr = $(tr);
    const label = normalizeText($tr.find("th").first().text()).toLowerCase();
    if (!label) return;
    const value = normalizeText($tr.find("td").first().text());
    if (!value) return;
    const field = LABEL_MAP[label];
    if (field) {
      (content as Record<string, string>)[field] = truncate(value, 500);
    }
  });

  // Wenn weder description noch status-Felder gefunden: degraded.
  const hasAnything = Object.keys(content).length > 0;
  return {
    title,
    content,
    parser_degraded: hasAnything ? undefined : true,
  };
}
