/**
 * Lokaler Express-Server für die Transkriptions-Web-UI (nur 127.0.0.1).
 * Stellt REST + SSE bereit und serviert im Prod das gebaute React-Frontend
 * (webapp/dist). Liest Credentials selbst aus der macOS-Keychain.
 *
 * Sicherheit: nur localhost, kein Auth (Einzelnutzer). Passwörter/Cookies
 * landen nie in Responses oder Logs.
 */

import express, { type Request, type Response } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { LearnwebSession } from "../learnweb/session";
import {
  AVAILABLE_MODELS,
  MLX_MODEL,
  checkSetup,
  downloadModel,
  isMlxWhisperReady,
  modelPath,
  readCredentials,
  writeCredentials,
} from "../transcription/setup";
import {
  collectRecordings,
  DEFAULT_MODEL,
  MANIFEST_PATH,
  type PendingRecording,
} from "../transcription/pipeline";
import { isDone, loadManifest } from "../transcription/manifest";
import { JobManager } from "./jobs";

const HOST = "127.0.0.1";
const WEBAPP_DIST = path.resolve("webapp/dist");

const jobs = new JobManager();

// ── SSE ────────────────────────────────────────────────────────────────────
const sseClients = new Set<Response>();
function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      /* Client weg */
    }
  }
}
jobs.on("update", (state) => broadcast("job", state));

// ── Session (lazy, Credentials aus Keychain) ────────────────────────────────
let session: LearnwebSession | null = null;
async function ensureSession(): Promise<LearnwebSession | null> {
  if (session) return session;
  const creds = await readCredentials();
  if (!creds) return null;
  session = LearnwebSession.initWithCredentials(creds.url, creds.username, creds.password);
  return session;
}

// ── Aufzeichnungs-Cache (collectRecordings ist teuer) ───────────────────────
let recordingsCache: PendingRecording[] | null = null;
async function getRecordings(refresh: boolean): Promise<PendingRecording[]> {
  if (recordingsCache && !refresh) return recordingsCache;
  const s = await ensureSession();
  if (!s) throw new Error("not_configured");
  recordingsCache = await collectRecordings(s, {
    onCourse: (courseId, name, index, total) => broadcast("scan", { courseId, name, index, total }),
  });
  broadcast("scan", { done: true });
  return recordingsCache;
}

export function createApp() {
  const app = express();
  app.use(express.json());

  // Status / Setup ----------------------------------------------------------
  app.get("/api/status", async (_req, res) => {
    res.json(await checkSetup());
  });

  app.post("/api/setup/credentials", async (req, res) => {
    const { url, username, password } = req.body ?? {};
    if (!url || !username || !password) {
      res.status(400).json({ error: "url, username, password erforderlich" });
      return;
    }
    try {
      await writeCredentials({ url, username, password });
      session = null; // erzwingt Re-Init mit neuen Credentials
      recordingsCache = null;
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Fehler" });
    }
  });

  app.get("/api/models", (_req, res) => {
    res.json({ available: AVAILABLE_MODELS });
  });

  app.post("/api/setup/model", (req, res) => {
    const name = (req.body?.name as string) ?? "large-v3-turbo";
    res.json({ started: true, name });
    downloadModel(name, (pct, received, total) => broadcast("model", { name, pct, received, total }))
      .then(() => broadcast("model", { name, pct: 100, done: true }))
      .catch((err) => broadcast("model", { name, error: err instanceof Error ? err.message : "Fehler" }));
  });

  // Login-Test (on demand) --------------------------------------------------
  app.post("/api/login-test", async (_req, res) => {
    try {
      const s = await ensureSession();
      if (!s) {
        res.json({ ok: false, reason: "not_configured" });
        return;
      }
      const resp = await s.get("/my/index.php");
      const ok = /page-my-index|Dashboard/.test(resp.data);
      res.json({ ok });
    } catch {
      res.json({ ok: false, reason: "error" });
    }
  });

  // Aufzeichnungen ----------------------------------------------------------
  app.get("/api/recordings", async (req, res) => {
    try {
      const refresh = req.query.refresh === "1";
      const recs = await getRecordings(refresh);
      const manifest = await loadManifest(MANIFEST_PATH);
      const byCourse = new Map<number, { courseId: number; courseName: string; items: unknown[] }>();
      for (const r of recs) {
        if (!byCourse.has(r.courseId)) {
          byCourse.set(r.courseId, { courseId: r.courseId, courseName: r.courseName, items: [] });
        }
        byCourse.get(r.courseId)!.items.push({
          key: r.key,
          cmid: r.cmid,
          title: r.source.title,
          kind: r.source.kind,
          durationSeconds: r.source.durationSeconds,
          status: manifest.entries[r.key]?.status ?? "new",
        });
      }
      res.json({ courses: [...byCourse.values()] });
    } catch (err) {
      if (err instanceof Error && err.message === "not_configured") {
        res.status(409).json({ error: "not_configured" });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : "Fehler" });
    }
  });

  // Jobs --------------------------------------------------------------------
  app.post("/api/jobs", async (req, res) => {
    try {
      const s = await ensureSession();
      if (!s) {
        res.status(409).json({ error: "not_configured" });
        return;
      }
      const body = req.body ?? {};
      const all = await getRecordings(false);
      let selected: PendingRecording[];
      if (Array.isArray(body.keys) && body.keys.length > 0) {
        // Explizite Auswahl: genau diese verarbeiten (auch bereits erledigte).
        const wanted = new Set<string>(body.keys);
        selected = all.filter((r) => wanted.has(r.key));
      } else {
        // Kurs/alles: nur neue (nicht erledigte).
        const manifest = await loadManifest(MANIFEST_PATH);
        let pool = all;
        if (body.course) pool = pool.filter((r) => r.courseId === Number(body.course));
        selected = pool.filter((r) => !isDone(manifest, r.key));
      }
      if (selected.length === 0) {
        res.status(400).json({ error: "Keine passenden Aufzeichnungen ausgewählt." });
        return;
      }
      const requestedModel = body.options?.model as string | undefined;
      const useMlx = !requestedModel && (await isMlxWhisperReady());
      const backend = useMlx ? "mlx" : "whisper.cpp";
      const model = useMlx ? MLX_MODEL : requestedModel ? modelPath(requestedModel) : DEFAULT_MODEL;
      if (backend === "whisper.cpp" && !existsSync(model)) {
        res.status(400).json({ error: `Modell fehlt: ${path.basename(model)}. Bitte unter Setup herunterladen.` });
        return;
      }
      const job = jobs.start(s, selected, {
        backend,
        model,
        language: body.options?.language || "de",
        keepVideo: Boolean(body.options?.keepVideo),
      });
      res.json(job);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : "Fehler" });
    }
  });

  app.get("/api/jobs/current", (_req, res) => {
    res.json(jobs.getCurrent());
  });

  app.post("/api/jobs/cancel", (_req, res) => {
    jobs.cancel();
    res.json({ ok: true });
  });

  // Transkripte -------------------------------------------------------------
  app.get("/api/transcripts", async (_req, res) => {
    const manifest = await loadManifest(MANIFEST_PATH);
    res.json({ entries: Object.values(manifest.entries) });
  });

  app.get("/api/transcripts/:key", async (req, res) => {
    const manifest = await loadManifest(MANIFEST_PATH);
    const entry = manifest.entries[req.params.key];
    if (!entry?.transcript_path) {
      res.status(404).json({ error: "nicht gefunden" });
      return;
    }
    // Pfad-Traversal-Schutz: nur unter transcripts/.
    const abs = path.resolve(entry.transcript_path);
    if (!abs.startsWith(path.resolve("transcripts") + path.sep)) {
      res.status(400).json({ error: "ungültiger Pfad" });
      return;
    }
    try {
      const markdown = await readFile(abs, "utf8");
      res.json({ key: req.params.key, title: entry.title, markdown });
    } catch {
      res.status(404).json({ error: "Datei fehlt" });
    }
  });

  // SSE ---------------------------------------------------------------------
  app.get("/api/events", (req: Request, res: Response) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    res.write(`event: hello\ndata: {}\n\n`);
    sseClients.add(res);
    const current = jobs.getCurrent();
    if (current) res.write(`event: job\ndata: ${JSON.stringify(current)}\n\n`);
    req.on("close", () => sseClients.delete(res));
  });

  // Statisches Frontend (Prod) + SPA-Fallback -------------------------------
  if (existsSync(WEBAPP_DIST)) {
    app.use(express.static(WEBAPP_DIST));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(WEBAPP_DIST, "index.html")));
  }

  return app;
}

export function startServer(port = Number(process.env.UI_PORT || 4317)): Promise<number> {
  return new Promise((resolve) => {
    const app = createApp();
    app.listen(port, HOST, () => {
      console.log(`Transkriptions-UI läuft auf http://${HOST}:${port}`);
      resolve(port);
    });
  });
}

if (require.main === module) {
  void startServer();
}
