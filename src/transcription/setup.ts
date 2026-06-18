/**
 * Setup-Funktionen für die Web-UI: Status-Checks (Tools, Modell, Credentials),
 * Lesen/Schreiben der Learnweb-Credentials in der macOS-Keychain und Download
 * von whisper.cpp-Modellen. Passwörter werden nur an /usr/bin/security
 * übergeben und niemals geloggt.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import https from "node:https";

const execFileAsync = promisify(execFile);
const SECURITY_BIN = "/usr/bin/security";
const KEYCHAIN_SERVICE = process.env.LEARNWEB_KEYCHAIN_SERVICE || "tbmn-learnweb-connector";
export const MODELS_DIR = path.resolve("models");
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export interface ModelInfo {
  name: string;
  file: string;
  sizeMb: number;
  note: string;
}

// Auswählbare whisper.cpp-Modelle (HuggingFace ggerganov/whisper.cpp).
export const AVAILABLE_MODELS: ModelInfo[] = [
  { name: "large-v3-turbo", file: "ggml-large-v3-turbo.bin", sizeMb: 1560, note: "beste Qualität, schnell auf Apple Silicon (empfohlen)" },
  { name: "medium", file: "ggml-medium.bin", sizeMb: 1530, note: "gute Qualität" },
  { name: "small", file: "ggml-small.bin", sizeMb: 488, note: "schneller, ordentlich" },
  { name: "base", file: "ggml-base.bin", sizeMb: 148, note: "sehr schnell, geringere Qualität" },
];

async function which(cmd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", [cmd]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function keychainHas(account: string): Promise<boolean> {
  try {
    await execFileAsync(SECURITY_BIN, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
    return true;
  } catch {
    return false;
  }
}

async function keychainRead(account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(SECURITY_BIN, [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
    ]);
    return stdout.replace(/\n$/, "");
  } catch {
    return null;
  }
}

export interface SetupStatus {
  tools: { whisper: boolean; ytdlp: boolean; ffmpeg: boolean };
  models: { dir: string; installed: { file: string; sizeMb: number }[]; available: ModelInfo[] };
  credentials: { present: boolean };
}

export async function checkSetup(): Promise<SetupStatus> {
  const [whisper, ytdlp, ffmpeg, hasUrl, hasUser, hasPass] = await Promise.all([
    which("whisper-cli"),
    which("yt-dlp"),
    which("ffmpeg"),
    keychainHas("LEARNWEB_URL"),
    keychainHas("LEARNWEB_USERNAME"),
    keychainHas("LEARNWEB_PASSWORD"),
  ]);

  const installed: { file: string; sizeMb: number }[] = [];
  if (existsSync(MODELS_DIR)) {
    for (const m of AVAILABLE_MODELS) {
      const p = path.join(MODELS_DIR, m.file);
      if (existsSync(p)) installed.push({ file: m.file, sizeMb: Math.round(statSync(p).size / 1e6) });
    }
  }

  return {
    tools: { whisper, ytdlp, ffmpeg },
    models: { dir: MODELS_DIR, installed, available: AVAILABLE_MODELS },
    credentials: { present: hasUrl && hasUser && hasPass },
  };
}

export interface Credentials {
  url: string;
  username: string;
  password: string;
}

/** Liest die Credentials aus der Keychain (für die Session-Initialisierung). */
export async function readCredentials(): Promise<Credentials | null> {
  const [url, username, password] = await Promise.all([
    keychainRead("LEARNWEB_URL"),
    keychainRead("LEARNWEB_USERNAME"),
    keychainRead("LEARNWEB_PASSWORD"),
  ]);
  if (!url || !username || !password) return null;
  return { url, username, password };
}

/** Schreibt die Credentials in die Keychain (Werte nie loggen). */
export async function writeCredentials(creds: Credentials): Promise<void> {
  const entries: [string, string][] = [
    ["LEARNWEB_URL", creds.url.trim()],
    ["LEARNWEB_USERNAME", creds.username.trim()],
    ["LEARNWEB_PASSWORD", creds.password],
  ];
  for (const [account, value] of entries) {
    try {
      await execFileAsync(SECURITY_BIN, [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        account,
        "-D",
        "application password",
        "-j",
        "TBMN LearnWeb Connector local MCP credential",
        "-T",
        SECURITY_BIN,
        "-w",
        value,
      ]);
    } catch {
      // macOS meldet beim Aktualisieren eines bestehenden Eintrags gelegentlich
      // einen ACL-Fehler (SecKeychainItemSetAccess), obwohl der Wert geschrieben
      // wurde. Wir verifizieren die Existenz unten und werfen nur dann.
    }
    if (!(await keychainHas(account))) {
      throw new Error(`Keychain-Eintrag '${account}' konnte nicht gesetzt werden.`);
    }
  }
}

export function modelPath(name: string): string {
  const m = AVAILABLE_MODELS.find((x) => x.name === name) ?? AVAILABLE_MODELS[0];
  return path.join(MODELS_DIR, m.file);
}

function fetchToFile(
  url: string,
  dest: string,
  onProgress: ((pct: number, received: number, total: number) => void) | undefined,
  signal: AbortSignal | undefined,
  depth = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (depth > 5) {
      reject(new Error("Zu viele Redirects beim Modell-Download."));
      return;
    }
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve(fetchToFile(res.headers.location, dest, onProgress, signal, depth + 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`Modell-Download fehlgeschlagen: HTTP ${status}`));
        return;
      }
      const total = Number(res.headers["content-length"] ?? 0);
      let received = 0;
      const out = createWriteStream(dest);
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (onProgress && total > 0) onProgress(Math.round((received / total) * 100), received, total);
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", reject);
    });
    req.on("error", reject);
    if (signal) {
      signal.addEventListener("abort", () => req.destroy(new Error("Modell-Download abgebrochen.")), { once: true });
    }
  });
}

/** Lädt ein ggml-Modell nach models/ (mit Fortschritt). Gibt den Zielpfad zurück. */
export async function downloadModel(
  name: string,
  onProgress?: (pct: number, received: number, total: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const m = AVAILABLE_MODELS.find((x) => x.name === name);
  if (!m) throw new Error(`Unbekanntes Modell: ${name}`);
  await mkdir(MODELS_DIR, { recursive: true });
  const dest = path.join(MODELS_DIR, m.file);
  const tmp = `${dest}.part`;
  await rm(tmp, { force: true });
  try {
    await fetchToFile(`${HF_BASE}/${m.file}`, tmp, onProgress, signal);
    await rm(dest, { force: true });
    await rename(tmp, dest);
    return dest;
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
