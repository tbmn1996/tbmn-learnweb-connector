/**
 * Discovery-Script (Stufe 1): findet heraus, WIE Aufzeichnungen in den Kursen
 * des eingeloggten Users eingebunden sind (Opencast / Panopto / Zoom / Kaltura /
 * direkte mp4 / …). Read-only.
 *
 * Ablauf:
 *   1. Kurse laden — sowohl /my/index.php (Dashboard) als auch /my/courses.php,
 *      um zu prüfen, ob das Dashboard für "alle Kurse" vollständig ist.
 *   2. Pro Kurs die Section/Activity-Struktur parsen, Aufzeichnungs-Kandidaten
 *      markieren (modtype-Heuristik + Name-Heuristik).
 *   3. Für eine begrenzte Auswahl Kandidaten die view.php-Seite holen (Redirects
 *      erlaubt) und Einbettungs-Signale extrahieren (iframe-src, video-source,
 *      externe Hosts, LTI-Form, pluginfile-Links, Episoden-IDs).
 *   4. Rohe HTMLs nach test/fixtures/learnweb/_live/ (gitignored, PII) schreiben +
 *      einen JSON-Report und eine lesbare Markdown-Zusammenfassung.
 *
 * Aufruf:  scripts/with-keychain-env.sh npx tsx scripts/capture-recording-fixtures.ts
 *          [--max-courses N] [--max-candidates N]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { LearnwebSession } from "../src/learnweb/session";
import { parseCourses, type LearnwebCourse } from "../src/learnweb/parsers/courses";
import {
  parseCourseOverview,
  type LearnwebActivity,
} from "../src/learnweb/parsers/overview";

const LIVE_DIR = path.resolve("test/fixtures/learnweb/_live");

// Modtypes, hinter denen sich eine Aufzeichnung verstecken kann.
const RECORDING_MODTYPES = new Set(["lti", "url", "resource", "folder", "page", "hvp"]);

// Namens-Heuristik für Aufzeichnungen (deutsch + englisch + Plattformnamen).
const NAME_RE =
  /aufzeichn|vorlesung|stream|recording|tutorium|tutorial|opencast|panopto|zoom|video|mitschnitt|playback|kaltura|helix|lecture|lehrvideo|screencast/i;

// Erkennt Mediendateien an der Endung.
const MEDIA_EXT_RE = /\.(mp4|m3u8|mpd|webm|mov|mkv|m4a|mp3|aac|wav)(\?|#|$)/i;

// UUID (z. B. Opencast-Episoden-ID).
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Args = { maxCourses: number; maxCandidates: number };

function parseArgs(argv: string[]): Args {
  const args: Args = { maxCourses: Infinity, maxCandidates: 30 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-courses") args.maxCourses = Number(argv[++i]);
    else if (argv[i] === "--max-candidates") args.maxCandidates = Number(argv[++i]);
  }
  return args;
}

function detectSystem(urls: string[], html: string): string {
  const hay = `${urls.join(" ")} ${html.slice(0, 20000)}`;
  if (/opencast|paella|\/engage\/|\/play\/|episode/i.test(hay)) return "opencast";
  if (/panopto/i.test(hay)) return "panopto";
  if (/zoom\.us|zoom\.com/i.test(hay)) return "zoom";
  if (/kaltura|mediaspace|\/kaf\//i.test(hay)) return "kaltura";
  if (/youtube\.com|youtu\.be/i.test(hay)) return "youtube";
  if (/vimeo\.com/i.test(hay)) return "vimeo";
  if (urls.some((u) => MEDIA_EXT_RE.test(u))) return "direct-file";
  return "unknown";
}

type ViewAnalysis = {
  cmid: number;
  modtype: string;
  name: string;
  view_url: string;
  final_url: string;
  http_status: number;
  content_type?: string;
  redirect_location?: string;
  page_title: string;
  iframe_srcs: string[];
  media_sources: string[];
  pluginfile_links: string[];
  external_hosts: string[];
  lti_form?: { action: string; input_names: string[] };
  episode_ids: string[];
  detected_system: string;
};

async function analyzeCandidate(
  session: LearnwebSession,
  activity: LearnwebActivity
): Promise<{ analysis: ViewAnalysis; rawHtml: string }> {
  const baseHost = new URL(session.getBaseUrl()).host;
  // mod/url würde bei direktem Redirect die externe URL als Location liefern.
  const resp = await session.get(activity.url, { allowRedirects: true });
  const html = typeof resp.data === "string" ? resp.data : String(resp.data ?? "");
  const $ = cheerio.load(html);

  const iframeSrcs = new Set<string>();
  $("iframe[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) iframeSrcs.add(src);
  });

  const mediaSources = new Set<string>();
  $("video[src], audio[src], source[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) mediaSources.add(src);
  });
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && MEDIA_EXT_RE.test(href)) mediaSources.add(href);
  });

  const pluginfileLinks = new Set<string>();
  $('a[href*="pluginfile.php"], source[src*="pluginfile.php"]').each((_, el) => {
    const href = $(el).attr("href") || $(el).attr("src");
    if (href) pluginfileLinks.add(href);
  });

  // Externe Hosts aus iframe/a/form/source sammeln (≠ Learnweb-Host).
  const externalHosts = new Set<string>();
  const allUrls: string[] = [];
  $("iframe[src], a[href], form[action], source[src]").each((_, el) => {
    const raw = $(el).attr("src") || $(el).attr("href") || $(el).attr("action");
    if (!raw) return;
    allUrls.push(raw);
    try {
      const u = new URL(raw, resp.url);
      if (u.host && u.host !== baseHost) externalHosts.add(u.host);
    } catch {
      /* relative/ungültige URL ignorieren */
    }
  });

  // LTI-Auto-Submit-Form (nur Feld-NAMEN, niemals Werte → keine Secrets).
  let ltiForm: { action: string; input_names: string[] } | undefined;
  const form = $('form[action*="lti"], form#ltiLaunchForm, form[name="ltiLaunchForm"]').first();
  if (form.length > 0) {
    const inputNames: string[] = [];
    form.find("input[name]").each((_, el) => {
      const n = $(el).attr("name");
      if (n) inputNames.push(n);
    });
    ltiForm = { action: form.attr("action") || "", input_names: inputNames };
  }

  const episodeIds = new Set<string>();
  for (const u of [...iframeSrcs, ...mediaSources, ...allUrls, resp.url]) {
    const m = UUID_RE.exec(u);
    if (m) episodeIds.add(m[0]);
  }

  const analysis: ViewAnalysis = {
    cmid: activity.cmid,
    modtype: activity.modtype,
    name: activity.name,
    view_url: activity.url,
    final_url: resp.url,
    http_status: resp.status,
    content_type: resp.headers["content-type"],
    redirect_location: resp.headers["location"],
    page_title: $("h1, h2").first().text().replace(/\s+/g, " ").trim().slice(0, 200),
    iframe_srcs: [...iframeSrcs],
    media_sources: [...mediaSources],
    pluginfile_links: [...pluginfileLinks],
    external_hosts: [...externalHosts],
    lti_form: ltiForm,
    episode_ids: [...episodeIds],
    detected_system: detectSystem(
      [...iframeSrcs, ...mediaSources, ...allUrls, resp.headers["location"] ?? ""],
      html
    ),
  };

  return { analysis, rawHtml: html };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(LIVE_DIR, { recursive: true });
  const session = LearnwebSession.getInstance();

  // 1) Kurse aus beiden Quellen — Vollständigkeit des Dashboards prüfen.
  const dashResp = await session.get("/my/index.php");
  const dashboardCourses = parseCourses(dashResp.data, session.getBaseUrl());

  let coursesPageCourses: LearnwebCourse[] = [];
  try {
    const cpResp = await session.get("/my/courses.php");
    if (cpResp.status >= 200 && cpResp.status < 300) {
      coursesPageCourses = parseCourses(cpResp.data, session.getBaseUrl());
    }
  } catch {
    /* /my/courses.php evtl. nicht vorhanden — ignorieren */
  }

  // Union beider Quellen = beste Annäherung an "alle Kurse".
  const byId = new Map<number, LearnwebCourse>();
  for (const c of [...dashboardCourses, ...coursesPageCourses]) byId.set(c.course_id, c);
  const allCourses = [...byId.values()].slice(0, args.maxCourses);

  console.log(
    `Kurse: Dashboard=${dashboardCourses.length}, /my/courses.php=${coursesPageCourses.length}, Union=${byId.size}`
  );

  // 2) Aktivitäten je Kurs parsen, Kandidaten markieren.
  type Cand = LearnwebActivity & { course_id: number; course_name: string; nameHit: boolean };
  const candidates: Cand[] = [];
  for (const course of allCourses) {
    try {
      const ovResp = await session.get(`/course/view.php?id=${course.course_id}`);
      if (ovResp.status < 200 || ovResp.status >= 300) continue;
      const overview = parseCourseOverview(ovResp.data, course.course_id, session.getBaseUrl());
      for (const section of overview.sections) {
        for (const act of section.activities) {
          const nameHit = NAME_RE.test(act.name);
          if (RECORDING_MODTYPES.has(act.modtype) || nameHit) {
            candidates.push({
              ...act,
              course_id: course.course_id,
              course_name: overview.course_name,
              nameHit,
            });
          }
        }
      }
    } catch (err) {
      console.error(`Kurs ${course.course_id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`Aufzeichnungs-Kandidaten gefunden: ${candidates.length}`);

  // 3) Auswahl vertiefen: Name-Treffer zuerst, dann je modtype begrenzen.
  candidates.sort((a, b) => Number(b.nameHit) - Number(a.nameHit));
  const perModtype = new Map<string, number>();
  const selected: Cand[] = [];
  for (const c of candidates) {
    if (selected.length >= args.maxCandidates) break;
    const n = perModtype.get(c.modtype) ?? 0;
    // Pro modtype max 6, außer es ist ein Name-Treffer (die wollen wir sehen).
    if (n >= 6 && !c.nameHit) continue;
    perModtype.set(c.modtype, n + 1);
    selected.push(c);
  }

  const analyses: ViewAnalysis[] = [];
  for (const c of selected) {
    try {
      const { analysis, rawHtml } = await analyzeCandidate(session, c);
      analyses.push(analysis);
      await writeFile(
        path.join(LIVE_DIR, `recording-${c.cmid}-${c.modtype}.html`),
        rawHtml,
        "utf8"
      );
      console.log(
        `  [${analysis.detected_system}] ${c.modtype} cmid=${c.cmid} "${c.name.slice(0, 60)}"` +
          (analysis.external_hosts.length ? ` → ${analysis.external_hosts.join(", ")}` : "")
      );
    } catch (err) {
      console.error(`  cmid=${c.cmid} (${c.modtype}): ${err instanceof Error ? err.message : err}`);
    }
  }

  // 4) Report + Zusammenfassung schreiben.
  const systemCounts: Record<string, number> = {};
  const modtypeCounts: Record<string, number> = {};
  for (const a of analyses) systemCounts[a.detected_system] = (systemCounts[a.detected_system] ?? 0) + 1;
  for (const c of candidates) modtypeCounts[c.modtype] = (modtypeCounts[c.modtype] ?? 0) + 1;

  const report = {
    generated_at: new Date().toISOString(),
    courses: {
      dashboard_count: dashboardCourses.length,
      courses_page_count: coursesPageCourses.length,
      union_count: byId.size,
      dashboard_complete: dashboardCourses.length >= byId.size,
    },
    candidate_modtype_counts: modtypeCounts,
    analyzed_system_counts: systemCounts,
    analyzed: analyses,
  };
  await writeFile(
    path.join(LIVE_DIR, "recording-discovery-report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );

  const md = [
    "# Recording-Discovery — Zusammenfassung",
    "",
    `Erzeugt: ${report.generated_at}`,
    "",
    `- Kurse: Dashboard ${dashboardCourses.length} / Kursübersicht ${coursesPageCourses.length} / Union ${byId.size}`,
    `- Dashboard vollständig für "alle Kurse": ${report.courses.dashboard_complete ? "ja" : "NEIN → /my/courses.php nötig"}`,
    `- Kandidaten gesamt: ${candidates.length} (analysiert: ${analyses.length})`,
    `- Modtype-Verteilung: ${JSON.stringify(modtypeCounts)}`,
    `- Erkannte Systeme (analysiert): ${JSON.stringify(systemCounts)}`,
    "",
    "## Analysierte Kandidaten",
    "",
    ...analyses.map(
      (a) =>
        `### ${a.detected_system} — ${a.modtype} cmid=${a.cmid}\n` +
        `- Name: ${a.name}\n` +
        `- View: ${a.view_url}\n` +
        `- Final: ${a.final_url} (HTTP ${a.http_status}, ${a.content_type ?? "?"})\n` +
        (a.redirect_location ? `- Redirect: ${a.redirect_location}\n` : "") +
        (a.iframe_srcs.length ? `- iframes: ${a.iframe_srcs.join(" | ")}\n` : "") +
        (a.media_sources.length ? `- media: ${a.media_sources.join(" | ")}\n` : "") +
        (a.pluginfile_links.length ? `- pluginfile: ${a.pluginfile_links.slice(0, 5).join(" | ")}\n` : "") +
        (a.external_hosts.length ? `- externe Hosts: ${a.external_hosts.join(", ")}\n` : "") +
        (a.lti_form ? `- LTI-Form action: ${a.lti_form.action} (Felder: ${a.lti_form.input_names.join(", ")})\n` : "") +
        (a.episode_ids.length ? `- Episoden-IDs: ${a.episode_ids.join(", ")}\n` : "")
    ),
  ].join("\n");
  await writeFile(path.join(LIVE_DIR, "recording-discovery-summary.md"), md, "utf8");

  console.log(`\nReport: ${path.join(LIVE_DIR, "recording-discovery-report.json")}`);
  console.log(`Summary: ${path.join(LIVE_DIR, "recording-discovery-summary.md")}`);
  console.log(`Erkannte Systeme: ${JSON.stringify(systemCounts)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
