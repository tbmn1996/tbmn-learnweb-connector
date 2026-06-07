/**
 * Parser für die Moodle-Quiz-REVIEW-Seite (mod/quiz/review.php).
 *
 * BEWUSSTE AUSNAHME zur Designgrenze in quiz.ts:
 * quiz.ts liest absichtlich nur die Quiz-Infoseite (view.php) und KEINE
 * Fragen/Antworten/Ergebnisse. Dieser Parser ist die sanktionierte Ausnahme
 * davon — er liest AUSSCHLIESSLICH den EIGENEN, BEREITS ABGESCHLOSSENEN Versuch
 * des angemeldeten Nutzers, hinter einem explizit benannten Tool
 * (learnweb-read-quiz-review), zur persönlichen Fehleranalyse.
 * Keine fremden Versuche, keine laufenden Quizze, kein Auslesen von Lösungen
 * vor der eigenen Abgabe.
 *
 * Struktur (Moodle 4.x, siehe test/fixtures/learnweb/quiz-review.html):
 *   table.quizreviewsummary → Kopf (State, Started, Completed, Time taken, Marks, Grade)
 *   div.que.<state>         → eine Frage; state-Klasse: correct | incorrect |
 *                             partiallycorrect | notanswered
 *     div.info  → h3.no/.qno (Nummer), .state (Text), .grade (Mark x out of y)
 *     div.content
 *       .formulation .qtext           → Fragetext
 *       .formulation .answer .rN      → Optionen; gewählte hat <input ... checked>
 *       .outcome .feedback
 *         .specificfeedback           → Rückmeldung zur eigenen Antwort
 *         .rightanswer                → "The correct answer is: ..."
 *         .generalfeedback            → allgemeine Erklärung
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { normalizeText, truncate } from "./common";

/** Kopfdaten der Auswertung (eine Zeile pro Label in quizreviewsummary). */
export interface QuizReviewHeader {
  state?: string;
  started?: string;
  completed?: string;
  time_taken?: string;
  marks?: string;
  grade?: string;
}

/** Eine ausgewertete Einzelfrage des Versuchs. */
export interface QuizReviewQuestion {
  number?: number;
  state?: string;
  is_correct?: boolean;
  marks?: string;
  question_text?: string;
  /** Die vom Nutzer gewählten Antwort-Optionen (Mehrfachauswahl möglich). */
  your_answer?: string[];
  /** Musterlösung, extrahiert aus dem .rightanswer-Block. */
  correct_answer?: string;
  /** Allgemeine Erklärung (Moodle: generalfeedback). */
  explanation?: string;
  /** Rückmeldung zur konkreten eigenen Antwort (Moodle: specificfeedback). */
  specific_feedback?: string;
}

export interface QuizReviewResult {
  title: string;
  header: QuizReviewHeader;
  questions: QuizReviewQuestion[];
  parser_degraded?: boolean;
}

export async function parseQuizReview(
  session: LearnwebSession,
  cmid: number,
  attempt: number
): Promise<QuizReviewResult> {
  // Reihenfolge der Query-Parameter ist bindend (attempt vor cmid) — der Test
  // matcht den Pfad per exaktem String.
  const path = `/mod/quiz/review.php?attempt=${attempt}&cmid=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return {
      title: `Quiz-Review ${attempt}`,
      header: {},
      questions: [],
      parser_degraded: true,
    };
  }

  const $ = cheerio.load(resp.data);
  const title =
    normalizeText($("h1, h2").first().text()) || `Quiz-Review ${attempt}`;

  const header = parseHeader($);

  // Vertrags-Guard: Fragen + Musterlösungen werden NUR für einen eindeutig
  // ABGESCHLOSSENEN eigenen Versuch ausgeliefert. Ist der Status nicht
  // erkennbar "finished/beendet" (z. B. laufender Versuch, Login-Redirect,
  // Markup-Änderung), geben wir nur die Kopf-Metadaten ohne Fragen zurück und
  // markieren das Ergebnis als degraded. So hängt der Tool-Vertrag nicht allein
  // an Moodle-/UI-Annahmen, sondern wird im Code erzwungen.
  const FINISHED_STATE_RE = /\b(finished|beendet|abgeschlossen|completed)\b/i;
  if (!header.state || !FINISHED_STATE_RE.test(header.state)) {
    return { title, header, questions: [], parser_degraded: true };
  }

  const questions = parseQuestions($);

  // Degraded, wenn trotz finished-Status keine Frage erkannt wurde
  // (z. B. Markup-Änderung).
  return {
    title,
    header,
    questions,
    parser_degraded: questions.length > 0 ? undefined : true,
  };
}

/**
 * Liest die Kopf-Tabelle label-basiert (nicht positions-basiert), da Moodle die
 * Zeilen je nach Quiz-Konfiguration unterschiedlich anordnet/auslässt.
 */
function parseHeader($: cheerio.CheerioAPI): QuizReviewHeader {
  const header: QuizReviewHeader = {};

  $("table.quizreviewsummary tr").each((_, tr) => {
    const $tr = $(tr);
    const label = normalizeText($tr.find("th").first().text()).toLowerCase();
    const value = normalizeText($tr.find("td").first().text());
    if (!label || !value) return;

    if (label.startsWith("state") || label.startsWith("status")) {
      header.state = value;
    } else if (label.startsWith("started") || label.startsWith("begonnen")) {
      header.started = value;
    } else if (label.startsWith("completed") || label.startsWith("abgeschlossen") || label.startsWith("beendet")) {
      header.completed = value;
    } else if (
      label.startsWith("time taken") ||
      label.startsWith("duration") ||
      label.startsWith("verbrauchte") ||
      label.startsWith("dauer")
    ) {
      header.time_taken = value;
    } else if (label.startsWith("marks") || label.startsWith("punkte")) {
      header.marks = value;
    } else if (label.startsWith("grade") || label.startsWith("bewertung") || label.startsWith("note")) {
      header.grade = value;
    }
  });

  return header;
}

/** Iteriert alle Fragenblöcke (div.que) und extrahiert je Frage die Auswertung. */
function parseQuestions($: cheerio.CheerioAPI): QuizReviewQuestion[] {
  const questions: QuizReviewQuestion[] = [];

  $("div.que").each((_, que) => {
    const $que = $(que);
    const q: QuizReviewQuestion = {};

    // Nummer aus .qno (Fallback: erste Zahl in .info .no).
    const qnoText =
      normalizeText($que.find(".info .qno").first().text()) ||
      normalizeText($que.find(".info .no").first().text());
    const numMatch = qnoText.match(/\d+/);
    if (numMatch) q.number = Number.parseInt(numMatch[0], 10);

    // Zustand: sichtbarer Text aus .state, Korrekt-Flag token-genau aus der Klasse
    // (Vorsicht: "correct" ist Teilstring von "incorrect" → hasClass nutzen).
    const stateText = normalizeText($que.find(".info .state").first().text());
    if (stateText) q.state = stateText;
    if ($que.hasClass("correct")) {
      q.is_correct = true;
    } else if ($que.hasClass("incorrect") || $que.hasClass("partiallycorrect") || $que.hasClass("notanswered")) {
      q.is_correct = false;
    }

    // Erreichte Punkte ("Mark 1.00 out of 1.00").
    const grade = normalizeText($que.find(".info .grade").first().text());
    if (grade) q.marks = grade;

    // Fragetext. Bei eingebetteten Frage-Typen (multianswer/Cloze) fehlt ein
    // sauberes .qtext — dann der gesamte Aufgabentext aus .formulation als
    // Fallback, damit die Frage nicht völlig leer bleibt. Die unsichtbaren
    // Screenreader-Label (.accesshide, z. B. "Question text") werden vorher
    // an einer Kopie entfernt, ohne das Original-DOM zu verändern.
    let qtext = normalizeText($que.find(".qtext").first().text());
    if (!qtext) {
      const $form = $que.find(".formulation").first().clone();
      $form.find(".accesshide").remove();
      qtext = normalizeText($form.text());
    }
    if (qtext) q.question_text = truncate(qtext, 2000);

    // Eigene Antwort(en) — Best-effort über mehrere Antwort-Formen.
    // (a) Multiple-Choice: Optionen mit angekreuztem Input (checked); bei
    //     Mehrfachauswahl mehrere Einträge. Bevorzugt der Antworttext-Container.
    // (b) Kurzantwort/numerisch/Auswahl: vom Nutzer eingegebener Wert in einem
    //     readonly-Textfeld bzw. die ausgewählte Select-Option.
    // Bewusst NICHT abgedeckt (eigene Frage-Typen mit eingebetteten Feldern):
    //     Cloze/multianswer, Zuordnung (matching), Drag&Drop — dort kann
    //     your_answer fehlen, correct_answer/Feedback bleiben aber befüllt.
    const chosen: string[] = [];
    $que.find(".answer > div").each((_, opt) => {
      const $opt = $(opt);
      if ($opt.find("input[checked]").length === 0) return;
      const labelText =
        normalizeText($opt.find(".flex-fill, [data-region='answer-label'], label, p").first().text()) ||
        normalizeText($opt.text());
      if (labelText) chosen.push(truncate(labelText, 500));
    });
    if (chosen.length === 0) {
      // Kurzantwort/Numerik: der Wert steht im (readonly) Eingabefeld.
      $que.find(".answer input[type='text'], .answer input[type='number'], .ablock input[type='text']").each((_, inp) => {
        const v = normalizeText($(inp).attr("value"));
        if (v) chosen.push(truncate(v, 500));
      });
      // Auswahl: die selektierte Option.
      $que.find(".answer select").each((_, sel) => {
        const v = normalizeText($(sel).find("option[selected]").first().text());
        if (v) chosen.push(truncate(v, 500));
      });
    }
    if (chosen.length > 0) q.your_answer = chosen;

    // Musterlösung aus .rightanswer, Präfix ("The correct answer(s) is/are:") strippen.
    const rightRaw = normalizeText($que.find(".rightanswer").first().text());
    if (rightRaw) {
      q.correct_answer = truncate(
        rightRaw.replace(/^The correct answers?\s+(?:is|are)\s*:\s*/i, "").replace(/^Die richtigen?\s+(?:Antwort(?:en)?)\s*(?:ist|sind)\s*:\s*/i, ""),
        1000
      );
    }

    // Allgemeine Erklärung und spezifisches Feedback.
    const general = normalizeText($que.find(".generalfeedback").first().text());
    if (general) q.explanation = truncate(general, 2000);
    const specific = normalizeText($que.find(".specificfeedback").first().text());
    if (specific) q.specific_feedback = truncate(specific, 1000);

    // Nur aufnehmen, wenn überhaupt etwas Verwertbares drinsteht.
    if (q.question_text || q.state || q.marks || q.correct_answer) {
      questions.push(q);
    }
  });

  return questions;
}
