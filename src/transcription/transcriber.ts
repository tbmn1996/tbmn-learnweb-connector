/**
 * Audio-Extraktion (ffmpeg) + lokale Transkription (whisper.cpp / whisper-cli).
 * Alle Prozessaufrufe laufen über den injizierbaren CommandRunner → testbar.
 */

import { readFile } from "node:fs/promises";
import { ensureSuccess, runCommand, type CommandRunner } from "./run";
import type { TranscriptSegment } from "./markdown";

const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — Extraktion ist schnell, aber Puffer.
const WHISPER_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 h — lange Vorlesungen + großes Modell.

export interface TranscribeOptions {
  /** Pfad zum ggml-Modell (z. B. models/ggml-large-v3-turbo.bin). */
  model: string;
  /** Sprachcode für Whisper. Default "de". */
  language?: string;
  /** Anzahl Threads (Default: Whisper-Standard). */
  threads?: number;
  /** Gesamtdauer in Sekunden — für die Fortschrittsberechnung. */
  durationSeconds?: number;
  /** Live-Fortschritt 0–100 (nur aktiv, wenn gesetzt; deaktiviert -np). */
  onProgress?: (pct: number) => void;
  /** Abbruch. */
  signal?: AbortSignal;
}

/** Liest die Mediendauer in Sekunden via ffprobe; undefined bei Fehler. */
export async function probeDurationSeconds(
  input: string,
  run: CommandRunner = runCommand
): Promise<number | undefined> {
  try {
    const r = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      input,
    ]);
    const v = Number.parseFloat(r.stdout.trim());
    return Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extrahiert 16-kHz-Mono-PCM-WAV (das von Whisper erwartete Format) aus einer
 * beliebigen Medienquelle (Video oder Audio).
 */
export async function extractAudio(
  input: string,
  outputWav: string,
  run: CommandRunner = runCommand,
  signal?: AbortSignal
): Promise<string> {
  ensureSuccess(
    "ffmpeg",
    await run(
      "ffmpeg",
      ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputWav],
      { timeoutMs: FFMPEG_TIMEOUT_MS, signal }
    )
  );
  return outputWav;
}

/** Wandelt whisper.cpp-JSON (-oj) in flache Segmente um. Exportiert für Tests. */
export function parseWhisperJson(json: unknown): TranscriptSegment[] {
  const transcription =
    json && typeof json === "object" ? (json as { transcription?: unknown }).transcription : undefined;
  if (!Array.isArray(transcription)) return [];
  return transcription
    .map((raw): TranscriptSegment => {
      const seg = (raw ?? {}) as { offsets?: { from?: number; to?: number }; text?: unknown };
      return {
        fromMs: typeof seg.offsets?.from === "number" ? seg.offsets.from : 0,
        toMs: typeof seg.offsets?.to === "number" ? seg.offsets.to : 0,
        text: String(seg.text ?? "").trim(),
      };
    })
    .filter((s) => s.text.length > 0);
}

/** Baut aus whisper-cli-Ausgabe (`[hh:mm:ss.xxx --> ...]`) einen %-Fortschritt. */
function makeWhisperProgressHandler(
  durationSeconds: number,
  onProgress: (pct: number) => void
): (chunk: string) => void {
  return (chunk: string) => {
    let lastSec = -1;
    for (const m of chunk.matchAll(/\[(\d{2}):(\d{2}):(\d{2})\.\d{3}\s*-->/g)) {
      lastSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
    if (lastSec >= 0 && durationSeconds > 0) {
      onProgress(Math.min(100, Math.round((lastSec / durationSeconds) * 100)));
    }
  };
}

/**
 * Transkribiert eine WAV-Datei mit whisper-cli und liefert Segmente.
 * whisper-cli schreibt das JSON nach `<wav ohne .wav>.json` (-oj/-of).
 */
export async function transcribeWav(
  wavPath: string,
  opts: TranscribeOptions,
  run: CommandRunner = runCommand
): Promise<TranscriptSegment[]> {
  const outPrefix = wavPath.replace(/\.wav$/i, "");
  const args = ["-m", opts.model, "-l", opts.language ?? "de", "-f", wavPath, "-oj", "-of", outPrefix];
  // Ohne Live-Fortschritt unterdrücken wir die Prints (-np). Mit onProgress
  // brauchen wir die Segment-Zeilen für die %-Berechnung.
  const withProgress = Boolean(opts.onProgress && opts.durationSeconds);
  if (!withProgress) args.push("-np");
  if (opts.threads && opts.threads > 0) args.push("-t", String(opts.threads));

  const onProgress = withProgress
    ? makeWhisperProgressHandler(opts.durationSeconds!, opts.onProgress!)
    : undefined;

  ensureSuccess(
    "whisper-cli",
    await run("whisper-cli", args, { timeoutMs: WHISPER_TIMEOUT_MS, onProgress, signal: opts.signal })
  );
  const json = JSON.parse(await readFile(`${outPrefix}.json`, "utf8")) as unknown;
  return parseWhisperJson(json);
}
