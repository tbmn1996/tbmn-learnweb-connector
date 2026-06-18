/**
 * Lädt eine Aufzeichnung über yt-dlp herunter — authentifiziert via einer aus
 * der LearnwebSession exportierten Cookie-Datei. yt-dlp deckt direkte mp4
 * (pluginfile.php) und HLS/Opencast/externe Player gleichermaßen ab und streamt
 * zu Disk (umgeht so den RAM-Cap von session.downloadFile).
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { LearnwebSession } from "../learnweb/session";
import { ensureSuccess, runCommand, type CommandRunner } from "./run";

// Muss dem User-Agent der Session entsprechen (Anti-Bot-Konsistenz).
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const YTDLP_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 h für große Aufzeichnungen.

export interface DownloadOptions {
  /** Medien-/Stream-URL (mp4, m3u8, externer Player …). */
  url: string;
  /** Zielverzeichnis (wird angelegt). */
  outDir: string;
  /** Basisname der Ausgabedatei ohne Endung (z. B. "<cmid>"). */
  baseName: string;
  /** Nur den Audio-Stream laden, wenn vorhanden (spart Bandbreite). Default true. */
  audioOnly?: boolean;
  /** Vorab exportierte Cookie-Datei; sonst wird eine temporäre erzeugt + gelöscht. */
  cookieFile?: string;
  /** Live-Fortschritt (Default: nach stderr). */
  onProgress?: (chunk: string) => void;
  /** Abbruch. */
  signal?: AbortSignal;
}

/** Sucht die heruntergeladene Datei (größte `<baseName>.*`, ohne Hilfsdateien). */
async function findDownloadedFile(outDir: string, baseName: string): Promise<string | null> {
  const entries = await readdir(outDir);
  const candidates = entries.filter(
    (e) => e.startsWith(`${baseName}.`) && !e.endsWith(".part") && !e.endsWith(".cookies.txt")
  );
  let best: { file: string; size: number } | null = null;
  for (const file of candidates) {
    const s = await stat(path.join(outDir, file));
    if (s.isFile() && (!best || s.size > best.size)) best = { file, size: s.size };
  }
  return best ? path.join(outDir, best.file) : null;
}

/**
 * Führt yt-dlp aus und gibt den Pfad der heruntergeladenen Datei zurück.
 * Wirft bei Nicht-Null-Exit oder wenn keine Datei gefunden wurde.
 */
export async function downloadWithYtDlp(
  session: LearnwebSession,
  opts: DownloadOptions,
  run: CommandRunner = runCommand
): Promise<string> {
  await mkdir(opts.outDir, { recursive: true });

  const ownCookieFile = !opts.cookieFile;
  const cookieFile = opts.cookieFile ?? path.join(opts.outDir, `${opts.baseName}.cookies.txt`);
  if (ownCookieFile) {
    await session.exportCookieFile(cookieFile);
  }

  const outTemplate = path.join(opts.outDir, `${opts.baseName}.%(ext)s`);
  const format = opts.audioOnly === false ? "best" : "bestaudio/best";
  const onProgress = opts.onProgress ?? ((c: string) => process.stderr.write(c));

  try {
    ensureSuccess(
      "yt-dlp",
      await run(
        "yt-dlp",
        [
          "--no-playlist",
          "--no-part",
          "--cookies",
          cookieFile,
          "--user-agent",
          USER_AGENT,
          "-f",
          format,
          "-o",
          outTemplate,
          opts.url,
        ],
        { timeoutMs: YTDLP_TIMEOUT_MS, onProgress, signal: opts.signal }
      )
    );
  } finally {
    if (ownCookieFile) {
      // Cookie-Datei enthält das Session-Token → sofort entfernen.
      await rm(cookieFile, { force: true });
    }
  }

  const file = await findDownloadedFile(opts.outDir, opts.baseName);
  if (!file) {
    throw new Error(`yt-dlp lieferte keine Datei für ${opts.baseName} in ${opts.outDir}`);
  }
  return file;
}
