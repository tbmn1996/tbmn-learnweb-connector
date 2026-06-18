import { useEffect, useState } from "react";
import { api, openEvents, type JobState, type ModelEvent, type ScanEvent } from "./api";
import { StatusView } from "./views/StatusView";
import { RecordingsView } from "./views/RecordingsView";
import { JobsView } from "./views/JobsView";
import { TranscriptsView } from "./views/TranscriptsView";

type Tab = "status" | "recordings" | "jobs" | "transcripts";

export function App() {
  const [tab, setTab] = useState<Tab>("status");
  const [job, setJob] = useState<JobState | null>(null);
  const [scan, setScan] = useState<ScanEvent | null>(null);
  const [model, setModel] = useState<ModelEvent | null>(null);

  useEffect(() => {
    const es = openEvents({ onJob: setJob, onScan: setScan, onModel: setModel });
    api.currentJob().then(setJob).catch(() => undefined);
    return () => es.close();
  }, []);

  const activeCount = job?.running
    ? job.items.filter((i) => i.status === "running" || i.status === "queued").length
    : 0;

  return (
    <div className="app">
      <header className="app-head">
        <h1>Learnweb Transkription</h1>
        <span className="sub">lokal · whisper.cpp · Uni Münster</span>
      </header>

      <nav className="tabs">
        <button className={tab === "status" ? "active" : ""} onClick={() => setTab("status")}>
          Setup
        </button>
        <button className={tab === "recordings" ? "active" : ""} onClick={() => setTab("recordings")}>
          Aufzeichnungen
        </button>
        <button className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>
          Jobs
          {job?.running ? <span className="badge running">{activeCount}</span> : null}
        </button>
        <button className={tab === "transcripts" ? "active" : ""} onClick={() => setTab("transcripts")}>
          Transkripte
        </button>
      </nav>

      {tab === "status" && <StatusView model={model} />}
      {tab === "recordings" && (
        <RecordingsView scan={scan} job={job} onStarted={() => setTab("jobs")} />
      )}
      {tab === "jobs" && <JobsView job={job} />}
      {tab === "transcripts" && <TranscriptsView job={job} />}
    </div>
  );
}
