/**
 * Startet die Transkriptions-Web-UI.
 *   npm run ui        → baut das Frontend (falls nötig), startet das Backend
 *                       (serviert webapp/dist) und öffnet den Browser.
 *   npm run ui -- --no-build   → Frontend nicht neu bauen (schneller Neustart).
 *   npm run ui:dev    → Backend + Vite-Dev-Server (HMR) parallel.
 *
 * Muss aus dem Repo-Root laufen (relative Pfade für transcripts/, .cache/, models/).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { startServer } from "../src/webapp/server";

const WEBAPP = path.resolve("webapp");
const DIST = path.join(WEBAPP, "dist");

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
    child.on("error", reject);
  });
}

function openBrowser(url: string): void {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

async function ensureFrontendDeps(): Promise<void> {
  if (!existsSync(path.join(WEBAPP, "node_modules"))) {
    console.log("Installiere Frontend-Dependencies …");
    await run("npm", ["install"], WEBAPP);
  }
}

async function main() {
  const dev = process.argv.includes("--dev");
  const noBuild = process.argv.includes("--no-build");

  if (dev) {
    await ensureFrontendDeps();
    const backendPort = await startServer(4317);
    console.log("Starte Vite-Dev-Server (HMR) …");
    spawn("npm", ["run", "dev"], { cwd: WEBAPP, stdio: "inherit" });
    setTimeout(() => openBrowser("http://127.0.0.1:5173"), 1500);
    console.log(`Backend: http://127.0.0.1:${backendPort} · Frontend (Dev): http://127.0.0.1:5173`);
    return;
  }

  if (!noBuild) {
    await ensureFrontendDeps();
    console.log("Baue Frontend …");
    await run("npm", ["run", "build"], WEBAPP);
  }
  if (!existsSync(DIST)) {
    console.error("webapp/dist fehlt — bitte ohne --no-build starten.");
    process.exitCode = 1;
    return;
  }
  const port = await startServer();
  const url = `http://127.0.0.1:${port}`;
  openBrowser(url);
  console.log(`Web-UI geöffnet: ${url}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
