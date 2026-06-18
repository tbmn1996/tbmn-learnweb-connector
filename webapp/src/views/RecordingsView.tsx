import { useEffect, useState } from "react";
import { api, type CourseGroup, type JobState, type ScanEvent } from "../api";

function fmtDur(s?: number): string {
  if (!s) return "";
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
function statusLabel(s: string): string {
  return s === "done" ? "erledigt" : s === "failed" ? "fehlgeschlagen" : "neu";
}

export function RecordingsView({
  scan,
  job,
  onStarted,
}: {
  scan: ScanEvent | null;
  job: JobState | null;
  onStarted: () => void;
}) {
  const [courses, setCourses] = useState<CourseGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [language, setLanguage] = useState("de");
  const [keepVideo, setKeepVideo] = useState(false);
  const busy = Boolean(job?.running);

  async function load(refresh: boolean) {
    setLoading(true);
    setErr("");
    try {
      const r = await api.recordings(refresh);
      setCourses(r.courses);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m === "not_configured" ? "Bitte zuerst unter Setup die Zugangsdaten hinterlegen." : m);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load(false);
  }, []);

  function toggle(key: string) {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }
  function toggleCourse(c: CourseGroup, on: boolean) {
    setSel((s) => {
      const n = new Set(s);
      for (const i of c.items) on ? n.add(i.key) : n.delete(i.key);
      return n;
    });
  }

  async function start(payload: { keys?: string[]; course?: number }) {
    setErr("");
    try {
      await api.startJob({ ...payload, options: { language, keepVideo } });
      setSel(new Set());
      onStarted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const total = courses?.reduce((a, c) => a + c.items.length, 0) ?? 0;

  return (
    <>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>
            Aufzeichnungen{" "}
            {courses && <span className="muted small">({total} in {courses.length} Kursen)</span>}
          </h2>
          <button className="btn secondary small" disabled={loading} onClick={() => void load(true)}>
            {loading ? "Scanne …" : "Neu scannen"}
          </button>
        </div>
        {loading && scan && !scan.done && (
          <p className="small muted">
            Scanne Kurs {scan.index}/{scan.total}: {scan.name}
          </p>
        )}
        <div className="row" style={{ marginTop: 12, gap: 16, flexWrap: "wrap" }}>
          <label className="row small">
            <span>Sprache</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ width: 90 }}>
              <option value="de">de</option>
              <option value="en">en</option>
              <option value="auto">auto</option>
            </select>
          </label>
          <label className="row small">
            <input
              type="checkbox"
              checked={keepVideo}
              onChange={(e) => setKeepVideo(e.target.checked)}
              style={{ width: "auto" }}
            />
            Video behalten
          </label>
          <div className="spacer" />
          <button className="btn" disabled={busy || sel.size === 0} onClick={() => void start({ keys: [...sel] })}>
            Auswahl transkribieren ({sel.size})
          </button>
        </div>
        {busy && (
          <p className="small muted" style={{ marginTop: 8 }}>
            Ein Job läuft — neue Jobs sind erst nach Abschluss möglich.
          </p>
        )}
      </div>

      {err && (
        <div className="card">
          <div className="empty" style={{ color: "var(--red)" }}>
            {err}
          </div>
        </div>
      )}

      {courses?.map((c) => {
        const allSel = c.items.length > 0 && c.items.every((i) => sel.has(i.key));
        return (
          <div className="card course-group" key={c.courseId}>
            <div className="head">
              <input
                type="checkbox"
                checked={allSel}
                onChange={(e) => toggleCourse(c, e.target.checked)}
                style={{ width: "auto" }}
              />
              <h3>{c.courseName}</h3>
              <span className="muted small">#{c.courseId}</span>
              <div className="spacer" />
              <button className="btn secondary small" disabled={busy} onClick={() => void start({ course: c.courseId })}>
                Neue im Kurs transkribieren
              </button>
            </div>
            <table>
              <tbody>
                {c.items.map((i) => (
                  <tr key={i.key}>
                    <td style={{ width: 30 }}>
                      <input
                        type="checkbox"
                        checked={sel.has(i.key)}
                        onChange={() => toggle(i.key)}
                        style={{ width: "auto" }}
                      />
                    </td>
                    <td>{i.title}</td>
                    <td className="muted small">{i.kind}</td>
                    <td className="muted small">{fmtDur(i.durationSeconds)}</td>
                    <td>
                      <span className={`badge ${i.status}`}>{statusLabel(i.status)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {courses && courses.length === 0 && !loading && (
        <div className="card">
          <div className="empty">Keine Aufzeichnungen gefunden.</div>
        </div>
      )}
    </>
  );
}
