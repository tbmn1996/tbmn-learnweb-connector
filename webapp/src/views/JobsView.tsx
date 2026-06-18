import { api, type JobItem, type JobState } from "../api";

const PHASE_LABEL: Record<string, string> = {
  download: "Download",
  audio: "Audio",
  transcribe: "Transkribieren",
  markdown: "Markdown",
};
const STATUS_LABEL: Record<string, string> = {
  queued: "wartet",
  running: "läuft",
  done: "erledigt",
  failed: "Fehler",
  cancelled: "abgebrochen",
};

export function JobsView({ job }: { job: JobState | null }) {
  if (!job) {
    return (
      <div className="card">
        <div className="empty">Noch kein Job gestartet. Wähle unter „Aufzeichnungen" etwas aus.</div>
      </div>
    );
  }
  const done = job.items.filter((i) => i.status === "done").length;
  const failed = job.items.filter((i) => i.status === "failed").length;
  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>
          {job.running ? "Job läuft" : "Job abgeschlossen"}{" "}
          <span className="muted small">
            {done}/{job.items.length} fertig{failed ? `, ${failed} fehlgeschlagen` : ""}
          </span>
        </h2>
        {job.running && (
          <button className="btn danger small" onClick={() => void api.cancelJob()}>
            Abbrechen
          </button>
        )}
      </div>
      <table style={{ marginTop: 12 }}>
        <tbody>
          {job.items.map((i) => (
            <JobRow key={i.key} item={i} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobRow({ item }: { item: JobItem }) {
  const showBar = item.status === "running" && (item.phase === "download" || item.phase === "transcribe");
  return (
    <tr>
      <td>
        <div>{item.title}</div>
        <div className="muted small">{item.courseName}</div>
      </td>
      <td style={{ width: 120 }} className="muted small">
        {item.status === "running" ? PHASE_LABEL[item.phase ?? ""] ?? "…" : ""}
      </td>
      <td style={{ width: 220 }}>
        {showBar ? (
          <div className="progress">
            <div style={{ width: `${item.pct ?? 0}%` }} />
          </div>
        ) : item.error ? (
          <span className="small" style={{ color: "var(--red)" }}>
            {item.error}
          </span>
        ) : null}
      </td>
      <td style={{ width: 110 }}>
        <span className={`badge ${item.status}`}>{STATUS_LABEL[item.status] ?? item.status}</span>
      </td>
    </tr>
  );
}
