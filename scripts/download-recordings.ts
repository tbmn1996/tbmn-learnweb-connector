/**
 * Lädt Opencast-Vorlesungsaufzeichnungen eines Kurses gestreamt auf die
 * lokale Festplatte herunter.
 *
 * Nutzt die Discovery-Logik aus `src/learnweb/parsers/recordings.ts`
 * (authentifiziert über LearnwebSession) — der eigentliche Video-Download
 * läuft aber über einen ungebundenen HTTP-Stream, da die mp4-URLs auf einem
 * anderen, öffentlich erreichbaren Host (ele-cdn.*) liegen und nicht über
 * session.downloadFile() (In-Memory-Buffer, 25-MB-Cap) laufen können.
 *
 * Aufruf: npx tsx scripts/download-recordings.ts --course <id> --out-dir <pfad> [--overwrite]
 * Empfohlen: scripts/download-recordings-keychain.sh (liest Credentials aus der Keychain).
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import axios from "axios";
import { LearnwebSession } from "../src/learnweb/session";
import { discoverCourseRecordings, type OpencastRecording } from "../src/learnweb/parsers/recordings";
import { buildRecordingFilename } from "../src/learnweb/filenames";

interface CliArgs {
  course: number;
  outDir: string;
  overwrite: boolean;
  limit?: number;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      course: { type: "string" },
      "out-dir": { type: "string" },
      overwrite: { type: "boolean", default: false },
      limit: { type: "string" },
    },
  });

  const courseRaw = values.course as string | undefined;
  const outDirRaw = values["out-dir"] as string | undefined;
  const limitRaw = values.limit as string | undefined;

  if (!courseRaw) {
    throw new Error("--course <id> ist erforderlich.");
  }
  if (!outDirRaw) {
    throw new Error("--out-dir <pfad> ist erforderlich.");
  }

  const course = Number.parseInt(courseRaw, 10);
  if (!Number.isInteger(course) || course <= 0) {
    throw new Error(`--course muss eine positive Ganzzahl sein, erhalten: "${courseRaw}".`);
  }

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`--limit muss eine positive Ganzzahl sein, erhalten: "${limitRaw}".`);
    }
  }

  return {
    course,
    outDir: path.resolve(outDirRaw),
    overwrite: Boolean(values.overwrite),
    limit,
  };
}

// Offensichtliche Fehlerseiten (HTML statt Video) ablehnen, bevor sie als
// scheinbar vollständige .mp4-Datei liegen bleiben.
const REJECT_CONTENT_TYPE_RE = /^text\/html/i;

async function downloadRecording(
  mediaUrl: string,
  destPath: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const partPath = `${destPath}.part`;

  const response = await axios.get(mediaUrl, {
    responseType: "stream",
    timeout: 60_000,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: `HTTP ${response.status}` };
  }
  const contentType = String(response.headers["content-type"] ?? "");
  if (REJECT_CONTENT_TYPE_RE.test(contentType)) {
    return { ok: false, reason: `unerwarteter Content-Type "${contentType}" (sieht nach Fehlerseite aus)` };
  }

  await new Promise<void>((resolve, reject) => {
    const writer = createWriteStream(partPath);
    response.data.on("error", reject);
    writer.on("error", reject);
    writer.on("finish", resolve);
    response.data.pipe(writer);
  });

  await rename(partPath, destPath);
  return { ok: true };
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  await mkdir(args.outDir, { recursive: true });

  const session = LearnwebSession.getInstance();
  const result = await discoverCourseRecordings(session, args.course);

  if ("error" in result) {
    console.error(`Fehler: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Kurs "${result.course_name}" (${result.course_id}): ${result.opencast_activities_found} Opencast-Aktivität(en), ${result.recordings.length} Aufzeichnung(en) gefunden.`
  );
  if (result.parser_degraded) {
    console.warn(
      "Warnung: mindestens eine Opencast-Aktivität konnte nicht vollständig verarbeitet werden — Ergebnis ist möglicherweise unvollständig."
    );
  }
  if (result.recordings.length === 0) {
    console.log("Keine Aufzeichnungen gefunden.");
    return;
  }

  const recordingsToProcess = args.limit
    ? result.recordings.slice(0, args.limit)
    : result.recordings;
  if (args.limit) {
    console.log(`--limit gesetzt: verarbeite nur die ersten ${recordingsToProcess.length} von ${result.recordings.length} Aufzeichnung(en).`);
  }

  const usedNames = new Set<string>();
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const recording of recordingsToProcess as OpencastRecording[]) {
    const filename = buildRecordingFilename(recording, usedNames);
    usedNames.add(filename);
    const destPath = path.join(args.outDir, filename);

    if (!args.overwrite && (await fileExists(destPath))) {
      console.log(`Übersprungen (existiert bereits): ${filename}`);
      skipped++;
      continue;
    }

    try {
      const outcome = await downloadRecording(recording.media_url, destPath);
      if (outcome.ok) {
        console.log(`Heruntergeladen: ${filename}`);
        succeeded++;
      } else {
        console.error(`Fehlgeschlagen: ${filename} (${outcome.reason})`);
        await rm(`${destPath}.part`, { force: true });
        failed++;
      }
    } catch (err) {
      console.error(`Fehlgeschlagen: ${filename} (${err instanceof Error ? err.message : String(err)})`);
      await rm(`${destPath}.part`, { force: true });
      failed++;
    }
  }

  console.log(`\nZusammenfassung: ${succeeded} erfolgreich, ${skipped} übersprungen, ${failed} fehlgeschlagen.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
