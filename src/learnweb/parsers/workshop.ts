/**
 * Parser für Moodle-Workshops (mod/workshop).
 *
 * Struktur (Moodle 4.x):
 *   div.activity-description → Beschreibung
 *   div.activity-header → Öffnungs-/Schließzeiten
 *   div.userplan / .phase → Aktuelle Phase des Workshops
 *   .submissionstatustable → Abgabe-Status des Users (falls vorhanden)
 *
 * Workshop-Phasen: Setup → Submission → Assessment → Grading → Closed.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { extractTextFromSelector, normalizeText, truncate } from "./common";

export interface WorkshopContent {
  description?: string;
  opens?: string;
  closes?: string;
  current_phase?: string;
  submission_status?: string;
  grade?: string;
}

export interface WorkshopResult {
  title: string;
  content: WorkshopContent;
  parser_degraded?: boolean;
}

export async function parseWorkshop(
  session: LearnwebSession,
  cmid: number
): Promise<WorkshopResult> {
  const path = `/mod/workshop/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return { title: `Workshop ${cmid}`, content: {}, parser_degraded: true };
  }

  const $ = cheerio.load(resp.data);
  const title = normalizeText($("h1, h2").first().text()) || `Workshop ${cmid}`;
  const content: WorkshopContent = {};

  const description =
    extractTextFromSelector($, ".activity-description", 2000) ||
    extractTextFromSelector($, "#intro", 2000) ||
    undefined;
  if (description) content.description = description;

  // Öffnungs-/Schließzeiten aus activity-header.
  $(".activity-header .activity-dates div, .activity-header div").each((_, div) => {
    const text = normalizeText($(div).text());
    const m = text.match(/^(Due|Opens?|Closes?|Fällig)\s*:?\s*(.+)$/i);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key.startsWith("open")) content.opens = value;
    else if (key.startsWith("close") || key.startsWith("fäll") || key.startsWith("due")) {
      content.closes = value;
    }
  });

  // Aktuelle Phase: .userplan .phase.active oder .phasebadge.
  const activePhase =
    normalizeText($(".userplan .phase.active .phasename, .userplan .phase.active .title, .phasebadge.active").first().text()) ||
    normalizeText($(".userplan .phase.current .phasename, .phasecurrent").first().text()) ||
    undefined;
  if (activePhase) content.current_phase = truncate(activePhase, 200);

  // Abgabestatus aus submission-Tabelle.
  $(".submissionstatustable tr, .submissionsummarytable tr").each((_, tr) => {
    const $tr = $(tr);
    const label = normalizeText($tr.find("th").first().text()).toLowerCase();
    const value = normalizeText($tr.find("td").first().text());
    if (!label || !value) return;
    if (label.includes("submission") || label.includes("abgabe")) {
      content.submission_status = truncate(value, 300);
    }
    if (label.includes("grade") || label.includes("note")) {
      content.grade = truncate(value, 100);
    }
  });

  const hasAnything = Object.keys(content).length > 0;
  return { title, content, parser_degraded: hasAnything ? undefined : true };
}
