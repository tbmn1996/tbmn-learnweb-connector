/**
 * Dünner Wrapper um child_process.spawn für externe CLIs (yt-dlp, ffmpeg,
 * ffprobe, uvx/mlx_whisper, whisper-cli). Als injizierbarer `CommandRunner` gestaltet, damit
 * Downloader/Transcriber in Tests ohne echte Prozesse geprüft werden können.
 */

import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Wird mit jedem stdout/stderr-Chunk aufgerufen (z. B. für Live-Progress). */
  onProgress?: (chunk: string) => void;
  /** Bricht den Prozess ab (z. B. wenn ein Web-Job gecancelt wird). */
  signal?: AbortSignal;
}

export type CommandRunner = (file: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const runCommand: CommandRunner = (file, args, opts = {}) =>
  new Promise<RunResult>((resolve, reject) => {
    // signal/killSignal: Node killt den Prozess bei AbortSignal-Abbruch (SIGKILL,
    // damit hängende yt-dlp/whisper-Prozesse sicher beendet werden).
    const child = spawn(file, args, { cwd: opts.cwd, signal: opts.signal, killSignal: "SIGKILL" });
    let stdout = "";
    let stderr = "";

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${file} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      opts.onProgress?.(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts.onProgress?.(s);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/** Wirft, wenn der Prozess mit !=0 endete; gibt sonst das Ergebnis zurück. */
export function ensureSuccess(file: string, result: RunResult): RunResult {
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout).slice(-600);
    throw new Error(`${file} exited with code ${result.code}: ${tail}`);
  }
  return result;
}
