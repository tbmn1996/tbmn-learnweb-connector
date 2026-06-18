/**
 * Formatiert Whisper-Segmente als lesbares Markdown mit YAML-Frontmatter.
 * Reine Formatierung — kein IO, daher gut testbar.
 */

export interface TranscriptSegment {
  fromMs: number;
  toMs: number;
  text: string;
}

export interface TranscriptMeta {
  title: string;
  courseId: number;
  courseName: string;
  cmid: number;
  sourceUrl: string;
  system?: string;
  model: string;
  durationSeconds?: number;
  generatedAt?: string;
}

export interface MarkdownOptions {
  /** Zeitstempel-Marker pro Absatz voranstellen. */
  timestamps: boolean;
  /** Neuer Absatz, sobald er länger als so viele Sekunden würde. */
  paragraphSeconds: number;
}

const DEFAULT_OPTIONS: MarkdownOptions = { timestamps: true, paragraphSeconds: 30 };

/** Dateiname-/Ordner-tauglicher Slug; Umlaute werden transliteriert. */
export function slugify(input: string): string {
  const map: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };
  const replaced = input.toLowerCase().replace(/[äöüß]/g, (c) => map[c] ?? c);
  return (
    replaced
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function escapeYaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Gruppiert Segmente zu Absätzen, die jeweils ~paragraphSeconds lang sind. */
function groupParagraphs(
  segments: TranscriptSegment[],
  paragraphSeconds: number
): { startMs: number; text: string }[] {
  const paragraphs: { startMs: number; text: string }[] = [];
  let current: { startMs: number; parts: string[] } | null = null;

  for (const seg of segments) {
    if (!current) {
      current = { startMs: seg.fromMs, parts: [seg.text] };
      continue;
    }
    const wouldBeLength = seg.toMs - current.startMs;
    current.parts.push(seg.text);
    if (wouldBeLength >= paragraphSeconds * 1000) {
      paragraphs.push({ startMs: current.startMs, text: current.parts.join(" ") });
      current = null;
    }
  }
  if (current) paragraphs.push({ startMs: current.startMs, text: current.parts.join(" ") });
  return paragraphs;
}

export function buildTranscriptMarkdown(
  meta: TranscriptMeta,
  segments: TranscriptSegment[],
  options: Partial<MarkdownOptions> = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const generatedAt = meta.generatedAt ?? new Date().toISOString();

  const frontmatter = [
    "---",
    `title: ${escapeYaml(meta.title)}`,
    `course_id: ${meta.courseId}`,
    `course_name: ${escapeYaml(meta.courseName)}`,
    `cmid: ${meta.cmid}`,
    `source_url: ${escapeYaml(meta.sourceUrl)}`,
    ...(meta.system ? [`system: ${meta.system}`] : []),
    `model: ${escapeYaml(meta.model)}`,
    ...(meta.durationSeconds !== undefined
      ? [`duration_seconds: ${Math.round(meta.durationSeconds)}`]
      : []),
    `generated_at: ${generatedAt}`,
    "---",
    "",
  ];

  const body: string[] = [`# ${meta.title}`, ""];
  if (segments.length === 0) {
    body.push("_(Keine Transkriptionssegmente — Audio leer oder stumm.)_");
  } else {
    for (const p of groupParagraphs(segments, opts.paragraphSeconds)) {
      body.push(opts.timestamps ? `**[${formatTimestamp(p.startMs)}]** ${p.text}` : p.text);
      body.push("");
    }
  }

  return `${frontmatter.join("\n")}${body.join("\n")}\n`;
}
