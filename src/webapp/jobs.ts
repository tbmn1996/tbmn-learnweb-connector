/**
 * In-Memory-Job-Manager für die Web-App: verarbeitet eine Liste von
 * Aufzeichnungen sequenziell (Session ist serialisiert, Whisper ist
 * ressourcenintensiv), meldet Fortschritt per EventEmitter und unterstützt
 * Abbruch via AbortController.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import type { LearnwebSession } from "../learnweb/session";
import { processRecording, type PendingRecording } from "../transcription/pipeline";
import { MANIFEST_PATH } from "../transcription/pipeline";
import {
  loadManifest,
  putEntry,
  saveManifest,
  type Manifest,
} from "../transcription/manifest";

export type JobItemStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobItem {
  key: string;
  cmid: number;
  title: string;
  courseId: number;
  courseName: string;
  kind: string;
  status: JobItemStatus;
  phase?: string;
  pct?: number;
  error?: string;
  transcriptPath?: string;
}

export interface JobOptions {
  model: string;
  language: string;
  keepVideo: boolean;
}

export interface JobState {
  id: string;
  createdAt: string;
  running: boolean;
  cancelled: boolean;
  activeIndex: number;
  items: JobItem[];
  options: JobOptions;
}

export class JobManager extends EventEmitter {
  private current: JobState | null = null;
  private abort: AbortController | null = null;

  getCurrent(): JobState | null {
    return this.current;
  }

  isBusy(): boolean {
    return Boolean(this.current?.running);
  }

  /** Startet einen Job. Wirft, wenn bereits einer läuft. */
  start(session: LearnwebSession, recordings: PendingRecording[], options: JobOptions): JobState {
    if (this.isBusy()) throw new Error("Es läuft bereits ein Job.");
    const job: JobState = {
      id: `job-${Date.now()}`,
      createdAt: new Date().toISOString(),
      running: true,
      cancelled: false,
      activeIndex: -1,
      items: recordings.map((r) => ({
        key: r.key,
        cmid: r.cmid,
        title: r.source.title,
        courseId: r.courseId,
        courseName: r.courseName,
        kind: r.source.kind,
        status: "queued" as JobItemStatus,
      })),
      options,
    };
    this.current = job;
    this.abort = new AbortController();
    void this.run(session, recordings, job, this.abort.signal);
    this.emitUpdate();
    return job;
  }

  cancel(): void {
    if (this.current?.running) {
      this.current.cancelled = true;
      this.abort?.abort();
      this.emitUpdate();
    }
  }

  private emitUpdate(): void {
    if (this.current) this.emit("update", this.current);
  }

  private async run(
    session: LearnwebSession,
    recordings: PendingRecording[],
    job: JobState,
    signal: AbortSignal
  ): Promise<void> {
    const manifest: Manifest = await loadManifest(MANIFEST_PATH);
    try {
      for (let i = 0; i < recordings.length; i++) {
        const rec = recordings[i];
        const item = job.items[i];
        if (signal.aborted) {
          item.status = "cancelled";
          continue;
        }
        job.activeIndex = i;
        item.status = "running";
        this.emitUpdate();

        try {
          const result = await processRecording(session, rec, {
            model: job.options.model,
            language: job.options.language,
            keepVideo: job.options.keepVideo,
            signal,
            onEvent: (ev) => {
              item.phase = ev.phase;
              item.pct = ev.pct;
              this.emitUpdate();
            },
          });
          item.status = "done";
          item.transcriptPath = path.relative(process.cwd(), result.transcriptPath);
          putEntry(manifest, {
            key: rec.key,
            course_id: rec.courseId,
            course_name: rec.courseName,
            cmid: rec.cmid,
            title: rec.source.title,
            source_url: rec.source.mediaUrl,
            system: rec.source.kind,
            status: "done",
            transcript_path: item.transcriptPath,
            duration_seconds: result.durationSeconds,
            model: path.basename(job.options.model),
            updated_at: new Date().toISOString(),
          });
          await saveManifest(MANIFEST_PATH, manifest);
        } catch (err) {
          if (signal.aborted) {
            item.status = "cancelled";
          } else {
            const message = err instanceof Error ? err.message : String(err);
            item.status = "failed";
            item.error = message;
            putEntry(manifest, {
              key: rec.key,
              course_id: rec.courseId,
              course_name: rec.courseName,
              cmid: rec.cmid,
              title: rec.source.title,
              source_url: rec.source.mediaUrl,
              system: rec.source.kind,
              status: "failed",
              model: path.basename(job.options.model),
              error: message,
              updated_at: new Date().toISOString(),
            });
            await saveManifest(MANIFEST_PATH, manifest);
          }
        }
        this.emitUpdate();
      }
    } finally {
      job.running = false;
      job.activeIndex = -1;
      this.abort = null;
      this.emitUpdate();
    }
  }
}
