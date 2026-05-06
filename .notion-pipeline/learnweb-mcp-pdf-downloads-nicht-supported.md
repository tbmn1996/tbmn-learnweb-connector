# Learnweb MCP: PDF-Downloads nicht supported
> Quelle: Notion Coding Pipeline – 2026-05-06
> Repo: https://github.com/tbmn1996/tbmn-learnweb-connector
> Notion-Seite: https://www.notion.so/learnweb-mcp-pdf-downloads-nicht-supported

## Kontext
- Projekt: TBMN LearnWeb Connector (MCP-Server für WWU Moodle / Learnweb)
- Stack: Node.js ≥20, TypeScript 5.5, MCP SDK 1.29, axios + cheerio, Express + OAuth (Railway HTTP-Transport), zod
- Relevante Dateien:
  - `src/tools/learnweb.ts` — Tool 7 `learnweb-download-resource`-Handler (Resource-Blob-Branch)
  - `src/learnweb/session.ts` — `LearnwebSession.downloadFile()` liefert Buffer + contentType
  - `src/tools/shared.ts` — `ok()`-Helper für ToolResult
  - `test/learnweb-tools.download.test.js` — Tests für aktuellen Resource-Blob-Pfad
- Abhängigkeiten: Phase 1 ohne neue NPM-Pakete. Phase 2 (Textextraktion) bräuchte `pdf-parse` o.ä. — laut Repo-AGENTS.md zustimmungspflichtig.

## Architektur-Entscheidungen
- **Root-Cause:** Server antwortet bereits MCP-spec-konform mit base64-Blob via `content[{type:"resource", resource:{mimeType:"application/pdf", blob}}]`. Fehlermeldung „Resources of type 'application/pdf' are not currently supported" stammt aus Notion-MCP-Bridge, die `application/pdf`-Resource-Content client-seitig filtert. Smoke-Test (Schritt 6) verifiziert Hypothese.
- **Mode-Parameter statt neuem Tool:** Einziges `learnweb-download-resource` mit optionalem `mode`-Param. Default `"resource"` → keine Breaking Change für Codex.ai/Claude-Desktop.
- **Phase 1 ohne neue Dependency:** `mode: "base64"` packt Buffer als Base64-String in `structuredContent` plus `text`-Content-Item. Kein `resource`-Item → Bridge-Filter greift nicht.
- **Mode-spezifisches Größenlimit:** `mode='base64'` cappt bei 5 MB Original-Bytes (~6.7 MB base64). Überschreitung → `validation_error`. `MAX_DOWNLOAD_BYTES=25MB` bleibt für `mode='resource'` unverändert.
- **Fallback gegen Bridge-Filter-Risiko:** `mode='base64'` liefert zusätzlich reinen `text`-Content-Block mit JSON-Wrapper (`{filename, size, base64}`).
- **Opt-In für `mode='base64'` (Trust-Boundary):** Default deaktiviert. Aktivierung via env `LEARNWEB_ALLOW_BASE64_MODE=true` ODER per-call `confirm: true`. Ohne Opt-In: `validation_error: "base64 mode requires explicit opt-in"`.
- **Server-side Mode-Auto-Detection:** MCP-Initialize-Handshake liefert `clientInfo: { name, version }`. Server cached pro Session. Default-Resolution: `clientInfo.name` matcht `/notion/i` → `'base64'`, sonst `'resource'`. Explicit `mode`-Param überschreibt.
- **Phase 2 mit Dependency (separat, hinter Bestätigung):** `mode: "text"` für PDF-Textextraktion via `pdf-parse`. Eigener Schritt 7.
- **Sicherheitsgrenzen unverändert:** `PLUGINFILE_PATH_RE`-Whitelist, Host-Match, `MAX_DOWNLOAD_BYTES` (25 MB), generische Error-Codes via `wrapHandler`.

## Pre-flight Diagnostic (vor Implementation)
Verifiziert Bridge-Filter-Hypothese vor Code.
- TXT-Datei (kleine README aus Learnweb) via aktuellem `mode='resource'` aus Notion ziehen.
- TXT works → PDF-spezifischer Bridge-Filter bestätigt → weiter zu Schritt 1.
- TXT blocked → Hypothese kippt → `mode`-Architektur fehlspezifiziert; Plan auf reinen `text`-Content revidieren.

## Implementierungsschritte

### Schritt 1: `mode`-Parameter ins Input-Schema von Tool 7
- Datei: `src/tools/learnweb.ts`
- Änderung: `inputSchema` erweitern um `mode: z.enum(["resource","base64","text"]).optional().describe("Output-Format. 'resource' (default) = MCP-Blob; 'base64' = Base64-String in structuredContent (Workaround für Clients ohne PDF-Resource-Support, z.B. Notion MCP); 'text' = PDF-Textextraktion (Phase 2).")`.
- `outputSchema` als `z.discriminatedUnion("mode", [...])` mit eigenem Branch pro Mode.
- Zusätzlich `confirm: z.boolean().optional().describe("Per-call Opt-In für mode='base64'. Alternative zu env LEARNWEB_ALLOW_BASE64_MODE.")`.

### Schritt 2: Handler-Branching im Tool-7-Handler
- Datei: `src/tools/learnweb.ts`
- Änderung: Switch über `mode` nach erfolgreichem `session.downloadFile`.
  - `"resource"` (default): bestehender Code-Pfad unverändert.
  - `"base64"`: Rückgabe `{ content: [{type:"text", text: JSON.stringify({...metadata, base64})}], structuredContent: {...metadata, base64} }` ohne `resource`-Item.
  - `"text"`: zunächst `validation_error` ("not yet implemented") bis Phase 2.
- Mode-Resolution:
  1. Explicit `mode`-Param vorhanden → verwenden.
  2. Sonst gespeicherte `clientInfo.name` matcht `/notion/i` → `'base64'`.
  3. Sonst → `'resource'`.
- Opt-In-Check für `mode='base64'`: `process.env.LEARNWEB_ALLOW_BASE64_MODE === 'true'` ODER `confirm === true`. Sonst → `validation_error: "base64 mode requires explicit opt-in (env LEARNWEB_ALLOW_BASE64_MODE=true or confirm: true)"`.
- Voraussetzung: Datei `src/server.ts` (oder Initialize-Handler-Datei) — `clientInfo` aus MCP-Initialize-Handshake (`params.clientInfo` mit `{name, version}`) pro Session in Server-Context cachen; `getClientInfo(sessionId)`-Lookup für Tool-Handler bereitstellen.

### Schritt 3: Tool-Description erweitern
- Datei: `src/tools/learnweb.ts`
- Änderung: Description um Mode→Client-Mapping ergänzen:
  - `mode='resource'` (default für nicht-Notion-Clients)
  - `mode='base64'` (Notion MCP, opt-in nötig)
  - `mode='text'` (Phase 2, token-effizient)
- Auto-Detection per `clientInfo` ist primärer Mechanismus (Schritt 2). Description ist Fallback für Override-Aufrufe + Doku.
- Pro Mode 1 Beispiel-Snippet (Aufruf + erwartete Response-Shape).

### Schritt 4: Tests für neue Modes
- Datei: `test/learnweb-tools.download.test.js`
- Neuer Test „mode=base64 returns base64 in structuredContent without resource content-item": prüft `structuredContent.base64 === Buffer.from("hello-file").toString("base64")` + kein `content[].type==="resource"`.
- Regression-Test „default mode unchanged" mit expliziten Asserts (kein Snapshot): `content[0].type==='resource'`, `resource.mimeType==='application/pdf'`, `resource.blob` non-empty, base64-decoded matcht Buffer.
- Neuer Test „mode=base64 size cap": 6 MB Stub-Buffer → erwarten `validation_error` mit Mode-spezifischer Cap-Message.
- Neuer Test „mode=base64 fallback content": Response enthält zusätzlich `content[]`-Item `type: "text"` mit JSON-Wrapper inkl. `base64`-Key.

### Schritt 5: README aktualisieren
- Datei: `README.md`
- Änderung: Hinweis zu `mode`-Optionen im Tool-Abschnitt, speziell Notion-Bridge-Workaround.

### Schritt 6: Build + Smoke-Test
- `npm run build` und `npm test` lokal grün; danach Railway-Redeploy auf `learnweb-mcp-production.up.railway.app`.
- Smoke-Test mit `learnweb-download-resource(url='https://www.uni-muenster.de/LearnWeb/learnweb2/pluginfile.php/5902560/mod_resource/content/2/Vorlesung07.pdf', mode='base64')` aus Notion → erwarten: kein „application/pdf not supported"-Error mehr, base64-String im structuredContent angekommen.

### Schritt 7: Phase 2 — separat, NACH Bestätigung von Thomas
- Library-Auswahl bei Phase-2-Kickoff:
  - `pdfjs-dist` direkt — volle Kontrolle. Caveat: Mozilla-Repo seit Mitte 2023 archiviert (NPM weiter publiziert).
  - `unpdf` — modern, edge-tauglich, aktive Maintenance.
  - `pdf-parse` — Thin Wrapper um `pdfjs-dist`, erbt Archive-Status.
- `mode: "text"`-Branch implementieren, Test mit gestubbten PDF-Bytes, README-Update, build + deploy.

## Testkriterien
- [ ] `npm run build` läuft ohne Fehler.
- [ ] `npm test` — alle bestehenden Download-Tests bleiben grün (Default-Mode unverändert).
- [ ] `mode='base64'` liefert `structuredContent.base64` als nicht-leeren String, der nach Base64-Dekodierung dem Original-Buffer entspricht.
- [ ] `mode='base64'`-Response enthält **kein** `content[]`-Item mit `type: "resource"`.
- [ ] Default-Aufruf (ohne `mode`) bleibt response-identisch zum Pre-Change-Snapshot.
- [ ] Smoke-Test in Notion: `mode='base64'` für Vorlesung07.pdf liefert keine „Resources of type 'application/pdf' are not currently supported"-Meldung mehr.
- [ ] Smoke-Test in Codex.ai/Claude-Desktop: Default-Mode liefert weiterhin korrekten Resource-Blob (kein Regress).
- [ ] Sicherheitsregeln aktiv: Host-/Pluginfile-Whitelist, MaxBytes-Cap — bestehende `invalid_url`-/`file_too_large`-Tests bleiben grün.
- [ ] Größenlimit `mode='base64'`: 6 MB Stub-Buffer → `validation_error` mit Mode-spezifischer Cap-Message.
- [ ] Fallback-Content `mode='base64'`: Response enthält zusätzlich `content[]`-Item `type: "text"` mit JSON-Wrapper (`{filename, size, base64}`).
- [ ] `outputSchema`-Validation: `discriminatedUnion` lehnt Cross-Mode-Felder ab.
- [ ] Pre-flight Diagnostic: TXT-Datei via `mode='resource'` aus Notion ziehbar.
- [ ] Opt-In-Gate: `mode='base64'` ohne env `LEARNWEB_ALLOW_BASE64_MODE=true` und ohne `confirm: true` → `validation_error: "base64 mode requires explicit opt-in"`.
- [ ] Opt-In-Bypass: `mode='base64'` mit env=true ODER `confirm: true` → erfolgreiche Response.
- [ ] Auto-Detection: Mock-`clientInfo.name='notion-mcp'` ohne explizites `mode` + Opt-In → Response im base64-Mode.
- [ ] Auto-Detection: Mock-`clientInfo.name='claude-desktop'` ohne explizites `mode` → Response im resource-Mode.
- [ ] Mode-Override: explicit `mode='resource'` mit `clientInfo.name='notion-mcp'` → resource-Mode.

## Abbruchbedingungen
- Stoppe wenn: Phase 2 (`pdf-parse`) ohne explizite Bestätigung von Thomas implementiert werden müsste — Repo-AGENTS.md verlangt Zustimmung für neue NPM-Pakete.
- Stoppe wenn: Smoke-Test zeigt, dass Notion-Bridge auch base64-Felder in `structuredContent` filtert. Dann Plan revidieren (z.B. base64 chunked als reiner `text`-Content ohne JSON-Wrapper, oder Filename-Suffix-Tarnung).
- Stoppe wenn: Pre-flight TXT-Test (vor Schritt 1) zeigt, dass Bridge ALLE `resource`-Items filtert → `mode`-Architektur fehlspezifiziert; neuen Plan basierend auf reinem `text`-Content erarbeiten.
- Stoppe wenn: Default-Mode-Tests nach Refactor brechen (Breaking Change unzulässig).
- Stoppe wenn: WWU-Moodle den Pluginfile-Pfad in zukünftigen Moodle-Releases inkompatibel umbaut (out of scope).
