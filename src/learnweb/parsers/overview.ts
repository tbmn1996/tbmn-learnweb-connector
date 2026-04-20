/**
 * Parser für eine Moodle-Kursseite (`/course/view.php?id=<course_id>`).
 * Portiert aus learnweb_sync.py _extract_activities().
 */

import * as cheerio from "cheerio";
import { absoluteUrl, normalizeText, truncate } from "./common";

export interface LearnwebActivity {
  cmid: number;
  name: string;
  modtype: string;
  url: string;
}

export interface LearnwebSection {
  name: string;
  activities: LearnwebActivity[];
}

export interface LearnwebCourseOverview {
  course_id: number;
  course_name: string;
  sections: LearnwebSection[];
}

const MAX_ACTIVITY_NAME_LEN = 200;

/**
 * Parsed die Sections + Activities einer Kursseite.
 *
 * DOM-Struktur (Moodle 4.x):
 *   <li class="course-section" data-sectionname="Sektion 1">
 *     <ul data-for="cmlist">
 *       <li data-for="cmitem" data-id="12345" class="... modtype_resource ...">
 *         <div data-activityname="Vorlesung 1">...</div>
 *         <a class="aalink|stretched-link" href="..."/>
 *       </li>
 *     </ul>
 *   </li>
 *
 * Skipped:
 *   - modtype="label" (reine Text-Blöcke ohne eigene Seite)
 *   - Items ohne data-id
 */
export function parseCourseOverview(
  html: string,
  courseId: number,
  baseUrl: string
): LearnwebCourseOverview {
  const $ = cheerio.load(html);

  // Kursname: Moodle setzt den in <h1> der Page oder im <title>.
  const courseName =
    normalizeText($("h1").first().text()) ||
    normalizeText($("title").text().replace(/:.*$/, "")) ||
    `Course ${courseId}`;

  const sections: LearnwebSection[] = [];

  $("li.course-section").each((_, sectionLi) => {
    const $section = $(sectionLi);
    const sectionName =
      $section.attr("data-sectionname") ||
      normalizeText($section.find("h3, h4").first().text()) ||
      "";

    const cmlist = $section.find('ul[data-for="cmlist"]').first();
    if (cmlist.length === 0) return;

    const activities: LearnwebActivity[] = [];

    cmlist.find('li[data-for="cmitem"]').each((_, li) => {
      const $li = $(li);
      const cmidRaw = $li.attr("data-id");
      if (!cmidRaw) return;
      const cmid = Number.parseInt(cmidRaw, 10);
      if (Number.isNaN(cmid)) return;

      // Modtype aus CSS-Klasse extrahieren.
      const classAttr = $li.attr("class") || "";
      const modMatch = classAttr.match(/\bmodtype_([a-z_]+)/);
      const modtype = modMatch ? modMatch[1] : "";

      // Labels haben keine eigene View-Seite — skippen.
      if (!modtype || modtype === "label") return;

      // Activity-Name bevorzugt aus data-activityname.
      let name = $li.find("[data-activityname]").first().attr("data-activityname") ?? "";
      if (!name) {
        name = normalizeText($li.find(".instancename").first().text());
      }
      name = truncate(name || `Activity ${cmid}`, MAX_ACTIVITY_NAME_LEN);

      // View-Link.
      const linkHref =
        $li.find("a.aalink").first().attr("href") ||
        $li.find("a.stretched-link").first().attr("href") ||
        "";
      const url = linkHref
        ? absoluteUrl(baseUrl, linkHref)
        : absoluteUrl(baseUrl, `/mod/${modtype}/view.php?id=${cmid}`);

      activities.push({ cmid, name, modtype, url });
    });

    // Leere Sections trotzdem mit aufnehmen wäre möglich; wir machen es
    // so wie der Python-Scraper und filtern sie raus.
    if (activities.length > 0) {
      sections.push({ name: sectionName, activities });
    }
  });

  return {
    course_id: courseId,
    course_name: courseName,
    sections,
  };
}
