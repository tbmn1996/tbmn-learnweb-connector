/**
 * Wiederverwendbare Transkriptions-Pipeline: findet Aufzeichnungen in Kursen,
 * lädt sie herunter, transkribiert sie und schreibt Markdown. Wird sowohl vom
 * CLI (scripts/transcribe-recordings.ts) als auch vom Web-Backend genutzt.
 *
 * Fortschritt wird über einen optionalen onEvent-Callback gemeldet (CLI →
 * Konsole, Web → SSE).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LearnwebSession } from "../learnweb/session";
import { parseCourses, type LearnwebCourse } from "../learnweb/parsers/courses";
import { parseCourseOverview } from "../learnweb/parsers/overview";
import { extractRecordings, type RecordingSource } from "../learnweb/parsers/recordings";
import { downloadWithYtDlp } from "./downloader";
import { extractAudio, probeDurationSeconds, transcribeWav } from "./transcriber";
import { buildTranscriptMarkdown, slugify } from "./markdown";
import { recordingKey } from "./manifest";
import { runCommand } from "./run";

export const TRANSCRIPTS_DIR = path.resolve("transcripts");
export const CACHE_DIR = path.resolve(".cache/recordings");
export const MANIFEST_PATH = path.join(TRANSCRIPTS_DIR, "manifest.json");
export const DEFAULT_MODEL = path.resolve("models/ggml-large-v3-turbo.bin");

// Vorfilter: resource/folder nur prüfen, wenn der Name nach Aufzeichnung klingt
// (sonst würden hunderte PDF-Ressourcen unnötig abgefragt). opencast immer.
export const MEDIA_NAME_RE =
  /aufzeichn|recording|vorlesung|lecture|mitschnitt|video|audio|podcast|livestream|webinar|screencast/i;

export interface PendingRecording {
  /** Stabiler Schlüssel (cmid + Diskriminator) — auch Manifest-Key. */
  key: string;
  source: RecordingSource;
  cmid: number;
  courseId: number;
  courseName: string;
}

export type ProcessPhase = "download" | "audio" | "transcribe" | "markdown";
export interface ProcessEvent {
  phase: ProcessPhase;
  pct?: number;
}

export interface ProcessOptions {
  backend: "mlx" | "whisper.cpp";
  model: string;
  language: string;
  keepVideo: boolean;
  signal?: AbortSignal;
  onEvent?: (ev: ProcessEvent) => void;
}

export interface ProcessResult {
  transcriptPath: string;
  durationSeconds?: number;
  segments: number;
}

export function isRecordingCandidate(modtype: string, name: string, scanAllFiles: boolean): boolean {
  if (modtype === "opencast") return true;
  if (modtype === "resource" || modtype === "folder") {
    return scanAllFiles || MEDIA_NAME_RE.test(name);
  }
  return false;
}

export async function loadAllCourses(session: LearnwebSession): Promise<LearnwebCourse[]> {
  const byId = new Map<number, LearnwebCourse>();
  for (const p of ["/my/index.php", "/my/courses.php"]) {
    try {
      const resp = await session.get(p);
      if (resp.status >= 200 && resp.status < 300) {
        for (const c of parseCourses(resp.data, session.getBaseUrl())) byId.set(c.course_id, c);
      }
    } catch {
      /* Quelle übersprungen */
    }
  }
  return [...byId.values()];
}

export interface CollectOptions {
  course?: number;
  scanAllFiles?: boolean;
  onCourse?: (courseId: number, name: string, index: number, total: number) => void;
}

export async function collectRecordings(
  session: LearnwebSession,
  opts: CollectOptions = {}
): Promise<PendingRecording[]> {
  let courses = await loadAllCourses(session);
  if (opts.course) courses = courses.filter((c) => c.course_id === opts.course);

  const out: PendingRecording[] = [];
  let index = 0;
  for (const course of courses) {
    index++;
    opts.onCourse?.(course.course_id, course.name, index, courses.length);
    try {
      const resp = await session.get(`/course/view.php?id=${course.course_id}`);
      if (resp.status < 200 || resp.status >= 300) continue;
      const overview = parseCourseOverview(resp.data, course.course_id, session.getBaseUrl());
      // Dashboard-Name bevorzugen — overview.course_name ist auf den
      // Uni-Münster-Kursseiten oft nur das generische "Course".
      const courseName = course.name?.trim() || overview.course_name;
      for (const section of overview.sections) {
        for (const act of section.activities) {
          if (!isRecordingCandidate(act.modtype, act.name, opts.scanAllFiles ?? false)) continue;
          const recs = await extractRecordings(session, act);
          for (const source of recs) {
            out.push({
              key: recordingKey(act.cmid, source.discriminator),
              source,
              cmid: act.cmid,
              courseId: course.course_id,
              courseName,
            });
          }
        }
      }
    } catch {
      /* Kurs überspringen (Fehler wird vom Caller ggf. geloggt) */
    }
  }
  return out;
}

export async function processRecording(
  session: LearnwebSession,
  rec: PendingRecording,
  opts: ProcessOptions
): Promise<ProcessResult> {
  const { source } = rec;
  const cacheDir = path.join(CACHE_DIR, String(rec.courseId));
  const safeDisc = source.discriminator.replace(/[^a-z0-9]/gi, "").slice(-12) || "rec";
  const baseName = `${rec.cmid}-${safeDisc}`;

  opts.onEvent?.({ phase: "download" });
  const mediaPath = await downloadWithYtDlp(
    session,
    {
      url: source.mediaUrl,
      outDir: cacheDir,
      baseName,
      audioOnly: false, // direkte mp4/mp3 → ganze Datei; ffmpeg extrahiert das Audio
      signal: opts.signal,
      onProgress: (chunk) => {
        const m = chunk.match(/(\d+(?:\.\d+)?)%/);
        if (m) opts.onEvent?.({ phase: "download", pct: Math.round(Number.parseFloat(m[1])) });
      },
    }
  );

  opts.onEvent?.({ phase: "audio" });
  const wavPath = path.join(cacheDir, `${baseName}.wav`);
  await extractAudio(mediaPath, wavPath, runCommand, opts.signal);
  const durationSeconds = source.durationSeconds ?? (await probeDurationSeconds(mediaPath));

  opts.onEvent?.({ phase: "transcribe", pct: 0 });
  const segments = await transcribeWav(wavPath, {
    backend: opts.backend,
    model: opts.model,
    language: opts.language,
    durationSeconds,
    onProgress: (pct) => opts.onEvent?.({ phase: "transcribe", pct }),
    signal: opts.signal,
  });

  opts.onEvent?.({ phase: "markdown" });
  const md = buildTranscriptMarkdown(
    {
      title: source.title,
      courseId: rec.courseId,
      courseName: rec.courseName,
      cmid: rec.cmid,
      sourceUrl: source.mediaUrl,
      system: source.kind,
      model: path.basename(opts.model),
      durationSeconds,
    },
    segments
  );

  const outDir = path.join(TRANSCRIPTS_DIR, `${rec.courseId}-${slugify(rec.courseName)}`);
  await mkdir(outDir, { recursive: true });
  const transcriptPath = path.join(outDir, `${slugify(source.title)}.md`);
  await writeFile(transcriptPath, md, "utf8");

  // Aufräumen: WAV immer, Mediendatei optional behalten.
  await rm(wavPath, { force: true });
  if (!opts.keepVideo) await rm(mediaPath, { force: true });

  return { transcriptPath, durationSeconds, segments: segments.length };
}
