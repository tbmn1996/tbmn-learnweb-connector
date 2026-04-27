import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { LearnwebSession, type LearnwebResponse } from "../src/learnweb/session";
import { buildDiagnostics } from "../src/learnweb/parsers/timeline";

type CaptureEntry = {
  http_status: number;
  url: string;
  content_type?: string;
  body_length: number;
  set_cookie_names: string[];
  login_redirect_indicators: {
    redirect_status: boolean;
    html_content_type: boolean;
    login_form: boolean;
  };
  diagnostics?: Record<string, unknown>;
};

const RAW_DIR = path.resolve("test/fixtures/learnweb/raw");
const MONTH_CONTAINER = ".calendarwrapper";
const UPCOMING_CONTAINER = '[data-region="event-list-content"]';

function cookieNames(headers: Record<string, string>): string[] {
  const raw = headers["set-cookie"];
  if (!raw) return [];
  return raw
    .split(/,(?=[^;,]+=)/)
    .map((part) => part.split("=", 1)[0]?.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
}

function loginRedirectIndicators(resp: LearnwebResponse) {
  const contentType = resp.headers["content-type"] ?? "";
  const body = resp.data ?? "";
  return {
    redirect_status: resp.status === 302 || resp.status === 303,
    html_content_type: /text\/html/i.test(contentType),
    login_form: /<form[^>]+(?:id=["']login["']|action=["'][^"']*\/login\/index\.php)/i.test(body),
  };
}

async function captureEntry(
  session: LearnwebSession,
  resp: LearnwebResponse,
  containerSelector: string
): Promise<CaptureEntry> {
  const $ = cheerio.load(resp.data);
  return {
    http_status: resp.status,
    url: resp.url.replace(/sesskey=[^&]+/g, "sesskey=REDACTED"),
    content_type: resp.headers["content-type"],
    body_length: resp.data.length,
    set_cookie_names: cookieNames(resp.headers),
    login_redirect_indicators: loginRedirectIndicators(resp),
    diagnostics: await buildDiagnostics(session, $, resp, containerSelector),
  };
}

function dataAttributeKeys(el: unknown): string[] {
  if (!el || typeof el !== "object" || !("attribs" in el)) return [];
  const attribs = (el as { attribs?: Record<string, string> }).attribs;
  if (!attribs) return [];
  return Object.keys(attribs)
    .filter((key) => key.startsWith("data-"))
    .sort();
}

function calendarEventAttributeReport(html: string) {
  const $ = cheerio.load(html);
  const selector =
    '[data-region="day"] a[data-action="view-event"], ' +
    '[data-region="day"] a[data-action="event-action-view"], ' +
    '[data-region="day"] a[href*="/mod/"]';

  const eventDataAttrs: Array<{
    anchor_data_attrs: string[];
    list_item_data_attrs: string[];
    table_cell_data_attrs: string[];
    has_td_day_timestamp: boolean;
  }> = [];

  $(selector).each((_, anchor) => {
    const $a = $(anchor);
    const li = $a.closest("li").get(0);
    const td = $a.closest("td").get(0);
    eventDataAttrs.push({
      anchor_data_attrs: dataAttributeKeys(anchor),
      list_item_data_attrs: dataAttributeKeys(li),
      table_cell_data_attrs: dataAttributeKeys(td),
      has_td_day_timestamp: Boolean(td && $(td).attr("data-day-timestamp")),
    });
  });

  return {
    selector,
    selector_hits: {
      event_anchors: $(selector).length,
      day_cells: $('[data-region="day"]').length,
      day_cells_with_day_timestamp: $('td[data-day-timestamp], [data-region="day"][data-day-timestamp]').length,
      legacy_view_event_anchors: $('[data-region="day"] a[data-action="view-event"]').length,
      event_action_view_anchors: $('[data-region="day"] a[data-action="event-action-view"]').length,
    },
    event_data_attrs: eventDataAttrs,
  };
}

function ajaxShape(body: string) {
  try {
    const parsed = JSON.parse(body);
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    const firstRecord = first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
    const data = firstRecord?.data && typeof firstRecord.data === "object"
      ? (firstRecord.data as Record<string, unknown>)
      : undefined;
    const exception = firstRecord?.exception && typeof firstRecord.exception === "object"
      ? (firstRecord.exception as Record<string, unknown>)
      : undefined;
    return {
      parsed_type: Array.isArray(parsed) ? "array" : typeof parsed,
      top_level_length: Array.isArray(parsed) ? parsed.length : undefined,
      first_keys: firstRecord ? Object.keys(firstRecord).sort() : [],
      data_keys: data ? Object.keys(data).sort() : [],
      events_count: Array.isArray(data?.events) ? data.events.length : undefined,
      exception_keys: exception ? Object.keys(exception).sort() : [],
      exception_errorcode: typeof exception?.errorcode === "string" ? exception.errorcode : undefined,
    };
  } catch (error) {
    return {
      parsed_type: "invalid_json",
      error: error instanceof Error ? error.name : "unknown",
    };
  }
}

function firstOfCurrentMonthUnix(): number {
  const nowBerlin = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  return Math.floor(new Date(nowBerlin.getFullYear(), nowBerlin.getMonth(), 1).getTime() / 1000);
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });

  const session = LearnwebSession.getInstance();
  const monthPath = `/calendar/view.php?view=month&time=${firstOfCurrentMonthUnix()}`;
  const upcomingPath = "/calendar/view.php?view=upcoming";

  const monthResp = await session.get(monthPath);
  await writeFile(path.join(RAW_DIR, "calendar-month-current.html"), monthResp.data, "utf8");

  const upcomingResp = await session.get(upcomingPath);
  await writeFile(path.join(RAW_DIR, "calendar-upcoming-current.html"), upcomingResp.data, "utf8");

  const sesskey = await session.getSesskey();
  const wwwroot = session.getMoodleWwwroot();
  const nowUnix = Math.floor(Date.now() / 1000);
  const windowDays = 90;
  const ajaxPayload = [
    {
      index: 0,
      methodname: "core_calendar_get_action_events_by_timesort",
      args: {
        limitnum: 50,
        timesortfrom: nowUnix,
        timesortto: nowUnix + windowDays * 86400,
        limittononsuspendedevents: true,
      },
    },
  ];
  const ajaxUrl = `${wwwroot}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}`;
  const ajaxResp = await session.postJson(ajaxUrl, ajaxPayload);
  await writeFile(path.join(RAW_DIR, "calendar-ajax-action-events.json"), ajaxResp.data, "utf8");

  const report = {
    generated_at: new Date().toISOString(),
    files: {
      month: "calendar-month-current.html",
      upcoming: "calendar-upcoming-current.html",
      ajax: "calendar-ajax-action-events.json",
    },
    month: {
      ...(await captureEntry(session, monthResp, MONTH_CONTAINER)),
      calendar_event_attributes: calendarEventAttributeReport(monthResp.data),
    },
    upcoming: await captureEntry(session, upcomingResp, UPCOMING_CONTAINER),
    ajax: {
      http_status: ajaxResp.status,
      url: ajaxResp.url.replace(/sesskey=[^&]+/g, "sesskey=REDACTED"),
      content_type: ajaxResp.headers["content-type"],
      body_length: ajaxResp.data.length,
      set_cookie_names: cookieNames(ajaxResp.headers),
      login_redirect_indicators: loginRedirectIndicators(ajaxResp),
      shape: ajaxShape(ajaxResp.data),
    },
  };

  await writeFile(path.join(RAW_DIR, "capture-report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`Capture written to ${RAW_DIR}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
