/**
 * Parser für Moodle-Foren (mod/forum = Diskussionsforum).
 *
 * Wir lesen nur die Diskussionsliste (Discussion List View), NICHT die
 * einzelnen Postings. Das hält die Tool-Surface überschaubar und spart
 * viele Requests (ein Forum kann hunderte Diskussionen + Seiten haben).
 *
 * Struktur (Moodle 4.x, siehe test/fixtures/learnweb/forum.html):
 *   table.discussion-list
 *     tbody
 *       tr[data-region="discussion-list-item"][data-discussionid]
 *         th.topic > a        → Titel + Link zur Diskussion
 *         td.author           → Diskussions-Starter
 *         td.text-start       → Last-Post-Autor
 *         td > span (Zahl)    → Replies-Count
 *
 * Der Parser respektiert `limit`/`offset`, damit KI-Clients seitenweise
 * iterieren können, ohne dass der Response zu groß wird.
 */

import * as cheerio from "cheerio";
import type { LearnwebSession } from "../session";
import { absoluteUrl, extractTextFromSelector, normalizeText, truncate } from "./common";

export interface ForumDiscussion {
  discussion_id?: number;
  title: string;
  author?: string;
  last_post?: string;
  replies?: number;
  url?: string;
}

export interface ForumContent {
  description?: string;
  discussions: ForumDiscussion[];
  total_on_page: number;
  has_more: boolean;
  offset: number;
  limit: number;
}

export interface ForumResult {
  title: string;
  content: ForumContent;
  parser_degraded?: boolean;
}

export interface ForumOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export async function parseForum(
  session: LearnwebSession,
  cmid: number,
  options: ForumOptions = {}
): Promise<ForumResult> {
  // limit/offset normalisieren; defensiv gegen negative/unsinnige Werte.
  const limit = clampLimit(options.limit);
  const offset = Math.max(0, options.offset ?? 0);

  const path = `/mod/forum/view.php?id=${cmid}`;
  const resp = await session.get(path);

  if (resp.status < 200 || resp.status >= 300) {
    return {
      title: `Forum ${cmid}`,
      content: emptyContent(limit, offset),
      parser_degraded: true,
    };
  }

  const $ = cheerio.load(resp.data);
  const title = normalizeText($("h1, h2").first().text()) || `Forum ${cmid}`;

  const description =
    extractTextFromSelector($, ".activity-description", 2000) ||
    extractTextFromSelector($, "#intro", 2000) ||
    undefined;

  // Alle Diskussions-Zeilen sammeln; has_more wird aus der Gesamtzahl abgeleitet.
  const rows = $('table.discussion-list tr[data-region="discussion-list-item"]');
  const total = rows.length;

  const sliced = rows.slice(offset, offset + limit);
  const discussions: ForumDiscussion[] = [];

  sliced.each((_, tr) => {
    const $tr = $(tr);
    const discussionId = toIntOrUndef($tr.attr("data-discussionid"));

    // Titel + URL aus th.topic. Manche Moodle-Themes nutzen nur die Tabelle ohne th.topic,
    // daher Fallback: erster <a> mit href auf discuss.php.
    let titleEl = $tr.find("th.topic a").first();
    if (titleEl.length === 0) {
      titleEl = $tr.find('a[href*="/mod/forum/discuss.php"]').first();
    }
    const itemTitle = normalizeText(titleEl.text());
    const href = titleEl.attr("href");
    const url = href ? absoluteUrl(session.getBaseUrl(), href) : undefined;

    // Author (Starter): erstes sichtbares Name-Element in td.author.
    const author = normalizeText(
      $tr.find("td.author .author-info > div").first().text() ||
        $tr.find("td.author").first().text()
    );

    // Last-Post: td.text-start (Moodle 4.x) oder td.lastpost (ältere Themes).
    const lastPost = normalizeText(
      $tr.find("td.text-start .author-info > div").first().text() ||
        $tr.find("td.lastpost").first().text()
    );

    // Replies: Zahl in einer der folgenden Zellen. Wir nehmen den ersten rein-numerischen Span.
    let replies: number | undefined;
    $tr.find("td span").each((_, s) => {
      if (replies != null) return;
      const n = parseInt(normalizeText($(s).text()), 10);
      if (!Number.isNaN(n)) replies = n;
    });

    discussions.push({
      discussion_id: discussionId,
      title: truncate(itemTitle, 300) || "(ohne Titel)",
      author: author || undefined,
      last_post: lastPost || undefined,
      replies,
      url,
    });
  });

  const content: ForumContent = {
    description,
    discussions,
    total_on_page: total,
    has_more: offset + discussions.length < total,
    offset,
    limit,
  };

  // Degraded, wenn wir zwar HTML hatten, aber keine Diskussions-Zeilen finden konnten —
  // dann ist entweder der Selektor gebrochen oder das Forum wirklich leer. In beiden
  // Fällen liefern wir zusätzlich raw_text, damit der KI-Client wenigstens etwas sieht.
  const parser_degraded = total === 0 ? true : undefined;

  return { title, content, parser_degraded };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function toIntOrUndef(v: string | undefined | null): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

function emptyContent(limit: number, offset: number): ForumContent {
  return { discussions: [], total_on_page: 0, has_more: false, offset, limit };
}
