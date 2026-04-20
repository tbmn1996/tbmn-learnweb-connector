/**
 * Parser für die Moodle-Dashboard-Seite (`/my/index.php`).
 * Portiert aus learnweb_sync.py get_courses().
 */

import * as cheerio from "cheerio";
import { absoluteUrl, normalizeText } from "./common";

export interface LearnwebCourse {
  course_id: number;
  name: string;
  url: string;
}

/**
 * Extrahiert alle Kurse, die der User auf seinem Moodle-Dashboard sieht.
 *
 * Das Dashboard enthält oft mehrere Darstellungen desselben Kurses (Liste +
 * Tiles), daher deduplizieren wir anhand der course_id.
 */
export function parseCourses(html: string, baseUrl: string): LearnwebCourse[] {
  const $ = cheerio.load(html);
  const courses: LearnwebCourse[] = [];
  const seen = new Set<number>();

  $('a[href*="/course/view.php?id="]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const m = href.match(/[?&]id=(\d+)/);
    if (!m) return;

    const courseId = Number.parseInt(m[1], 10);
    if (Number.isNaN(courseId) || seen.has(courseId)) return;
    seen.add(courseId);

    // Bevorzugt der title-Attribut (voller Kursname), sonst Link-Text.
    const title = $(el).attr("title");
    const text = normalizeText($(el).text());
    const name = (title && normalizeText(title)) || text || `Course ${courseId}`;

    courses.push({
      course_id: courseId,
      name,
      url: absoluteUrl(baseUrl, href),
    });
  });

  return courses;
}
