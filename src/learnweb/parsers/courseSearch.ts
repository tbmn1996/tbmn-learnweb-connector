import * as cheerio from "cheerio";
import { absoluteUrl, normalizeText } from "./common";

const SUMMARY_MAX_LEN = 300;

export interface LearnwebSearchResult {
  course_id: number;
  fullname: string;
  category?: string;
  summary_snippet?: string;
  url: string;
  enrol_url: string;
}

export interface LearnwebSearchPage {
  results: LearnwebSearchResult[];
  page: number;
  has_more: boolean;
}

function truncateSummarySnippet(text: string): string | undefined {
  const normalized = normalizeText(text);
  if (!normalized) return undefined;
  if (normalized.length <= SUMMARY_MAX_LEN) return normalized;

  const cut = normalized.slice(0, SUMMARY_MAX_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  const safeCut = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return safeCut.trimEnd() + "…";
}

function parsePageNumber($item: cheerio.Cheerio<any>): number | null {
  const attr = $item.attr("data-page-number");
  if (attr) {
    const pageNumber = Number.parseInt(attr, 10);
    if (Number.isFinite(pageNumber)) return pageNumber;
  }

  const linkText = normalizeText($item.find("a.page-link").first().text());
  if (/^\d+$/.test(linkText)) {
    return Number.parseInt(linkText, 10);
  }

  return null;
}

function hasNextPage(
  $: cheerio.CheerioAPI,
  activeItem: cheerio.Cheerio<any>
): boolean {
  if (activeItem.length === 0) return false;

  const activePage = parsePageNumber(activeItem);
  return activeItem
    .nextAll("li.page-item")
    .toArray()
    .some((el) => {
      const candidate = $(el);
      const candidatePage = parsePageNumber(candidate);
      if (candidatePage == null) return false;
      if (activePage == null) return true;
      return candidatePage > activePage;
    });
}

export function parseCourseSearch(
  html: string,
  baseUrl: string,
  currentPage: number
): LearnwebSearchPage {
  const $ = cheerio.load(html);
  const results: LearnwebSearchResult[] = [];
  const seen = new Set<number>();

  $("div.coursebox[data-courseid]").each((_, el) => {
    const box = $(el);
    const idAttr = box.attr("data-courseid");
    const courseId = idAttr ? Number.parseInt(idAttr, 10) : Number.NaN;
    if (!Number.isFinite(courseId) || seen.has(courseId)) return;

    const link = box.find("h3.coursename a, h3 a[href*='/course/view.php?id=']").first();
    const href = link.attr("href") ?? "";
    const fullname =
      normalizeText(link.attr("title") ?? link.text()) || `Course ${courseId}`;
    const category =
      normalizeText(box.find(".coursecat a").first().text()) || undefined;
    const summary_snippet = truncateSummarySnippet(
      box.find(".summary").first().text()
    );

    seen.add(courseId);
    results.push({
      course_id: courseId,
      fullname,
      ...(category ? { category } : {}),
      ...(summary_snippet ? { summary_snippet } : {}),
      url: absoluteUrl(baseUrl, href),
      enrol_url: absoluteUrl(baseUrl, `/enrol/index.php?id=${courseId}`),
    });
  });

  const activeItem = $("ul.pagination li.page-item.active").first();
  return {
    results,
    page: currentPage,
    has_more: hasNextPage($, activeItem),
  };
}
