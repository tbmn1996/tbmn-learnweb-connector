import { useEffect, useState } from "react";
import { marked } from "marked";
import { api, type JobState, type ManifestEntry } from "../api";

export function TranscriptsView({ job }: { job: JobState | null }) {
  const [entries, setEntries] = useState<ManifestEntry[]>([]);
  const [active, setActive] = useState<{ title: string; html: string } | null>(null);
  const [err, setErr] = useState("");

  async function load() {
    try {
      const r = await api.transcripts();
      setEntries(r.entries.filter((e) => e.status === "done"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  // Bei neuen fertigen Transkripten automatisch nachladen.
  const doneCount = job?.items.filter((i) => i.status === "done").length ?? 0;
  useEffect(() => {
    void load();
  }, [doneCount, job?.running]);

  async function open(e: ManifestEntry) {
    setErr("");
    try {
      const t = await api.transcript(e.key);
      const html = await marked.parse(t.markdown);
      setActive({ title: t.title, html });
    } catch (er) {
      setErr(er instanceof Error ? er.message : String(er));
    }
  }

  if (active) {
    return (
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{active.title}</h2>
          <button className="btn secondary small" onClick={() => setActive(null)}>
            ← Zurück
          </button>
        </div>
        <div
          className="transcript-body"
          style={{ marginTop: 12 }}
          dangerouslySetInnerHTML={{ __html: active.html }}
        />
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>
          Transkripte <span className="muted small">({entries.length})</span>
        </h2>
        <button className="btn secondary small" onClick={() => void load()}>
          Aktualisieren
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="empty">Noch keine Transkripte.</div>
      ) : (
        <table style={{ marginTop: 12 }}>
          <tbody>
            {entries.map((e) => (
              <tr key={e.key}>
                <td>{e.title}</td>
                <td className="muted small">{e.course_name}</td>
                <td className="actions">
                  <button className="btn small" onClick={() => void open(e)}>
                    Ansehen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {err && <div className="toast err">{err}</div>}
    </div>
  );
}
