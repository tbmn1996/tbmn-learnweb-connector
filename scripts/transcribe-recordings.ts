/**
 * CLI-Orchestrator: dünner Wrapper um src/transcription/pipeline.ts.
 * Findet Aufzeichnungen, transkribiert sie lokal mit MLX Whisper oder whisper.cpp und legt
 * Markdown ab. Inkrementell über transcripts/manifest.json.
 *
 * Aufruf (Credentials via Keychain-Wrapper):
 *   scripts/with-keychain-env.sh npx tsx scripts/transcribe-recordings.ts [optionen]
 *
 * Optionen:
 *   --course <id>      nur diesen Kurs (sonst: alle eingeschriebenen Kurse)
 *   --limit <n>        höchstens n neue Aufzeichnungen verarbeiten
 *   --dry-run          nur auflisten, was verarbeitet würde
 *   --model <pfad>     erzwingt ein lokales whisper.cpp-Modell
 *   --language <code>  Whisper-Sprache (Default: de)
 *   --keep-video       heruntergeladene Mediendatei nicht löschen
 *   --scan-all-files   auch resource/folder ohne Aufzeichnungs-Namen prüfen
 */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { LearnwebSession } from "../src/learnweb/session";
import {
  collectRecordings,
  processRecording,
  DEFAULT_MODEL,
  MANIFEST_PATH,
  TRANSCRIPTS_DIR,
  type ProcessEvent,
} from "../src/transcription/pipeline";
import { isDone, loadManifest, putEntry, saveManifest, type Manifest } from "../src/transcription/manifest";
import { isMlxWhisperReady, MLX_MODEL } from "../src/transcription/setup";

interface Args {
  course?: number;
  limit: number;
  dryRun: boolean;
  keepVideo: boolean;
  scanAllFiles: boolean;
  model?: string;
  language: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { limit: Infinity, dryRun: false, keepVideo: false, scanAllFiles: false, language: "de" };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--course": a.course = Number(argv[++i]); break;
      case "--limit": a.limit = Number(argv[++i]); break;
      case "--dry-run": a.dryRun = true; break;
      case "--keep-video": a.keepVideo = true; break;
      case "--scan-all-files": a.scanAllFiles = true; break;
      case "--model": a.model = argv[++i]; break;
      case "--language": a.language = argv[++i]; break;
      default: console.error(`Unbekanntes Argument: ${argv[i]}`);
    }
  }
  return a;
}

function logEvent(ev: ProcessEvent): void {
  switch (ev.phase) {
    case "download": if (ev.pct === undefined) console.log("  ↓ Download"); break;
    case "audio": console.log("  ♫ Audio extrahieren"); break;
    case "transcribe": if (ev.pct === 0) console.log("  ✎ Transkribieren"); break;
    case "markdown": break;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const useMlx = !args.model && (await isMlxWhisperReady());
  const backend = useMlx ? "mlx" : "whisper.cpp";
  const model = useMlx ? MLX_MODEL : args.model ?? DEFAULT_MODEL;
  if (backend === "whisper.cpp" && !existsSync(model)) {
    console.error(
      `Whisper-Modell nicht gefunden: ${model}\n` +
        `Bitte 'brew install whisper-cpp' und ein ggml-Modell nach models/ laden ` +
        `(siehe README), oder --model <pfad> angeben.`
    );
    process.exitCode = 1;
    return;
  }

  await mkdir(TRANSCRIPTS_DIR, { recursive: true });
  const session = LearnwebSession.getInstance();
  const manifest: Manifest = await loadManifest(MANIFEST_PATH);

  console.log("Kurse scannen …");
  const all = await collectRecordings(session, {
    course: args.course,
    scanAllFiles: args.scanAllFiles,
  });
  const pending = all.filter((r) => !isDone(manifest, r.key));
  const todo = Number.isFinite(args.limit) ? pending.slice(0, args.limit) : pending;

  console.log(`\nAufzeichnungen: ${all.length} gefunden, ${pending.length} neu, ${todo.length} werden verarbeitet.\n`);

  if (args.dryRun) {
    for (const r of todo) {
      console.log(`- [${r.source.kind}] Kurs ${r.courseId} cmid ${r.cmid}: ${r.source.title}`);
    }
    console.log("\n(--dry-run: nichts heruntergeladen/transkribiert.)");
    return;
  }

  let done = 0;
  let failed = 0;
  for (const rec of todo) {
    console.log(`\n▶ ${rec.courseName} — ${rec.source.title}`);
    try {
      const result = await processRecording(session, rec, {
        backend,
        model,
        language: args.language,
        keepVideo: args.keepVideo,
        onEvent: logEvent,
      });
      putEntry(manifest, {
        key: rec.key,
        course_id: rec.courseId,
        course_name: rec.courseName,
        cmid: rec.cmid,
        title: rec.source.title,
        source_url: rec.source.mediaUrl,
        system: rec.source.kind,
        status: "done",
        transcript_path: path.relative(process.cwd(), result.transcriptPath),
        duration_seconds: result.durationSeconds,
        model: path.basename(model),
        updated_at: new Date().toISOString(),
      });
      done++;
      console.log(`  ✓ ${result.segments} Segmente → ${path.relative(process.cwd(), result.transcriptPath)}`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      putEntry(manifest, {
        key: rec.key,
        course_id: rec.courseId,
        course_name: rec.courseName,
        cmid: rec.cmid,
        title: rec.source.title,
        source_url: rec.source.mediaUrl,
        system: rec.source.kind,
        status: "failed",
        model: path.basename(model),
        error: message,
        updated_at: new Date().toISOString(),
      });
      console.error(`  ✗ Fehlgeschlagen: ${message}`);
    }
    await saveManifest(MANIFEST_PATH, manifest);
  }

  console.log(`\nFertig: ${done} transkribiert, ${failed} fehlgeschlagen. Manifest: ${path.relative(process.cwd(), MANIFEST_PATH)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
