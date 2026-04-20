/**
 * Parser für die Moodle-Kalender/Upcoming-Events-Ansicht.
 *
 * Datenquelle: /calendar/view.php?view=upcoming
 * Das Dashboard-Sample zeigt, dass Uni Münster einen Calendar-Block
 * (nicht den Block-Timeline) verwendet. Beide Ansichten nutzen dasselbe
 * event-item-Markup mit data-Attributen:
 *
 *   <li data-region="event-item"
 *       data-event-component="mod_quiz"
 *       data-event-eventtype="open"
 *       data-event-id="6274194">
 *     <a data-action="view-event" href="...mod/quiz/view.php?id=..." title="...">
 *       <span class="eventname">...</span>
 *     </a>
 *   </li>
 *
 * Alternativquelle: Kalender-Monatsansicht (/calendar/view.php oder /my/).
 * Wir versuchen zunächst /calendar/view.php?view=upcoming; enthält sie
 * keine event-items, probieren wir die Monatsansicht-Selektoren auf
 * demselben HTML (in case der Server ignoriert den view-Parameter und
 * immer den Monat rendert).
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { absoluteUrl, cmidFromUrl, normalizeText, parseMoodleDate, truncate } from "./common";

export interface TimelineEvent {
  title?: string;
  course_id?: number;
  course_name?: string;
  modtype?: string;
  event_type?: string;
  cmid?: number;
  event_id?: number;
  due_at?: string;
  due_at_unix?: number;
  url?: string;
}

export interface TimelineContent {
  events: TimelineEvent[];
  window_days: number;
  fetched_at: string;
  parser_degraded?: boolean;
}

export interface TimelineResult {
  content: TimelineContent;
  parser_degraded?: boolean;
}

export interface TimelineOptions {
  window_days?: number;
  modtypes?: string[];
}

const DEFAULT_WINDOW = 30;
const MAX_WINDOW = 90;

export async function parseTimeline(
  session: LearnwebSession,
  options: TimelineOptions = {}
): Promise<TimelineResult> {
  const window_days = clampWindow(options.window_days);
  const fetched_at = new Date().toISOString();

  const resp = await session.get("/calendar/view.php?view=upcoming");
  if (resp.status < 200 || resp.status >= 300) {
    return {
      content: { events: [], window_days, fetched_at, parser_degraded: true },
      parser_degraded: true,
    };
  }

  const $ = cheerio.load(resp.data);
  const baseUrl = session.getBaseUrl();

  let events = extractEventItems($, baseUrl);

  // Fallback: Monatskalender-Selektoren (falls upcoming-View nicht gerendert).
  if (events.length === 0) {
    events = extractCalendarMonthEvents($, baseUrl);
  }

  // window_days-Filter: nur Events innerhalb der nächsten N Tage.
  const now = Date.now();
  const cutoff = now + window_days * 24 * 60 * 60 * 1000;
  events = events.filter((e) => {
    if (e.due_at_unix != null) {
      const ts = e.due_at_unix * 1000;
      return ts >= now && ts <= cutoff;
    }
    if (e.due_at) {
      const d = parseMoodleDate(e.due_at);
      if (d) return d.getTime() >= now && d.getTime() <= cutoff;
    }
    return true; // Falls kein Datum → immer einschließen
  });

  // modtypes-Filter.
  if (options.modtypes && options.modtypes.length > 0) {
    const allowed = new Set(options.modtypes);
    events = events.filter((e) => !e.modtype || allowed.has(e.modtype));
  }

  // Sortierung nach due_at_unix, dann nach due_at-String.
  events.sort((a, b) => {
    const ta = a.due_at_unix ?? (a.due_at ? parseMoodleDate(a.due_at)?.getTime() ?? 0 : 0) / 1000;
    const tb = b.due_at_unix ?? (b.due_at ? parseMoodleDate(b.due_at)?.getTime() ?? 0 : 0) / 1000;
    return ta - tb;
  });

  return {
    content: {
      events,
      window_days,
      fetched_at,
      parser_degraded: events.length === 0 ? true : undefined,
    },
    parser_degraded: events.length === 0 ? true : undefined,
  };
}

/**
 * Extrahiert Events aus der Upcoming-View-Ansicht.
 * Selector: li[data-region="event-list-item"] — Block-Timeline-Format.
 */
function extractEventItems(
  $: cheerio.CheerioAPI,
  baseUrl: string
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  $('li[data-region="event-list-item"]').each((_, li) => {
    const $li = $(li);
    const event: TimelineEvent = {};

    const $a = $li.find("a[href*='/mod/']").first();
    const titleText =
      normalizeText($li.find(".event-name, .eventname, h3").first().text()) ||
      normalizeText($a.text());
    if (titleText) event.title = truncate(titleText, 300);

    const href = $a.attr("href");
    if (href) {
      event.url = absoluteUrl(baseUrl, href);
      const cmid = cmidFromUrl(href);
      if (cmid) event.cmid = cmid;
      const modMatch = href.match(/\/mod\/([a-z_]+)\//);
      if (modMatch) event.modtype = modMatch[1];
    }

    const dateText = normalizeText($li.find(".date, time, .event-time").first().text());
    if (dateText) {
      event.due_at = dateText;
      const parsed = parseMoodleDate(dateText);
      if (parsed) event.due_at_unix = Math.floor(parsed.getTime() / 1000);
    }

    const courseName = normalizeText($li.find(".coursename, .course-name").first().text());
    if (courseName) event.course_name = truncate(courseName, 200);

    events.push(event);
  });
  return events;
}

/**
 * Extrahiert Events aus der Monatskalender-Ansicht.
 * Selector: li[data-region="event-item"] — Calendar-Block-Format.
 */
function extractCalendarMonthEvents(
  $: cheerio.CheerioAPI,
  baseUrl: string
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  $('li[data-region="event-item"]').each((_, li) => {
    const $li = $(li);
    const event: TimelineEvent = {};

    // Modtype aus data-event-component (z.B. "mod_quiz" → "quiz").
    const component = $li.attr("data-event-component") ?? "";
    if (component.startsWith("mod_")) {
      event.modtype = component.slice(4);
    } else if (component) {
      event.modtype = component;
    }

    // Event-Typ (open, close, due, ...).
    event.event_type = $li.attr("data-event-eventtype") ?? undefined;

    // Event-ID.
    const eventIdStr = $li.attr("data-event-id");
    if (eventIdStr) event.event_id = parseInt(eventIdStr, 10) || undefined;

    // Timestamp: data-timestamp auf dem Link-Element.
    const $a = $li.find("a[data-action='view-event'], a[href*='/mod/']").first();
    const tsStr = $a.attr("data-timestamp") ?? $li.closest("[data-timestamp]").attr("data-timestamp");
    if (tsStr) {
      const ts = parseInt(tsStr, 10);
      if (!Number.isNaN(ts)) event.due_at_unix = ts;
    }

    // Datum aus Eltern-Kalender-Zelle (data-year, data-month, data-day).
    if (!event.due_at_unix) {
      const $day = $li.closest("[data-region='day']");
      const y = $day.attr("data-year");
      const m = $day.attr("data-month");
      const d = $day.attr("data-day");
      if (y && m && d) {
        const dateStr = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        event.due_at = dateStr;
        const parsed = new Date(dateStr);
        if (!Number.isNaN(parsed.getTime())) event.due_at_unix = Math.floor(parsed.getTime() / 1000);
      }
    }

    // Titel.
    const titleText =
      normalizeText($a.find(".eventname").text()) ||
      normalizeText($a.attr("title") ?? "") ||
      normalizeText($a.text());
    if (titleText) event.title = truncate(titleText, 300);

    // URL.
    const href = $a.attr("href");
    if (href) {
      event.url = absoluteUrl(baseUrl, href);
      // cmid aus URL.
      const cmid = cmidFromUrl(href);
      if (cmid) event.cmid = cmid;
      // course_id (falls url auf course/view.php zeigt) — meist nicht der Fall bei event-items.
    }

    // Kursname aus .coursename-Span falls vorhanden.
    const courseName = normalizeText($li.find(".coursename, [data-region='course-name']").text());
    if (courseName) event.course_name = truncate(courseName, 200);

    if (event.title) events.push(event);
  });

  return events;
}

function clampWindow(w: number | undefined): number {
  if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) return DEFAULT_WINDOW;
  return Math.min(Math.floor(w), MAX_WINDOW);
}

/** Nur für Tests: Extraktion ohne Datums-/Fenster-Filter. */
export function _extractForTest(html: string, baseUrl: string): TimelineEvent[] {
  const $ = cheerio.load(html);
  let events = extractEventItems($, baseUrl);
  if (events.length === 0) events = extractCalendarMonthEvents($, baseUrl);
  return events;
}
