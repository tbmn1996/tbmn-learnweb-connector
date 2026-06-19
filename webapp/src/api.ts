// API-Client + Typen für das lokale Transkriptions-Backend.

export interface SetupStatus {
  tools: { mlx: boolean; whisper: boolean; ytdlp: boolean; ffmpeg: boolean };
  models: {
    mlx: { model: string; cached: boolean };
    dir: string;
    installed: { file: string; sizeMb: number }[];
    available: { name: string; file: string; sizeMb: number; note: string }[];
  };
  credentials: { present: boolean };
}

export interface RecordingItem {
  key: string;
  cmid: number;
  title: string;
  kind: string;
  durationSeconds?: number;
  status: "new" | "done" | "failed";
}

export interface CourseGroup {
  courseId: number;
  courseName: string;
  items: RecordingItem[];
}

export interface JobItem {
  key: string;
  cmid: number;
  title: string;
  courseId: number;
  courseName: string;
  kind: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  phase?: string;
  pct?: number;
  error?: string;
  transcriptPath?: string;
}

export interface JobState {
  id: string;
  createdAt: string;
  running: boolean;
  cancelled: boolean;
  activeIndex: number;
  items: JobItem[];
  options: { backend: "mlx" | "whisper.cpp"; model: string; language: string; keepVideo: boolean };
}

export interface ManifestEntry {
  key: string;
  title: string;
  course_name: string;
  status: string;
  transcript_path?: string;
  duration_seconds?: number;
  system?: string;
}

export interface JobOptionsInput {
  language?: string;
  keepVideo?: boolean;
  model?: string;
}

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error || `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

async function jpost<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.error || `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export const api = {
  status: () => jget<SetupStatus>("/status"),
  saveCredentials: (url: string, username: string, password: string) =>
    jpost<{ ok: true }>("/setup/credentials", { url, username, password }),
  downloadModel: (name: string) => jpost<{ started: true }>("/setup/model", { name }),
  loginTest: () => jpost<{ ok: boolean; reason?: string }>("/login-test"),
  recordings: (refresh = false) => jget<{ courses: CourseGroup[] }>(`/recordings${refresh ? "?refresh=1" : ""}`),
  startJob: (payload: { keys?: string[]; course?: number; options?: JobOptionsInput }) =>
    jpost<JobState>("/jobs", payload),
  cancelJob: () => jpost<{ ok: true }>("/jobs/cancel"),
  currentJob: () => jget<JobState | null>("/jobs/current"),
  transcripts: () => jget<{ entries: ManifestEntry[] }>("/transcripts"),
  transcript: (key: string) => jget<{ key: string; title: string; markdown: string }>(`/transcripts/${encodeURIComponent(key)}`),
};

export interface ScanEvent {
  courseId?: number;
  name?: string;
  index?: number;
  total?: number;
  done?: boolean;
}
export interface ModelEvent {
  name: string;
  pct?: number;
  received?: number;
  total?: number;
  done?: boolean;
  error?: string;
}

export function openEvents(handlers: {
  onJob?: (s: JobState) => void;
  onScan?: (e: ScanEvent) => void;
  onModel?: (e: ModelEvent) => void;
}): EventSource {
  const es = new EventSource("/api/events");
  if (handlers.onJob) es.addEventListener("job", (e) => handlers.onJob!(JSON.parse((e as MessageEvent).data)));
  if (handlers.onScan) es.addEventListener("scan", (e) => handlers.onScan!(JSON.parse((e as MessageEvent).data)));
  if (handlers.onModel) es.addEventListener("model", (e) => handlers.onModel!(JSON.parse((e as MessageEvent).data)));
  return es;
}
