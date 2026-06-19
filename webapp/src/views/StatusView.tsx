import { useEffect, useState } from "react";
import { api, type ModelEvent, type SetupStatus } from "../api";

export function StatusView({ model }: { model: ModelEvent | null }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState("https://www.uni-muenster.de/LearnWeb/learnweb2");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [login, setLogin] = useState("");
  const [dlModel, setDlModel] = useState("large-v3-turbo");

  async function refresh() {
    try {
      setStatus(await api.status());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (model?.done) void refresh();
  }, [model?.done]);

  async function saveCreds() {
    setSaving(true);
    setErr("");
    try {
      await api.saveCredentials(url, username, password);
      setPassword("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function testLogin() {
    setLogin("…");
    try {
      const r = await api.loginTest();
      setLogin(r.ok ? "✓ Login erfolgreich" : `✗ ${r.reason || "fehlgeschlagen"}`);
    } catch {
      setLogin("✗ Fehler");
    }
  }

  if (!status) {
    return (
      <div className="card">
        <div className="empty">{err || "Lade Status …"}</div>
      </div>
    );
  }

  const t = status.tools;
  const modelBusy = Boolean(model && !model.done && !model.error);
  return (
    <>
      <div className="card">
        <h2>Werkzeuge</h2>
        <ul className="checklist">
          <ToolLine ok={t.mlx} label="MLX Whisper (bevorzugt)" hint="uvx oder gecachtes MLX-Modell fehlt" />
          <ToolLine ok={t.whisper} label="whisper-cli (Fallback)" hint="optional: brew install whisper-cpp" />
          <ToolLine ok={t.ytdlp} label="yt-dlp" hint="brew install yt-dlp" />
          <ToolLine ok={t.ffmpeg} label="ffmpeg" hint="brew install ffmpeg" />
        </ul>
      </div>

      <div className="card">
        <h2>Whisper-Modell</h2>
        {t.mlx && status.models.mlx.cached ? (
          <p className="small">
            <span className="badge ok">MLX aktiv</span>{" "}
            Das vorhandene Modell <code>{status.models.mlx.model}</code> wird automatisch verwendet.
          </p>
        ) : status.models.installed.length > 0 ? (
          <p className="small">
            Installiert: {status.models.installed.map((m) => `${m.file} (${m.sizeMb} MB)`).join(", ")}
          </p>
        ) : (
          <p className="small muted">Noch kein Modell installiert.</p>
        )}
        {!t.mlx && (
          <div className="row">
            <select value={dlModel} onChange={(e) => setDlModel(e.target.value)} style={{ maxWidth: 320 }}>
              {status.models.available.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} — {m.sizeMb} MB · {m.note}
                </option>
              ))}
            </select>
            <button className="btn" disabled={modelBusy} onClick={() => void api.downloadModel(dlModel)}>
              Herunterladen
            </button>
          </div>
        )}
        {modelBusy && (
          <div style={{ marginTop: 12 }}>
            <div className="small muted">
              Lade {model!.name} … {model!.pct ?? 0}%
            </div>
            <div className="progress">
              <div style={{ width: `${model!.pct ?? 0}%` }} />
            </div>
          </div>
        )}
        {model?.error && <p className="small" style={{ color: "var(--red)" }}>Fehler: {model.error}</p>}
        {model?.done && <p className="small" style={{ color: "var(--green)" }}>✓ {model.name} geladen.</p>}
      </div>

      <div className="card">
        <h2>Learnweb-Zugang</h2>
        <p className="row">
          <span>Status:</span>{" "}
          {status.credentials.present ? (
            <span className="badge ok">hinterlegt</span>
          ) : (
            <span className="badge bad">fehlt</span>
          )}
        </p>
        <label className="field">
          <span>Learnweb-URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>Benutzername (ZIV-Kennung)</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>Passwort</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="row">
          <button className="btn" disabled={saving || !username || !password} onClick={() => void saveCreds()}>
            {saving ? "Speichere …" : "In Keychain speichern"}
          </button>
          <button className="btn secondary" onClick={() => void testLogin()}>
            Login testen
          </button>
          {login && <span className="small">{login}</span>}
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          Wird lokal in der macOS-Keychain gespeichert (Service tbmn-learnweb-connector). Das Passwort
          verlässt den Rechner nicht.
        </p>
      </div>

      {err && <div className="toast err">{err}</div>}
    </>
  );
}

function ToolLine({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <li>
      <span className={`dot ${ok ? "ok" : "bad"}`} />
      <span>{label}</span>
      {!ok && <span className="small muted">— {hint}</span>}
    </li>
  );
}
