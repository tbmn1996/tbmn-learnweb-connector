/**
 * Status-Manifest für inkrementelle Transkription. Hält pro Aufzeichnung fest,
 * ob sie bereits erfolgreich transkribiert wurde, damit wiederholte Läufe nur
 * Neues verarbeiten.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type RecordingStatus = "done" | "failed";

export interface ManifestEntry {
  key: string;
  course_id: number;
  course_name: string;
  cmid: number;
  title: string;
  source_url: string;
  system?: string;
  status: RecordingStatus;
  transcript_path?: string;
  duration_seconds?: number;
  model?: string;
  error?: string;
  updated_at: string;
}

export interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

/**
 * Eindeutiger Schlüssel pro Aufzeichnung: cmid + Hash eines Diskriminators
 * (Episoden-ID oder Medien-URL). So bleibt der Schlüssel stabil, auch wenn ein
 * Kursmodul mehrere Aufzeichnungen referenziert.
 */
export function recordingKey(cmid: number, discriminator: string): string {
  const h = createHash("sha1").update(discriminator).digest("hex").slice(0, 12);
  return `${cmid}-${h}`;
}

export async function loadManifest(filePath: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Manifest;
    if (parsed && parsed.version === 1 && parsed.entries) return parsed;
  } catch {
    /* keine oder kaputte Manifest-Datei → frisch starten */
  }
  return { version: 1, entries: {} };
}

export async function saveManifest(filePath: string, manifest: Manifest): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function isDone(manifest: Manifest, key: string): boolean {
  return manifest.entries[key]?.status === "done";
}

export function putEntry(manifest: Manifest, entry: ManifestEntry): void {
  manifest.entries[entry.key] = entry;
}
