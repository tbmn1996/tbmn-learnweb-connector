/**
 * Parser für Moodle-ratingallocate (mod/ratingallocate = Fair Allocation /
 * Präferenz-basierte Gruppeneinteilung).
 *
 * Struktur (Moodle 4.x, siehe test/fixtures/learnweb/ratingallocate.html):
 *   div.activity-header → Opened/Closed
 *   div.activity-description → Intro-Text
 *   div.choicestatustable table.generaltable (choicesummarytable)
 *     tr: td.c0 (Label) | td.c1 (Value)
 *     bekannte Labels: Rating ends at, Time remaining,
 *                      Estimated publication date, Your Rating, Your Allocation
 *   "Your Rating"-Zelle enthaelt <ul><li>-Liste der Optionen — diese nehmen
 *   wir als choices[].
 *
 * Authoritative Plugin-Quelle learnweb/moodle-mod_ratingallocate:
 * renderer.php rendert .choicestatustable, .choicesummarytable,
 * #mod_ratingallocateshowoptions sowie die Labels "Rateable Choices",
 * "Your Rating" und "Your Allocation".
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { LearnwebParseError } from "../session";
import { extractTextFromSelector, normalizeText, truncate } from "./common";

export interface RatingChoice {
  title: string;
  description?: string;
  max_size?: number;
  user_rating?: string;
}

export interface RatingAllocateContent {
  description?: string;
  deadline?: string;
  time_remaining?: string;
  publication_date?: string;
  allocation?: string;
  choices?: RatingChoice[];
}

export interface RatingAllocateResult {
  title: string;
  content: RatingAllocateContent;
  parser_degraded?: boolean;
}

// Label (lowercase, trimmed) → Feld im Output.
// Wir mappen nur das, was wir in der Live-Fixture gesehen haben.
const STATUS_MAP: Record<string, keyof RatingAllocateContent> = {
  "rating ends at": "deadline",
  "time remaining": "time_remaining",
  "estimated publication date": "publication_date",
  "your allocation": "allocation",
};

const CHOICES_LABELS = new Set(["your rating", "rateable choices"]);

export async function parseRatingAllocate(
  session: LearnwebSession,
  cmid: number
): Promise<RatingAllocateResult> {
  const path = `/mod/ratingallocate/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return {
      title: `RatingAllocate ${cmid}`,
      content: {},
      parser_degraded: true,
    };
  }

  const $ = cheerio.load(resp.data);
  const title =
    normalizeText($("h1, h2").first().text()) || `RatingAllocate ${cmid}`;
  const hasKnownRatingAllocateMarkup =
    $(".choicestatustable, .choicesummarytable, #mod_ratingallocateshowoptions").length > 0;

  const content: RatingAllocateContent = {};

  const description =
    extractTextFromSelector($, ".activity-description", 2000) ||
    extractTextFromSelector($, "#intro", 2000) ||
    undefined;
  if (description) content.description = description;

  // activity-header "Opened/Closed" → deadline falls noch nicht aus Tabelle gesetzt.
  $(".activity-header .activity-dates div, .activity-header div").each((_, div) => {
    const text = normalizeText($(div).text());
    const closed = text.match(/^Closed\s*:?\s*(.+)$/i);
    if (closed && !content.deadline) {
      content.deadline = closed[1].trim();
    }
  });

  // Status-Tabelle durchgehen.
  $(".choicestatustable tr, .choicesummarytable tr").each((_, tr) => {
    const $tr = $(tr);
    // Labels stehen in td.c0 (ohne th), Werte in td.c1.
    const cells = $tr.find("td");
    if (cells.length < 2) return;
    const label = normalizeText($(cells[0]).text()).toLowerCase();
    const valueCell = $(cells[1]);

    if (CHOICES_LABELS.has(label)) {
      // Choices aus ul > li extrahieren. Ein li kann Rating-Angabe am Ende haben,
      // z.B. "W09 (Freitag, 14-16) (4 - Highly appreciated)".
      const items: RatingChoice[] = [];
      valueCell.find("ul > li").each((_, li) => {
        const raw = normalizeText($(li).text());
        if (!raw) return;
        const { title: itemTitle, rating } = splitChoiceLine(raw);
        items.push({
          title: truncate(itemTitle, 200),
          user_rating: label === "your rating" ? rating : undefined,
        });
      });
      if (items.length > 0) content.choices = items;
      return;
    }

    const field = STATUS_MAP[label];
    if (!field) return;
    const value = normalizeText(valueCell.text());
    if (value) {
      (content as Record<string, string>)[field] = truncate(value, 300);
    }
  });

  const optionsTableChoices = parseOptionsTable($);
  if (optionsTableChoices.length > 0) {
    content.choices = optionsTableChoices;
  }

  const hasAnything = Object.keys(content).length > 0;
  if (!hasAnything && !hasKnownRatingAllocateMarkup) {
    throw new LearnwebParseError(
      "ratingallocate",
      ".choicestatustable",
      "No ratingallocate status table or options table found."
    );
  }

  return {
    title,
    content,
    parser_degraded: hasAnything ? undefined : true,
  };
}

function parseOptionsTable($: cheerio.CheerioAPI): RatingChoice[] {
  const choices: RatingChoice[] = [];
  $("#mod_ratingallocateshowoptions tbody tr, table.ratingallocate_choices_table tbody tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 1) return;
    const title = normalizeText($(cells[0]).text());
    if (!title) return;
    const description = cells.length > 1 ? normalizeText($(cells[1]).text()) : "";
    const rawMaxSize = cells.length > 2 ? normalizeText($(cells[2]).text()) : "";
    const maxSize = rawMaxSize ? Number.parseInt(rawMaxSize, 10) : Number.NaN;
    choices.push({
      title: truncate(title, 200),
      description: description ? truncate(description, 1000) : undefined,
      max_size: Number.isFinite(maxSize) ? maxSize : undefined,
    });
  });
  return choices;
}

/**
 * Trennt eine Zeile wie "W09 (Freitag, 14-16) (4 - Highly appreciated)" in
 * den Choice-Titel und die Rating-Klammer am Ende. Wenn keine Rating-Klammer
 * mit Zahl am Anfang erkennbar ist, gilt der ganze String als Titel.
 */
function splitChoiceLine(line: string): { title: string; rating?: string } {
  // Letzte Klammer mit führender Zahl → user_rating.
  const m = line.match(/^(.*)\(([0-9][^()]*?)\)\s*$/);
  if (!m) return { title: line };
  return { title: m[1].trim(), rating: m[2].trim() };
}
