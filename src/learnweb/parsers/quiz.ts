/**
 * Parser für Moodle-Quizze (mod/quiz).
 *
 * WICHTIG: Wir lesen AUSSCHLIESSLICH die Quiz-Infoseite (Vor-Attempt-View).
 * Der Parser extrahiert keine Fragen, keine Antworten und keine Ergebnisse —
 * das wäre akademisch problematisch und eine deutliche Ausweitung der
 * MCP-Surface.
 *
 * Struktur (Moodle 4.x, siehe test/fixtures/learnweb/quiz.html):
 *   div.activity-header  → Opens/Closes
 *   div.activity-description → Beschreibung
 *   div.quizinfo         → "Grading method: ...", "Attempts allowed: ...", "Grade: ..."
 *   div.quizattempt / table.quizattemptsummary → Bisherige Attempts
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { absoluteUrl, extractTextFromSelector, normalizeText, parseMoodleDate, truncate } from "./common";

export interface QuizAttemptSummary {
  attempt_number: number;
  state?: string;
  started?: string;
  completed?: string;
  marks?: string;
  grade?: string;
  review_url?: string;
}

export interface QuizContent {
  description?: string;
  opens?: string;
  closes?: string;
  grading_method?: string;
  attempts_allowed?: string;
  attempts_used?: number;
  attempts_remaining?: number;
  overall_grade?: string;
  status: "not_open" | "open" | "in_progress" | "submitted" | "closed" | "unknown";
  attempts?: QuizAttemptSummary[];
}

export interface QuizResult {
  title: string;
  content: QuizContent;
  parser_degraded?: boolean;
}

export async function parseQuiz(
  session: LearnwebSession,
  cmid: number
): Promise<QuizResult> {
  const path = `/mod/quiz/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return {
      title: `Quiz ${cmid}`,
      content: { status: "unknown" },
      parser_degraded: true,
    };
  }

  const $ = cheerio.load(resp.data);
  const title = normalizeText($("h1, h2").first().text()) || `Quiz ${cmid}`;

  const content: Omit<QuizContent, "status"> & { status?: QuizContent["status"] } = {};

  const description =
    extractTextFromSelector($, ".activity-description", 2000) ||
    extractTextFromSelector($, "#intro", 2000) ||
    undefined;
  if (description) content.description = description;

  // Opens/Closes aus activity-header.
  $(".activity-header .activity-dates div, .activity-header div").each((_, div) => {
    const text = normalizeText($(div).text());
    const m = text.match(/^(Opened?|Opens?|Closes?|Geöffnet|Öffnet|Schließt)\s*:?\s*(.+)$/i);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key.startsWith("open") || key.startsWith("geöff") || key.startsWith("öffn")) {
      content.opens = value;
    } else if (key.startsWith("close") || key.startsWith("schließ")) {
      content.closes = value;
    }
  });

  // quizinfo-Block: Grading method, Attempts allowed, Overall grade.
  $(".quizinfo p, .quizinfo li, .quizinfo div").each((_, el) => {
    const text = normalizeText($(el).text());
    const grading = text.match(/^Grading method\s*:\s*(.+)$/i);
    if (grading) {
      content.grading_method = truncate(grading[1].trim(), 200);
      return;
    }
    const attempts = text.match(/^Attempts?\s+allowed\s*:\s*(.+)$/i);
    if (attempts) {
      content.attempts_allowed = truncate(attempts[1].trim(), 100);
      return;
    }
    const grade = text.match(/^(?:Your\s+)?(?:final\s+)?grade\s*:\s*(.+)$/i);
    if (grade) {
      content.overall_grade = truncate(grade[1].trim(), 100);
    }
  });

  // Attempt-Tabelle: Moodle 4.x nutzt .quizattemptsummary oder .generaltable innerhalb .quizattempt.
  const attempts: QuizAttemptSummary[] = [];
  const attemptSelector =
    "table.quizattemptsummary tbody tr, .quizattempt table tbody tr, .generaltable.quizattemptsummary tbody tr";

  $(attemptSelector).each((_, tr) => {
    const $tr = $(tr);
    const cells = $tr.find("td, th");
    if (cells.length < 2) return;

    const attemptSummary: Partial<QuizAttemptSummary> = {};

    // Moodle rendert die Attempt-Tabelle mit variierenden Spaltenreihenfolgen.
    // Wir erkennen die Spalten per Inhalt/Link statt per Position.
    cells.each((i, cell) => {
      const $cell = $(cell);
      const text = normalizeText($cell.text());

      // Spalte 0 ist meist die Attempt-Nummer.
      if (i === 0) {
        const num = parseInt(text, 10);
        if (!Number.isNaN(num)) attemptSummary.attempt_number = num;
      }

      // State-Erkennung.
      if (/^(finished|in progress|abgeschlossen|in bearbeitung|never submitted|überprüfen)/i.test(text)) {
        attemptSummary.state = text;
      }

      // Marks (z.B. "8.00/10.00").
      if (/^\d[\d.,/\s]+$/.test(text) && text.includes("/")) {
        attemptSummary.marks = text;
      }

      // Grade (z.B. "80.00%").
      if (/^\d[\d.,]+\s*%$/.test(text)) {
        attemptSummary.grade = text;
      }

      // Review-Link.
      const reviewHref = $cell.find('a[href*="/mod/quiz/review.php"]').attr("href");
      if (reviewHref) {
        attemptSummary.review_url = absoluteUrl(session.getBaseUrl(), reviewHref);
      }
    });

    if (typeof attemptSummary.attempt_number === "number") {
      attempts.push(attemptSummary as QuizAttemptSummary);
    }
  });

  // Maximal 10 Attempts im Output.
  if (attempts.length > 0) {
    content.attempts = attempts.slice(0, 10);
    content.attempts_used = attempts.length;

    // attempts_remaining ableiten, falls attempts_allowed eine Zahl ist.
    if (content.attempts_allowed) {
      const allowed = parseInt(content.attempts_allowed, 10);
      if (!Number.isNaN(allowed)) {
        content.attempts_remaining = Math.max(0, allowed - attempts.length);
      }
    }
  } else {
    content.attempts_used = 0;
  }

  // Status-Heuristik.
  content.status = deriveStatus(content as QuizContent, attempts);

  const hasAnything = !!(
    content.description || content.opens || content.closes ||
    content.grading_method || attempts.length > 0
  );

  return {
    title,
    content: content as QuizContent,
    parser_degraded: hasAnything ? undefined : true,
  };
}

function deriveStatus(
  content: QuizContent,
  attempts: QuizAttemptSummary[]
): QuizContent["status"] {
  const now = Date.now();

  if (content.opens) {
    const openDate = parseMoodleDate(content.opens);
    if (openDate && openDate.getTime() > now) return "not_open";
  }

  if (content.closes) {
    const closeDate = parseMoodleDate(content.closes);
    if (closeDate && closeDate.getTime() < now) return "closed";
  }

  if (attempts.some((a) => /in progress|in bearbeitung/i.test(a.state ?? ""))) {
    return "in_progress";
  }

  if (attempts.some((a) => /finished|abgeschlossen/i.test(a.state ?? ""))) {
    return "submitted";
  }

  if (attempts.length > 0) return "submitted";

  return "open";
}
