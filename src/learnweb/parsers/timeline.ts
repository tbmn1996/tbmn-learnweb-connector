/**
 * Parser für die Moodle-Kalender/Upcoming-Events-Ansicht.
 *
 * Datenquellen:
 *   - /calendar/view.php?view=upcoming  (Block-Timeline-Format)
 *   - /calendar/view.php?view=month     (Kalender-Monatsansicht)
 *
 * Fehlerverhalten:
 *   - non-2xx Response    → LearnwebUpstreamError
 *   - Container vorhanden, aber 0 Events → return [] (legitim leerer Kalender)
 *   - Container fehlt     → LearnwebParseError + console.error mit Diagnostics
 */

import { createHash } from "crypto";
import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { LearnwebParseError, LearnwebUpstreamError } from "../session";
import { absoluteUrl, cmidFromUrl, courseIdFromUrl, normalizeText, parseMoodleDate, truncate } from "./common";

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
}

export interface TimelineResult {
  content: TimelineContent;
}

export interface TimelineOptions {
  window_days?: number;
  modtypes?: string[];
  course_id?: number;
  event_type?: string;
}

const DEFAULT_WINDOW = 30;
const MAX_WINDOW = 90;

const UPCOMING_CONTAINER = '[data-region="event-list-content"]';
const MONTH_CONTAINER = ".calendarwrapper";

// --- Diagnostik-Helper ---

async function buildDiagnostics(
  session: LearnwebSession,
  $: cheerio.CheerioAPI,
  resp: { status: number; url: string; data: string },
  containerSelector: string,
  extraSelectorHits?: Record<string, number>
): Promise<Record<string, unknown>> {
  const containerEl = $(containerSelector);
  const dataRegions = containerEl
    .find("[data-region]")
    .map((_, el) => $(el).attr("data-region") ?? "")
    .get()
    .sort();
  const pageHash = createHash("sha1")
    .update(JSON.stringify(dataRegions))
    .digest("hex")
    .slice(0, 8);

  return {
    http_status: resp.status,
    url: resp.url,
    timestamp: new Date().toISOString(),
    body_snippet: String(resp.data).slice(0, 2048),
    has_moodle_cookie: await session.hasMoodleCookie(),
    selector_hits: {
      [containerSelector]: containerEl.length,
      ...extraSelectorHits,
    },
    page_hash: pageHash,
  };
}

// --- parseTimeline ---

export async function parseTimeline(
  session: LearnwebSession,
  options: TimelineOptions = {}
): Promise<TimelineResult> {
  const window_days = clampWindow(options.window_days);
  const fetched_at = new Date().toISOString();

  // session.get() erledigt Auth/Re-Auth/Login-Redirect-Erkennung intern.
  const resp = await session.get("/calendar/view.php?view=upcoming");

  if (resp.status < 200 || resp.status >= 300) {
    const diagnostics = await buildDiagnostics(
      session, cheerio.load(""), resp, UPCOMING_CONTAINER
    );
    throw new LearnwebUpstreamError(
      `Calendar upcoming view returned ${resp.status}.`,
      diagnostics
    );
  }

  const $ = cheerio.load(resp.data);
  const baseUrl = session.getBaseUrl();

  let events = extractEventItems($, baseUrl);

  // Fallback: Monatskalender-Selektoren falls upcoming-View kein Block-Timeline-Format liefert.
  if (events.length === 0) {
    events = extractCalendarMonthEvents($, baseUrl);
  }

  if (events.length === 0) {
    // HTML liefert keine Events — Moodle 4.x rendert sie per JavaScript
    // (Container kann vorhanden-aber-leer ODER komplett absent sein).
    // Immer AJAX als primäre Quelle fragen.
    events = await extractViaCalendarAjax(session, window_days);

    if (events.length === 0) {
      // Wenn AJAX auch nichts liefert: Diagnostics loggen und [] zurückgeben.
      // (Kann legitim leer sein, oder AJAX-Response-Format hat sich geändert.)
      const diagnostics = await buildDiagnostics(session, $, resp, UPCOMING_CONTAINER, {
        container_present: $(UPCOMING_CONTAINER).length,
        "event-list-item": $('li[data-region="event-list-item"]').length,
        "event-item": $('li[data-region="event-item"]').length,
      });
      console.error(JSON.stringify({ event: "timeline_ajax_empty", ...diagnostics }));
      return { content: { events: [], window_days, fetched_at } };
    }
  }

  // Filter course_id / event_type.
  if (options.course_id != null) {
    events = events.filter((e) => e.course_id === options.course_id);
  }
  if (options.event_type) {
    events = events.filter((e) => e.event_type === options.event_type);
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
    return true;
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

  return { content: { events, window_days, fetched_at } };
}

// --- parseCalendarMonth ---

export interface CalendarMonthContent {
  events: TimelineEvent[];
  year: number;
  month: number;
  fetched_at: string;
}

export interface CalendarMonthResult {
  content: CalendarMonthContent;
  year: number;
  month: number;
}

export async function parseCalendarMonth(
  session: LearnwebSession,
  options: { year?: number; month?: number; course_id?: number } = {}
): Promise<CalendarMonthResult> {
  // Default: aktueller Monat in Europe/Berlin.
  const nowBerlin = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" })
  );
  const year = options.year ?? nowBerlin.getFullYear();
  const month = options.month ?? nowBerlin.getMonth() + 1;
  const firstOfMonth = new Date(year, month - 1, 1);
  const unixTime = Math.floor(firstOfMonth.getTime() / 1000);
  const fetched_at = new Date().toISOString();

  let path = `/calendar/view.php?view=month&time=${unixTime}`;
  if (options.course_id != null) path += `&course=${options.course_id}`;

  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    const diagnostics = await buildDiagnostics(
      session, cheerio.load(""), resp, MONTH_CONTAINER
    );
    throw new LearnwebUpstreamError(
      `Calendar month view returned ${resp.status}.`,
      diagnostics
    );
  }

  const $ = cheerio.load(resp.data);
  const baseUrl = session.getBaseUrl();
  let events = extractCalendarMonthDayEvents($, baseUrl);

  if (options.course_id != null) {
    events = events.filter((e) => e.course_id === options.course_id);
  }

  const containerExists = $(MONTH_CONTAINER).length > 0;

  if (events.length === 0) {
    if (containerExists) {
      return { content: { events: [], year, month, fetched_at }, year, month };
    }
    const diagnostics = await buildDiagnostics(session, $, resp, MONTH_CONTAINER);
    console.error(JSON.stringify({ event: "calendar_month_parse_degraded", ...diagnostics }));
    throw new LearnwebParseError(
      "Calendar month view could not be parsed (container missing).",
      diagnostics
    );
  }

  return { content: { events, year, month, fetched_at }, year, month };
}

// --- Extraktions-Funktionen ---

/**
 * Extrahiert Events aus der Upcoming-View (Block-Timeline-Format).
 * Selector: li[data-region="event-list-item"]
 */
function extractEventItems(
  $: cheerio.CheerioAPI,
  baseUrl: string
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  $(
    'li[data-region="event-list-item"], [data-region="event-list-content"] > li'
  ).each((_, li) => {
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
      const cid = courseIdFromUrl(href);
      if (cid) event.course_id = cid;
    }

    const dateText = normalizeText($li.find(".date, time, .event-time").first().text());
    if (dateText) {
      event.due_at = dateText;
      const parsed = parseMoodleDate(dateText);
      if (parsed) event.due_at_unix = Math.floor(parsed.getTime() / 1000);
    }

    // Timestamp direkt aus data-Attribut (zuverlässiger als Datums-String).
    const tsStr =
      $li.find("[data-timestamp]").first().attr("data-timestamp") ??
      $li.closest("[data-timestamp]").attr("data-timestamp");
    if (tsStr) {
      const ts = parseInt(tsStr, 10);
      if (!Number.isNaN(ts)) event.due_at_unix = ts;
    }

    const courseName = normalizeText($li.find(".coursename, .course-name").first().text());
    if (courseName) event.course_name = truncate(courseName, 200);

    events.push(event);
  });
  return events;
}

/**
 * Extrahiert Events aus dem Kalender-Block innerhalb der Upcoming-View.
 * Selector: li[data-region="event-item"]
 */
function extractCalendarMonthEvents(
  $: cheerio.CheerioAPI,
  baseUrl: string
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  $('li[data-region="event-item"]').each((_, li) => {
    const $li = $(li);
    const event: TimelineEvent = {};

    const component = $li.attr("data-event-component") ?? "";
    if (component.startsWith("mod_")) {
      event.modtype = component.slice(4);
    } else if (component) {
      event.modtype = component;
    }

    event.event_type = $li.attr("data-event-eventtype") ?? undefined;

    const eventIdStr = $li.attr("data-event-id");
    if (eventIdStr) event.event_id = parseInt(eventIdStr, 10) || undefined;

    const $a = $li.find("a[data-action='view-event'], a[href*='/mod/']").first();
    const tsStr =
      $a.attr("data-timestamp") ??
      $li.closest("[data-timestamp]").attr("data-timestamp");
    if (tsStr) {
      const ts = parseInt(tsStr, 10);
      if (!Number.isNaN(ts)) event.due_at_unix = ts;
    }

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

    const titleText =
      normalizeText($a.find(".eventname").text()) ||
      normalizeText($a.attr("title") ?? "") ||
      normalizeText($a.text());
    if (titleText) event.title = truncate(titleText, 300);

    const href = $a.attr("href");
    if (href) {
      event.url = absoluteUrl(baseUrl, href);
      const cmid = cmidFromUrl(href);
      if (cmid) event.cmid = cmid;
    }

    // course_id: data-course-id Attribut bevorzugt, dann URL.
    const dataCourseId = $li.attr("data-course-id");
    if (dataCourseId) {
      event.course_id = parseInt(dataCourseId, 10) || undefined;
    } else if (href) {
      const cid = courseIdFromUrl(href);
      if (cid) event.course_id = cid;
    }

    const courseName = normalizeText(
      $li.find(".coursename, [data-region='course-name']").text()
    );
    if (courseName) event.course_name = truncate(courseName, 200);

    if (event.title) events.push(event);
  });

  return events;
}

/**
 * Extrahiert Events aus der Monatsansicht (/calendar/view.php?view=month).
 * Selector: [data-region="day"] a[data-action="view-event"]
 */
function extractCalendarMonthDayEvents(
  $: cheerio.CheerioAPI,
  baseUrl: string
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  $('[data-region="day"] a[data-action="view-event"]').each((_, a) => {
    const $a = $(a);
    const $li = $a.closest("li");
    const event: TimelineEvent = {};

    const component = $li.attr("data-event-component") ?? "";
    if (component.startsWith("mod_")) {
      event.modtype = component.slice(4);
    } else if (component) {
      event.modtype = component;
    }

    event.event_type = $li.attr("data-event-eventtype") ?? undefined;

    const eventIdStr = $li.attr("data-event-id");
    if (eventIdStr) event.event_id = parseInt(eventIdStr, 10) || undefined;

    const tsStr =
      $a.attr("data-timestamp") ??
      $a.closest("[data-timestamp]").attr("data-timestamp") ??
      $li.attr("data-timestamp");
    if (tsStr) {
      const ts = parseInt(tsStr, 10);
      if (!Number.isNaN(ts)) event.due_at_unix = ts;
    }

    if (!event.due_at_unix) {
      const $day = $a.closest("[data-region='day']");
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

    const titleText =
      normalizeText($a.find(".eventname").text()) ||
      normalizeText($a.attr("title") ?? "") ||
      normalizeText($a.text());
    if (titleText) event.title = truncate(titleText, 300);

    const href = $a.attr("href");
    if (href) {
      event.url = absoluteUrl(baseUrl, href);
      const cmid = cmidFromUrl(href);
      if (cmid) event.cmid = cmid;
      const cid = courseIdFromUrl(href);
      if (cid) event.course_id = cid;
    }

    // course_id aus data-course-id bevorzugt.
    const dataCourseId = $li.attr("data-course-id");
    if (dataCourseId) {
      event.course_id = parseInt(dataCourseId, 10) || undefined;
    }

    const $td = $a.closest("td");
    const ariaLabel = $td.attr("aria-label");
    const courseName =
      normalizeText($li.find(".coursename").text()) ||
      (ariaLabel ? truncate(normalizeText(ariaLabel), 200) : "");
    if (courseName) event.course_name = courseName;

    if (event.title) events.push(event);
  });

  return events;
}

/**
 * Holt Upcoming-Events über die interne Moodle-AJAX-API.
 * Wird aufgerufen wenn der HTML-Container vorhanden, aber leer ist
 * (Moodle 4.x rendert Events per JavaScript, nicht per Server-HTML).
 */
async function extractViaCalendarAjax(
  session: LearnwebSession,
  window_days: number
): Promise<TimelineEvent[]> {
  const sesskey = await session.getSesskey();
  // wwwroot aus gecachtem Moodle-M.cfg verwenden damit die URL auch bei
  // Sub-Path-Deployments korrekt ist (z.B. /LearnWeb/learnweb2/lib/ajax/...).
  const wwwroot = session.getMoodleWwwroot();
  // Großzügige Schätzung: window_days * 3, mind. 50, max. 200.
  const limitnum = Math.min(Math.max(window_days * 3, 50), 200);
  const payload = [
    {
      index: 0,
      methodname: "core_calendar_get_calendar_upcoming_view",
      args: { limitnum, offset: 0 },
    },
  ];

  const resp = await session.postJson(
    `${wwwroot}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}`,
    payload
  );

  if (resp.status < 200 || resp.status >= 300) {
    throw new LearnwebUpstreamError(
      `Moodle AJAX service returned ${resp.status}.`,
      { http_status: resp.status, url: resp.url, timestamp: new Date().toISOString() }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(resp.data);
  } catch {
    throw new LearnwebParseError("AJAX response is not valid JSON.", {
      body_snippet: String(resp.data).slice(0, 500),
    });
  }

  if (!Array.isArray(parsed) || !parsed[0]) {
    throw new LearnwebParseError("AJAX response has unexpected shape.");
  }

  const result = parsed[0] as {
    error?: boolean;
    exception?: { message?: string };
    data?: { events?: unknown[] };
  };

  if (result.error || result.exception) {
    throw new LearnwebParseError(
      `Moodle AJAX error: ${result.exception?.message ?? "unknown"}.`,
      { ajax_exception: result.exception }
    );
  }

  const rawEvents = result.data?.events;
  if (!Array.isArray(rawEvents)) {
    throw new LearnwebParseError("AJAX response missing data.events array.");
  }

  const baseUrl = session.getBaseUrl();
  return rawEvents.map((raw: unknown): TimelineEvent => {
    const e = raw as Record<string, unknown>;
    const event: TimelineEvent = {};
    if (e["name"]) event.title = truncate(String(e["name"]), 300);
    if (e["modulename"]) event.modtype = String(e["modulename"]);
    if (e["eventtype"]) event.event_type = String(e["eventtype"]);
    const cmid = e["instance"] ?? e["cmid"];
    if (cmid) event.cmid = Number(cmid);
    if (e["id"]) event.event_id = Number(e["id"]);
    if (e["timestart"]) event.due_at_unix = Number(e["timestart"]);
    const course = e["course"] as Record<string, unknown> | undefined;
    if (course?.["id"]) event.course_id = Number(course["id"]);
    if (course?.["fullname"]) event.course_name = truncate(String(course["fullname"]), 200);
    if (e["url"]) event.url = absoluteUrl(baseUrl, String(e["url"]));
    return event;
  });
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
