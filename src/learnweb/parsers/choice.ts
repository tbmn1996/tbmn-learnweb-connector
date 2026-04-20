/**
 * Parser für Moodle-Abstimmungen (mod/choice).
 *
 * Struktur (Moodle 4.x):
 *   div.activity-description → Beschreibung
 *   div.activity-header → Öffnungs-/Schließzeiten
 *   .option / table.generaltable / form.choiceform → Abstimmungsoptionen
 *   .choiceresponse / .userresponse → Eigene Auswahl des Users (falls bereits abgestimmt)
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { extractTextFromSelector, normalizeText, truncate } from "./common";

export interface ChoiceOption {
  label: string;
  votes?: number;
  selected?: boolean;
}

export interface ChoiceContent {
  description?: string;
  opens?: string;
  closes?: string;
  options: ChoiceOption[];
  user_selection?: string;
  allow_update?: boolean;
}

export interface ChoiceResult {
  title: string;
  content: ChoiceContent;
  parser_degraded?: boolean;
}

export async function parseChoice(
  session: LearnwebSession,
  cmid: number
): Promise<ChoiceResult> {
  const path = `/mod/choice/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return { title: `Choice ${cmid}`, content: { options: [] }, parser_degraded: true };
  }

  const $ = cheerio.load(resp.data);
  const title = normalizeText($("h1, h2").first().text()) || `Choice ${cmid}`;
  const content: ChoiceContent = { options: [] };

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

  // Abstimmungsoptionen aus Formular oder Ergebnis-Tabelle.
  $(".option, .choiceoption, input[type='radio'][name='answer']").each((_, el) => {
    const $el = $(el);
    // Input-Elemente: Label aus zugehörigem <label>.
    if ($el.is("input")) {
      const id = $el.attr("id");
      const labelText = id
        ? normalizeText($(`label[for="${id}"]`).text())
        : normalizeText($el.closest("label").text() || $el.closest("div").find("label").first().text());
      if (labelText) {
        content.options.push({
          label: truncate(labelText, 300),
          selected: $el.attr("checked") !== undefined,
        });
      }
      return;
    }
    // Div/Td-Elemente.
    const label = normalizeText($el.find(".choicetext, .text, label").first().text() || $el.text());
    const votesText = normalizeText($el.find(".count, .numvotes").first().text());
    const votes = votesText ? parseInt(votesText, 10) || undefined : undefined;
    if (label) {
      content.options.push({ label: truncate(label, 300), votes, selected: false });
    }
  });

  // Eigene Auswahl: .choiceresponse oder .userresponse.
  const userSel = normalizeText($(".choiceresponse, .userresponse, .currentchoice").first().text());
  if (userSel) content.user_selection = truncate(userSel, 300);

  const hasAnything = content.description !== undefined || content.options.length > 0;
  return { title, content, parser_degraded: hasAnything ? undefined : true };
}
