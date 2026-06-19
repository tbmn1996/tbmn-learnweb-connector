/**
 * MCP-Tools für Learnweb/Moodle — read-only.
 *
 * Tools:
 *   1. learnweb-get-courses          → alle Kurse des Users
 *   2. learnweb-get-course-overview  → Struktur eines Kurses
 *   3. learnweb-read-activity        → strukturierter Inhalt einer Aktivität
 *  3b. learnweb-read-quiz-review     → Auswertung des EIGENEN, abgeschlossenen Versuchs
 *   4. learnweb-get-timeline         → anstehende Aktivitäten (Upcoming-View)
 *   5. learnweb-search-courses       → globale Kurssuche über /course/search.php
 *   6. learnweb-get-page             → bereinigter Text einer SSO-geschützten Seite
 *   7. learnweb-get-calendar-month   → Kalenderansicht für einen Monat
 *   8. learnweb-download-resource    → authentifizierter Datei-Download
 *
 * Sicherheitsgrenze:
 *   Die Tools werden ausschliesslich registriert, wenn
 *     (a) LEARNWEB_USERNAME und LEARNWEB_PASSWORD gesetzt sind, UND
 *     (b) der Transport `stdio` ist ODER ein Scope (z.B. "learnweb") angegeben ist.
 *   Defensive Programmierung: Selbst wenn jemand versehentlich einen ungeschützten
 *   globalen HTTP-Endpoint mounten würde, würden die Tools dort NICHT registriert.
 */

import * as cheerio from "cheerio";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  LEARNWEB_PASSWORD,
  LEARNWEB_USERNAME,
  MCP_TRANSPORT,
} from "../config";
import {
  LearnwebAuthError,
  LearnwebFileTooLargeError,
  LearnwebNotConfiguredError,
  LearnwebParseError,
  LearnwebSession,
  LearnwebTimeoutError,
  LearnwebUpstreamError,
} from "../learnweb/session";
import { parseCourses } from "../learnweb/parsers/courses";
import { parseCourseOverview } from "../learnweb/parsers/overview";
import { parseResource } from "../learnweb/parsers/resource";
import { parseUrl } from "../learnweb/parsers/url";
import { parsePage } from "../learnweb/parsers/page";
import { parseFallback } from "../learnweb/parsers/fallback";
import { parseForum } from "../learnweb/parsers/forum";
import { parseAssign } from "../learnweb/parsers/assign";
import { parseQuiz } from "../learnweb/parsers/quiz";
import { parseQuizReview } from "../learnweb/parsers/quizReview";
import { parseRatingAllocate } from "../learnweb/parsers/ratingallocate";
import { parseCalendarMonth, parseTimeline } from "../learnweb/parsers/timeline";
import { normalizeText, truncate } from "../learnweb/parsers/common";
import { parseFolder } from "../learnweb/parsers/folder";
import { parseWorkshop } from "../learnweb/parsers/workshop";
import { parseLesson } from "../learnweb/parsers/lesson";
import { parseChoice } from "../learnweb/parsers/choice";
import { parseFeedback } from "../learnweb/parsers/feedback";
import { parseCourseSearch } from "../learnweb/parsers/courseSearch";
import {
  ok,
  READ_ONLY_TOOL_ANNOTATIONS,
  ToolConfig,
  ToolInputSchema,
  ToolOutputSchema,
  WorkspaceScope,
} from "./shared";

const MODTYPE_RE = /^[a-z_]+$/;
const DEFAULT_DOWNLOAD_BYTES = 3 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const PLUGINFILE_PATH_RE = /^\/(?:webservice\/)?(?:token)?pluginfile\.php\//;
const SAFE_PATH_RE = /^\/(mod|course|calendar|my|blocks)(\/|$)/;
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;
const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_MAX_PAGE = 20;
const SEARCH_RATE_LIMIT_MAX = 15;
const SEARCH_RATE_LIMIT_WINDOW_MS = 30_000;
const SEARCH_REQUEST_TIMEOUT_MS = 30_000;
const searchCallTimestamps: number[] = [];

type SearchRateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

type SearchHtmlAnalysis = {
  hasRegionMain: boolean;
  hasNoResultsMarker: boolean;
  isValidEmptyState: boolean;
};

function buildCourseSearchPath(query: string, page: number, limit: number): string {
  const params = new URLSearchParams({
    search: query,
    perpage: String(limit),
  });
  if (page > 0) {
    params.set("page", String(page));
  }
  return `/course/search.php?${params.toString()}`;
}

function checkSearchRateLimit(now = Date.now()): SearchRateLimitResult {
  while (
    searchCallTimestamps.length > 0 &&
    now - searchCallTimestamps[0] >= SEARCH_RATE_LIMIT_WINDOW_MS
  ) {
    searchCallTimestamps.shift();
  }

  if (searchCallTimestamps.length >= SEARCH_RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(
        (SEARCH_RATE_LIMIT_WINDOW_MS - (now - searchCallTimestamps[0])) / 1000
      )
    );
    return { ok: false, retryAfterSeconds };
  }

  searchCallTimestamps.push(now);
  return { ok: true };
}

function resetSearchRateLimitForTests(): void {
  searchCallTimestamps.length = 0;
}

function analyzeCourseSearchHtml(html: string): SearchHtmlAnalysis {
  const $ = cheerio.load(html);
  const regionMain = $("#region-main").first();
  const regionMainText = regionMain.text();
  const hasRegionMain = regionMain.length > 0;
  const hasNoResultsMarker =
    /(Keine\s+Kurse.*gefunden|No\s+courses?.*found|Nothing\s+to\s+display)/is
      .test(regionMainText);

  return {
    hasRegionMain,
    hasNoResultsMarker,
    isValidEmptyState: hasRegionMain && hasNoResultsMarker,
  };
}

function buildSearchTimeoutResult() {
  const payload = {
    error: true as const,
    code: "learnweb_timeout",
    message: "Learnweb course search timed out. Please try again.",
  };
  return ok(payload, {
    text: JSON.stringify(payload),
    structuredContent: payload,
    isError: true,
  });
}

function buildDownloadErrorResult(code: string, message: string) {
  const payload = {
    error: true as const,
    code,
    message,
  };
  return ok(payload, {
    text: JSON.stringify(payload),
    structuredContent: payload,
    isError: true,
  });
}

function relativePluginfilePath(target: URL, sessionBase: URL): string | null {
  let path = target.pathname;
  const basePath = sessionBase.pathname.replace(/\/+$/, "");

  if (basePath && basePath !== "") {
    const prefix = `${basePath}/`;
    if (!path.startsWith(prefix)) {
      return null;
    }
    path = path.slice(basePath.length);
  }

  return PLUGINFILE_PATH_RE.test(path) ? path : null;
}

function normalizeLearnwebPath(input: string): string {
  const queryIndex = input.indexOf("?");
  const rawPath = queryIndex === -1 ? input : input.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : input.slice(queryIndex);

  if (/%2e/i.test(rawPath) || /(^|\/)\.\.(\/|$)/.test(rawPath)) {
    throw new LearnwebUpstreamError(400, input, "Learnweb path traversal rejected.");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new LearnwebUpstreamError(400, input, "Learnweb path could not be decoded.");
  }

  const normalized = nodePath.posix.normalize(decoded);
  if (!SAFE_PATH_RE.test(normalized) || normalized.includes("..")) {
    throw new LearnwebUpstreamError(400, input, "Learnweb path is outside the allowed scope.");
  }

  return normalized + query;
}

async function getPageViaSession(session: LearnwebSession, rawPath: string) {
  const safePath = normalizeLearnwebPath(rawPath);
  const resp = await session.get(safePath);
  if (resp.status < 200 || resp.status >= 300) {
    throw new LearnwebUpstreamError(resp.status, rawPath, "Learnweb page request returned non-2xx.");
  }

  const $ = cheerio.load(resp.data);
  $("nav, header, footer, .navbar, #nav-drawer, [role='navigation'], script, style, noscript").remove();

  const title = normalizeText($("h1, h2").first().text()) || rawPath;
  const text = normalizeText($("#region-main, [role='main'], main, body").first().text());
  return {
    path: rawPath,
    title,
    text: truncate(text, 20000),
    length: text.length,
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Prüft, ob die Learnweb-Tools in diesem Server-Kontext registriert werden dürfen.
 * Siehe Dateikopf für die Begründung der Regel.
 */
function shouldRegister(scope: WorkspaceScope): boolean {
  if (!LEARNWEB_USERNAME || !LEARNWEB_PASSWORD) return false;
  if (MCP_TRANSPORT === "stdio") return true;
  if (scope !== undefined) return true;
  return false;
}

/**
 * Registriert die Learnweb-Tools, falls die Sicherheitsregel erfüllt ist.
 * Wird immer aufgerufen, gibt aber bei falscher Konfiguration einfach still
 * nichts zurück.
 */
export function registerLearnwebTools(server: McpServer, scope?: WorkspaceScope) {
  if (!shouldRegister(scope)) return;

  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: ToolConfig,
    handler: (args: any) => Promise<unknown>
  ) => void;

  // ------------------------------------------------------------------
  // Tool 1: learnweb-get-courses
  // ------------------------------------------------------------------
  registerTool(
    "learnweb-get-courses",
    {
      title: "Learnweb: List Courses",
      description:
        "List all courses visible on the Learnweb dashboard for the configured user.",
      inputSchema: {} as ToolInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async () => {
      return wrapHandler(async () => {
        const session = LearnwebSession.getInstance();
        const resp = await session.get("/my/index.php");
        if (resp.status < 200 || resp.status >= 300) {
          return { error: true, message: "Could not load dashboard." };
        }
        const courses = parseCourses(resp.data, session.getBaseUrl());
        return { courses };
      });
    }
  );

  // ------------------------------------------------------------------
  // Tool 2: learnweb-get-course-overview
  // ------------------------------------------------------------------
  registerTool(
    "learnweb-get-course-overview",
    {
      title: "Learnweb: Course Overview",
      description:
        "Return the section/activity structure of a single Learnweb course.",
      inputSchema: {
        course_id: z
          .number()
          .int()
          .positive()
          .describe("Numeric Moodle course id (id param from /course/view.php)."),
      } as ToolInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ course_id }: { course_id: number }) => {
      return wrapHandler(async () => {
        const session = LearnwebSession.getInstance();
        const resp = await session.get(`/course/view.php?id=${course_id}`);
        if (resp.status < 200 || resp.status >= 300) {
          return {
            error: true,
            message: `Could not load course ${course_id}.`,
          };
        }
        return parseCourseOverview(resp.data, course_id, session.getBaseUrl());
      });
    }
  );

  // ------------------------------------------------------------------
  // Tool 3: learnweb-read-activity
  // ------------------------------------------------------------------
  registerTool(
    "learnweb-read-activity",
    {
      title: "Learnweb: Read Activity",
      description:
        "Read a single Moodle activity in a structured form. Files are never downloaded; resources return a download_url only.",
      inputSchema: {
        cmid: z
          .number()
          .int()
          .positive()
          .describe("Moodle course module id (data-id / cmid)."),
        modtype: z
          .string()
          .regex(MODTYPE_RE, "modtype must be lowercase letters/underscores.")
          .describe(
            "Lowercase Moodle modtype, e.g. 'resource', 'url', 'page', 'forum', 'assign', 'quiz', " +
            "'ratingallocate', 'folder', 'workshop', 'lesson', 'choice', 'feedback'."
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_LIMIT)
          .optional()
          .describe(`Optional. Forum discussion page size. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Optional. Forum discussion offset (pagination)."),
      } as ToolInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args: {
      cmid: number;
      modtype: string;
      limit?: number;
      offset?: number;
    }) => {
      return wrapHandler(async () => {
        const session = LearnwebSession.getInstance();
        return dispatchActivity(session, args);
      });
    }
  );

  // ------------------------------------------------------------------
  // Tool 3b: learnweb-read-quiz-review
  // Sanktionierte Ausnahme zur Quiz-Designgrenze (siehe parsers/quizReview.ts):
  // liest NUR den eigenen, abgeschlossenen Versuch zur Fehleranalyse.
  // ------------------------------------------------------------------
  registerTool(
    "learnweb-read-quiz-review",
    {
      title: "Learnweb: Read Quiz Attempt Review",
      description:
        "Read the per-question review of YOUR OWN finished quiz attempt (mod/quiz/review.php): " +
        "question text, your answer, correct/incorrect, marks, the correct answer and the explanation. " +
        "Only FINISHED attempts return question data; non-finished/unknown states return header only. " +
        "'your_answer' is best-effort (multiple-choice, short-answer, numeric, select); complex embedded " +
        "types like Cloze/matching/drag&drop may omit it while still returning the correct answer. " +
        "Use the attempt id and cmid from a review_url returned by learnweb-read-activity (modtype 'quiz').",
      inputSchema: {
        cmid: z
          .number()
          .int()
          .positive()
          .describe("Moodle course module id (cmid) of the quiz."),
        attempt: z
          .number()
          .int()
          .positive()
          .describe("Moodle quiz attempt id (from the review_url of your own finished attempt)."),
      } as ToolInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args: { cmid: number; attempt: number }) => {
      return wrapHandler(async () => {
        const session = LearnwebSession.getInstance();
        return parseQuizReview(session, args.cmid, args.attempt);
      });
    }
  );

  // ------------------------------------------------------------------
  // Tool 4: learnweb-get-timeline
  // ------------------------------------------------------------------
  registerTool(
    "learnweb-get-timeline",
    {
      title: "Learnweb: Upcoming Timeline",
      description:
        "List upcoming activities (quizzes, assignments, events) across all courses, ordered by due date. " +
        "Parses the Moodle calendar upcoming view (/calendar/view.php?view=upcoming). " +
        "Use this tool to answer questions like 'what is due this week?' or 'are there any open quizzes?'",
      inputSchema: {
        window_days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Limit to events within the next N days. Default 30, max 90."),
        modtypes: z
          .array(z.string().regex(MODTYPE_RE))
          .optional()
          .describe("Optional filter by modtype, e.g. ['quiz', 'assign']."),
        course_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional. Only return events for this Moodle course id."),
        event_type: z
          .string()
          .regex(/^[a-z_]+$/)
          .optional()
          .describe("Optional. Filter by event type, e.g. 'due', 'open', 'close'."),
      } as ToolInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args: { window_days?: number; modtypes?: string[]; course_id?: number; event_type?: string }) => {
      return wrapHandler(async () => {
        const session = LearnwebSession.getInstance();
        return parseTimeline(session, args);
      });
    }
  );

  // ------------------------------------------------------------------
  // Tool 5: learnweb-search-courses
  // ------------------------------------------------------------------
  registerTool(
    "learnweb-search-courses",
    {
      title: "Learnweb: Search Courses",
      description:
        "Search the global Learnweb course catalogue via /course/search.php. " +
        "`limit` is only an upper bound; paginate exclusively via `has_more`. " +
        "`effective_perpage` reports how many results Moodle rendered on that page.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .max(200)
          .describe("Search term for the global Learnweb course catalogue."),
        page: z
          .number()
          .int()
          .min(0)
          .max(SEARCH_MAX_PAGE)
          .optional()
          .describe(`Optional result page. Default 0, max ${SEARCH_MAX_PAGE}.`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_MAX_LIMIT)
          .optional()
          .describe(
            `Optional upper bound for returned results. Default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}.`
          ),
      } as ToolInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args: { query: string; page?: number; limit?: number }) => {
      try {
        const rateLimit = checkSearchRateLimit();
        if (!rateLimit.ok) {
          return ok({
            error: true,
            code: "rate_limited",
            message: `Search rate limit exceeded. Retry in ${rateLimit.retryAfterSeconds} seconds.`,
            retryAfterSeconds: rateLimit.retryAfterSeconds,
          });
        }

        const session = LearnwebSession.getInstance();
        const page = args.page ?? 0;
        const limit = args.limit ?? SEARCH_DEFAULT_LIMIT;
        const resp = await session.get(buildCourseSearchPath(args.query, page, limit), {
          timeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
        });

        if (resp.status < 200 || resp.status >= 300) {
          return ok({
            error: true,
            code: "course_search_unavailable",
            message: "Could not load course search.",
          });
        }

        const html = resp.data;
        const analysis = analyzeCourseSearchHtml(html);
        if (!analysis.hasRegionMain) {
          return ok({
            error: true,
            code: "unexpected_html",
            message: "Unexpected HTML structure in course search response.",
          });
        }

        const parsed = parseCourseSearch(html, session.getBaseUrl(), page);
        if (parsed.results.length === 0 && !analysis.isValidEmptyState) {
          return ok({
            error: true,
            code: "unexpected_html",
            message: "Unexpected HTML structure in course search response.",
          });
        }

        return ok({
          results: parsed.results.slice(0, limit),
          page: parsed.page,
          has_more: parsed.has_more,
          effective_perpage: parsed.results.length,
        });
      } catch (err) {
        if (err instanceof LearnwebTimeoutError) {
          return buildSearchTimeoutResult();
        }
        return wrapHandler(async () => {
          throw err;
        });
      }
    }
  );

  // ------------------------------------------------------------------
  // Tool 6: learnweb-get-page
  // ------------------------------------------------------------------
  registerTool(
    "learnweb-get-page",
    {
      title: "Learnweb: Get Page (SSO Proxy)",
      description:
        "Return cleaned text from a SSO-protected Learnweb page. " +
        "Only paths under /mod, /course, /calendar, /my and /blocks are allowed.",
      inputSchema: {
        path: z
          .string()
          .regex(SAFE_PATH_RE, "path must be under /mod, /course, /calendar, /my or /blocks")
          .max(500)
          .describe("Learnweb path, e.g. /mod/forum/view.php?id=123."),
      } as ToolInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ path: rawPath }: { path: string }) => {
      return wrapHandler(async () => {
        const session = LearnwebSession.getInstance();
        return getPageViaSession(session, rawPath);
      });
    }
  );

  // ------------------------------------------------------------------
  // Tool 7: learnweb-get-calendar-month
  // ------------------------------------------------------------------
  registerTool(
    "learnweb-get-calendar-month",
    {
      title: "Learnweb: Calendar Month View",
      description:
        "Return all calendar events for a given Moodle month (defaults to current month). " +
        "Use this tool when the upcoming-view does not cover far-future deadlines.",
      inputSchema: {
        year: z.number().int().min(2020).max(2100).optional()
          .describe("Optional. Year (e.g. 2026). Defaults to current year."),
        month: z.number().int().min(1).max(12).optional()
          .describe("Optional. Month 1–12. Defaults to current month."),
        course_id: z.number().int().positive().optional()
          .describe("Optional. Restrict to events for this Moodle course id."),
      } as ToolInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args: { year?: number; month?: number; course_id?: number }) => {
      return wrapHandler(async () => {
        const session = LearnwebSession.getInstance();
        return parseCalendarMonth(session, args);
      });
    }
  );

  // ------------------------------------------------------------------
  // Tool 8: learnweb-download-resource
  // ------------------------------------------------------------------
  registerTool(
    "learnweb-download-resource",
    {
      title: "Learnweb: Download Resource",
      description:
        "Authenticated download of a Moodle pluginfile.php URL using the active Learnweb session. " +
        "Use only with URLs from a prior learnweb-read-activity response (download_url field). " +
        "Returns the file as MCP resource content (base64 blob + mime type). Default max 3 MB; hard cap 25 MB.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe("Absolute Moodle pluginfile.php URL returned as download_url by learnweb-read-activity."),
        max_bytes: z
          .number()
          .int()
          .positive()
          .max(MAX_DOWNLOAD_BYTES)
          .optional()
          .describe(`Optional upper byte limit. Default ${DEFAULT_DOWNLOAD_BYTES}, hard cap ${MAX_DOWNLOAD_BYTES}.`),
      } as ToolInputSchema,
      outputSchema: {
        filename: z.string().optional(),
        size: z.number().int().nonnegative(),
        content_type: z.string(),
      } as ToolOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args: { url: string; max_bytes?: number }) => {
      try {
        const session = LearnwebSession.getInstance();
        const sessionBase = new URL(session.getBaseUrl());
        let target: URL;
        try {
          target = new URL(args.url);
        } catch {
          return buildDownloadErrorResult("invalid_url", "URL could not be parsed.");
        }

        if (target.protocol !== sessionBase.protocol) {
          return buildDownloadErrorResult("invalid_url", "URL protocol does not match Learnweb base URL.");
        }
        if (target.host !== sessionBase.host) {
          return buildDownloadErrorResult("invalid_url", "URL host does not match Learnweb base URL.");
        }
        if (!relativePluginfilePath(target, sessionBase)) {
          return buildDownloadErrorResult("invalid_url", "URL must point to a Moodle pluginfile.php path below the Learnweb base URL.");
        }

        const maxBytes = args.max_bytes ?? DEFAULT_DOWNLOAD_BYTES;
        const result = await session.downloadFile(args.url, { maxBytes });
        const metadata = {
          filename: result.filename,
          size: result.bytes.length,
          content_type: result.contentType,
        };

        return {
          content: [
            {
              type: "resource" as const,
              resource: {
                uri: args.url,
                mimeType: result.contentType,
                blob: result.bytes.toString("base64"),
              },
            },
            {
              type: "text" as const,
              text: JSON.stringify(metadata),
            },
          ],
          structuredContent: metadata,
        };
      } catch (err) {
        if (err instanceof LearnwebFileTooLargeError) {
          return buildDownloadErrorResult("file_too_large", err.message);
        }
        if (err instanceof LearnwebNotConfiguredError) {
          return buildDownloadErrorResult("learnweb_not_configured", "Learnweb is not configured on this server.");
        }
        if (err instanceof LearnwebAuthError) {
          return buildDownloadErrorResult("learnweb_auth_error", "Learnweb authentication failed.");
        }
        if (err instanceof LearnwebTimeoutError) {
          return buildDownloadErrorResult("learnweb_timeout", "Learnweb request timed out.");
        }
        if (err instanceof LearnwebUpstreamError) {
          return buildDownloadErrorResult("learnweb_upstream_error", "Learnweb upstream returned an error.");
        }
        throw err;
      }
    }
  );
}

/**
 * Führt den Activity-Parser passend zum modtype aus. Unbekannte modtypes
 * landen im fallback-Parser (raw_text + parser_degraded:true).
 */
async function dispatchActivity(
  session: LearnwebSession,
  args: { cmid: number; modtype: string; limit?: number; offset?: number }
) {
  const { cmid, modtype, limit, offset } = args;
  try {
    switch (modtype) {
      case "resource":
        return { modtype, ...(await parseResource(session, cmid)) };
      case "url":
        return { modtype, ...(await parseUrl(session, cmid)) };
      case "page":
        return { modtype, ...(await parsePage(session, cmid)) };
      case "forum":
        return { modtype, ...(await parseForum(session, cmid, { limit, offset })) };
      case "assign":
        return { modtype, ...(await parseAssign(session, cmid)) };
      case "quiz":
        return { modtype, ...(await parseQuiz(session, cmid)) };
      case "ratingallocate":
        return { modtype, ...(await parseRatingAllocate(session, cmid)) };
      case "folder":
        return { modtype, ...(await parseFolder(session, cmid)) };
      case "workshop":
        return { modtype, ...(await parseWorkshop(session, cmid)) };
      case "lesson":
        return { modtype, ...(await parseLesson(session, cmid)) };
      case "choice":
        return { modtype, ...(await parseChoice(session, cmid)) };
      case "feedback":
        return { modtype, ...(await parseFeedback(session, cmid)) };
      default:
        return { modtype, ...(await parseFallback(session, cmid, modtype)) };
    }
  } catch (err) {
    if (!(err instanceof LearnwebParseError)) throw err;
    console.error(`[dispatchActivity] parser_fail modtype=${modtype} cmid=${cmid}: ${err.message}`);
    const fallback = await parseFallback(session, cmid, modtype);
    return {
      modtype,
      ...fallback,
      parser_error: {
        code: "learnweb_parse_error",
        parser: err.parser ?? modtype,
        selector: err.selector,
        message: String(err.message ?? "").slice(0, 200),
      },
    };
  }
}

/**
 * Generischer Try/Catch-Wrapper für alle Tool-Handler. Liefert auf Fehler
 * eine isError:true-Response mit generischer Message — NIEMALS Credentials
 * oder Session-Cookies im Output.
 */
async function wrapHandler<T>(fn: () => Promise<T>) {
  const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
  try {
    const value = await fn();
    return ok(value as unknown);
  } catch (err) {
    // Bewusst generische Messages — keine Cookie-Details oder Diagnostics rausgeben.
    const code =
      err instanceof LearnwebNotConfiguredError ? "learnweb_not_configured"
      : err instanceof LearnwebAuthError        ? "learnweb_auth_error"
      : err instanceof LearnwebTimeoutError     ? "learnweb_timeout"
      : err instanceof LearnwebParseError       ? "learnweb_parse_error"
      : err instanceof LearnwebUpstreamError    ? "learnweb_upstream_error"
      :                                           "learnweb_error";
    const message =
      err instanceof LearnwebNotConfiguredError ? "Learnweb is not configured on this server."
      : err instanceof LearnwebAuthError        ? "Learnweb authentication failed."
      : err instanceof LearnwebTimeoutError     ? "Learnweb request timed out."
      :                                           "Learnweb request failed.";
    const context: Record<string, unknown> = {};
    if (err instanceof LearnwebParseError) {
      if (err.parser) context.parser = err.parser;
      if (err.selector) context.selector = err.selector;
    }
    if (err instanceof LearnwebUpstreamError) {
      if (err.status != null) context.status = err.status;
      if (err.path) context.path = err.path;
    }
    console.error(`[${requestId}] ${code}: ${err instanceof Error ? err.message : String(err)}`);
    const payload = { error: true, code, message, request_id: requestId, context };
    return ok(
      payload,
      {
        text: JSON.stringify(payload),
        structuredContent: payload,
        isError: true,
      }
    );
  }
}

/** Exportiert für Tests. */
export const _testing = {
  shouldRegister,
  dispatchActivity,
  buildCourseSearchPath,
  checkSearchRateLimit,
  resetSearchRateLimitForTests,
  analyzeCourseSearchHtml,
  buildSearchTimeoutResult,
  buildDownloadErrorResult,
  relativePluginfilePath,
  DEFAULT_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_BYTES,
  PLUGINFILE_PATH_RE,
  SAFE_PATH_RE,
  normalizeLearnwebPath,
  getPageViaSession,
  wrapHandler,
};
