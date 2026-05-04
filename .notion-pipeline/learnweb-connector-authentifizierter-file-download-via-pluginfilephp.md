# learnweb-connector: Authentifizierter File-Download via pluginfile.php
> Quelle: Notion Coding Pipeline – 2026-05-04
> Repo: https://github.com/tbmn1996/tbmn-learnweb-connector
> Notion-Seite: https://www.notion.so/learnweb-connector-Authentifizierter-File-Download-via-pluginfile-php

## Kontext
- Projekt: tbmn-learnweb-connector (MCP-Server für WWU Learnweb/Moodle, read-only Connector für claude.ai)
- Relevante Dateien:
  - `src/learnweb/session.ts` — Singleton `LearnwebSession` mit axios + `tough-cookie` `CookieJar`, Re-Login-Logik, Throttle/Semaphore. Modul-Header sagt aktuell: „Datei-Download (wird bewusst nicht unterstützt)" — wird mit diesem Ticket aufgehoben.
  - `src/tools/learnweb.ts` — Registriert 6 read-only MCP-Tools via `registerTool` + `wrapHandler` Pattern.
  - `src/learnweb/parsers/resource.ts` — Extrahiert `download_url` (pluginfile.php) aus mod/resource-View. Liefert URL an Caller weiter.
  - `test/learnweb-session.download.test.ts` (neu)
  - `test/learnweb-tools.download.test.ts` (neu)
  - `README.md`
- Abhängigkeiten (bereits in `package.json` v1.0.0):
  - `axios` ^1.15.0 (responseType: arraybuffer fähig)
  - `axios-cookiejar-support` ^6.0.5 (`wrapper()` aktiv im Singleton-Client)
  - `tough-cookie` ^6.0.1 (CookieJar mit MoodleSession-Cookie)
  - `zod` ^3.25.76 (Input-Schema)
  - Keine neuen NPM-Pakete erforderlich.

## Architektur-Entscheidungen
- Singleton-Client wiederverwenden: `LearnwebSession.client` hat CookieJar + Re-Login + Throttle. Neue `downloadFile()` schließt sich an `get()`/`postJson()` an → Cookies automatisch mit, kein Code-Dup.
- Response-Format `arraybuffer` + MCP `BlobResourceContents`. Tool returns `content: [{ type: "resource", resource: { uri, mimeType, blob } }, { type: "text", text: <metadata-json> }]`. Metadata: `filename` + `size` + `content_type`. `wrapHandler` wird im neuen Tool umgangen (eigener try/catch), weil Resource-Output nicht JSON-gewrappt werden darf.
- Two-Tier-Limit: Default `DEFAULT_DOWNLOAD_BYTES = 3 * 1024 * 1024` (≈ 4 MB base64 → sicher für MCP HTTP-Transport; Python-SDK 4 MB Issue #1012, Go-SDK 1 MB Issue #793). Hard-Cap `MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024` als opt-in via Tool-Arg `max_bytes` (stdio/lokal). Bei Überschreitung Error-Code `file_too_large`. Kein HEAD-Pre-Check (3-MB-Default deckt 99 % der Fälle; Stream-Refactor wäre Architektur-Bruch).
- Login-Redirect-Erkennung 1:1 aus `get()`: 3xx auf `/login/index.php` ODER 200 mit `text/html` + Login-Form. Beide Fälle prüfen → einmal Re-Login + Retry → sonst `LearnwebAuthError`.
- Anti-SSRF-Guard: Nur URLs mit gleichem Protocol UND Host wie `session.getBaseUrl()` UND Pathname matcht `^/(?:webservice/)?(?:token)?pluginfile\.php/`. Whitelist deckt `/pluginfile.php/`, `/tokenpluginfile.php/`, `/webservice/pluginfile.php/`.
- Read-Only-Annotation bleibt: `READ_ONLY_TOOL_ANNOTATIONS`.
- Filename via `Content-Disposition` (RFC 6266 / RFC 5987): RFC-5987-Branch `filename*=UTF-8''<value>` mit `decodeURIComponent`, Fallback `filename="<value>"`. Eigenes Decoding (FILENAME_RE aus parser ist ASCII-only).

## Implementierungsschritte

### Schritt 1: Modul-Header in `src/learnweb/session.ts` anpassen
- Datei: `src/learnweb/session.ts`
- Änderung: In JSDoc-Liste „Nicht zuständig für:" Eintrag `- Datei-Download (wird bewusst nicht unterstützt)` entfernen. Unter „Verantwortlichkeiten:" neu: `- Authentifizierter Datei-Download via pluginfile.php (downloadFile)`.

### Schritt 2: Export-Type `DownloadFileResult`
- Datei: `src/learnweb/session.ts`
- Position: nach `LearnwebResponse`-Interface (~Z. 90).
- Code:
```typescript
export interface DownloadFileResult {
	status: number;
	contentType: string;
	filename?: string;
	bytes: Buffer;
}
```

### Schritt 3: Public Methode `downloadFile()`
- Datei: `src/learnweb/session.ts`
- Position: nach `postJson()` (vor `get()`).
- Signatur: `public async downloadFile(url: string, options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<DownloadFileResult>`
- Logik:
  1. Defaults: `maxBytes = options.maxBytes ?? 25 * 1024 * 1024`, `timeoutMs = options.timeoutMs ?? 60_000`.
  2. `await this.throttleInterCall(); await this.acquireSemaphore();` → try/finally mit `releaseSemaphore()`.
  3. `await this.ensureLoggedIn();`
  4. `let resp = await this.rawDownload(url, maxBytes, timeoutMs);`
  5. Wenn `this.isLoginRedirectDownload(resp)`: `await this.performLogin(true);` → `resp = await this.rawDownload(...)` → bei erneutem Login-Redirect `throw new LearnwebAuthError("Session could not be re-established for download.")`.
  6. Wenn `resp.status < 200 || resp.status >= 300`: `throw new LearnwebUpstreamError(\`Download failed with status ${resp.status}\`)`.
  7. Return `resp`.

### Schritt 4: Private Helper `rawDownload()`
- Datei: `src/learnweb/session.ts`
- Position: unter `rawGet()`.
- Signatur: `private async rawDownload(url: string, maxBytes: number, timeoutMs: number): Promise<DownloadFileResult>`
- Logik:
  - `try { const resp = await this.client.get(url, { responseType: "arraybuffer", maxRedirects: 5, timeout: timeoutMs, maxContentLength: maxBytes, maxBodyLength: maxBytes, validateStatus: () => true }); ... } catch (error) { if (isAxiosTimeoutError(error)) throw new LearnwebTimeoutError(); if (axios.isAxiosError(error) && error.code === "ERR_BAD_RESPONSE" && /maxContentLength size of/.test(error.message)) { const e = new LearnwebUpstreamError("file_too_large"); (e as any).code = "file_too_large"; throw e; } throw error; }`
  - Headers normalisieren mit bestehendem `normalizeHeaders()`.
  - `contentType = headers["content-type"] ?? "application/octet-stream"`.
  - `filename` aus `headers["content-disposition"]`: zuerst `filename*=UTF-8''<value>` → `decodeURIComponent(value)`. Fallback: `filename="<value>"` (Quotes strippen).
  - `bytes = Buffer.from(resp.data as ArrayBuffer)`.
  - Return `{ status: resp.status, contentType, filename, bytes }`.

### Schritt 5: Private Helper `isLoginRedirectDownload()`
- Datei: `src/learnweb/session.ts`
- Position: unter `isLoginRedirect()`.
- Signatur: `private isLoginRedirectDownload(resp: DownloadFileResult): boolean`
- Logik:
  - Wenn `resp.contentType.startsWith("text/html")`: `const head = resp.bytes.toString("utf8", 0, Math.min(resp.bytes.length, 8192));` → return `/<form[^>]+action="[^"]*\/login\/index\.php/i.test(head)`.
  - Default: `return false`.

### Schritt 6: MCP-Tool `learnweb-download-resource`
- Datei: `src/tools/learnweb.ts`
- Position: nach Tool 6 (`learnweb-get-calendar-month`).
- Header-Kommentar oben (Z. ~5–11) erweitern: `7. learnweb-download-resource    → authentifizierter Datei-Download (pluginfile.php) als base64`.
- Konstanten + Whitelist-Regex oben:
```typescript
const DEFAULT_DOWNLOAD_BYTES = 3 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const PLUGINFILE_PATH_RE = /^\/(?:webservice\/)?(?:token)?pluginfile\.php\//;
```
- Tool-Body:
```typescript
registerTool(
	"learnweb-download-resource",
	{
		title: "Learnweb: Download Resource",
		description:
			"Authenticated download of a Moodle pluginfile.php URL (incl. /tokenpluginfile.php/, /webservice/pluginfile.php/) using the active Learnweb session. " +
			"Use only with URLs from a prior learnweb-read-activity (download_url field). " +
			"Returns the file as MCP resource content (base64 blob + mime type). Default max 3 MB (≈ 4 MB base64; safe for HTTP transport); opt-in hard cap 25 MB for stdio/local use.",
		inputSchema: {
			url: z
				.string()
				.url()
				.describe("Absolute Moodle URL (typically /pluginfile.php/...) returned as download_url by learnweb-read-activity."),
			max_bytes: z
				.number()
				.int()
				.positive()
				.max(MAX_DOWNLOAD_BYTES)
				.optional()
				.describe(`Optional upper byte limit. Default ${DEFAULT_DOWNLOAD_BYTES} (≈ 4 MB base64; safe for MCP HTTP transport). Hard cap ${MAX_DOWNLOAD_BYTES} (opt-in; recommended for stdio/local only).`),
		} as ToolInputSchema,
		annotations: READ_ONLY_TOOL_ANNOTATIONS,
	},
	async (args: { url: string; max_bytes?: number }) => {
		// NICHT durch wrapHandler: Tool gibt MCP-Resource-Content zurück.
		try {
			const session = LearnwebSession.getInstance();
			const sessionBase = new URL(session.getBaseUrl());
			let target: URL;
			try {
				target = new URL(args.url);
			} catch {
				return { error: true, code: "invalid_url", message: "URL could not be parsed." };
			}
			if (target.protocol !== sessionBase.protocol) {
				return { error: true, code: "invalid_url", message: "URL protocol mismatch (no http downgrade)." };
			}
			if (target.host !== sessionBase.host) {
				return { error: true, code: "invalid_url", message: "URL host does not match Learnweb base URL." };
			}
			if (!PLUGINFILE_PATH_RE.test(target.pathname)) {
				return { error: true, code: "invalid_url", message: "URL pathname must match Moodle pluginfile.php whitelist (/pluginfile.php/, /tokenpluginfile.php/, /webservice/pluginfile.php/)." };
			}
			const maxBytes = args.max_bytes ?? DEFAULT_DOWNLOAD_BYTES;
			const result = await session.downloadFile(args.url, { maxBytes });
			const metadata = {
				filename: result.filename,
				size: result.bytes.length,
				content_type: result.contentType,
			};
			return {
				content: [
					{
						type: "resource",
						resource: {
							uri: args.url,
							mimeType: result.contentType,
							blob: result.bytes.toString("base64"),
						},
					},
					{ type: "text", text: JSON.stringify(metadata) },
				],
			};
		} catch (err) {
			if ((err as any)?.code === "file_too_large") return { error: true, code: "file_too_large", message: (err as Error).message };
			if (err instanceof LearnwebAuthError) return { error: true, code: "learnweb_auth_error", message: err.message };
			if (err instanceof LearnwebTimeoutError) return { error: true, code: "learnweb_timeout", message: err.message };
			if (err instanceof LearnwebUpstreamError) return { error: true, code: "learnweb_upstream_error", message: err.message };
			throw err;
		}
	}
);
```
- Eigener try/catch statt `wrapHandler` (Resource-Content darf nicht in `text`-Item gewrappt werden). Andere 6 Tools bleiben auf `wrapHandler`.

### Schritt 7: Tests `test/learnweb-session.download.test.ts` (neu)
- 6 Unit-Tests gegen `LearnwebSession.downloadFile()` mit gemocktem axios-Client:
  - returns bytes + content-type for 200 response
  - retries once on login-form HTML and succeeds on second call
  - throws LearnwebAuthError on persistent login redirect
  - throws file_too_large when content-length exceeds maxBytes (axios `AxiosError` mit `code: "ERR_BAD_RESPONSE"` + `message: "maxContentLength size of N exceeded"` simulieren)
  - returns RFC-5987-decoded filename (Header `filename*=UTF-8''%C3%9Cbung%201.pdf` → `"Übung 1.pdf"`)
  - prefers filename*= over filename= (RFC-6266-Präferenz)
- Vor jedem Test `LearnwebSession.resetForTests()`. Pattern aus bestehenden `test/`-Tests übernehmen.

### Schritt 8: Tests `test/learnweb-tools.download.test.ts` (neu)
- Tests gegen registriertes `learnweb-download-resource`-Tool mit gestubter `LearnwebSession.getInstance().downloadFile`:
  - returns base64 + content_type + filename for valid URL
  - returns invalid_url error when URL host differs from session baseUrl
  - returns invalid_url error on http→https protocol downgrade attempt
  - returns invalid_url error when pathname matches none of /pluginfile.php/, /tokenpluginfile.php/, /webservice/pluginfile.php/
  - accepts /tokenpluginfile.php/ und /webservice/pluginfile.php/ Paths
  - returns content array with type "resource" + mimeType + blob (no plain data_base64 wrapper)
  - defaults max_bytes to 3 MB when args.max_bytes is undefined
  - maps file_too_large via own try/catch (not wrapHandler) and preserves resource content array on success

### Schritt 9: README.md
- Datei: `README.md`
- Änderung: Im Abschnitt der MCP-Tools nach `learnweb-get-calendar-month` neuen Eintrag: `learnweb-download-resource — Authenticated download of pluginfile.php URLs (returns base64, max 25 MB).`

## Testkriterien
- [ ] `npm run build` ohne TypeScript-Fehler.
- [ ] `npm test` grün (alle bestehenden + neue Tests).
- [ ] Smoke-Test stdio: `learnweb-read-activity` für `mod=resource` liefert `download_url` → `learnweb-download-resource` damit liefert blob mit `content_type` ≠ `text/html` und `size > 0`.
- [ ] SSRF-Negativ: `https://example.com/foo.pdf` → `{ error: true, code: "invalid_url" }`.
- [ ] Limit-Negativ: `max_bytes: 1024` auf ≥ 1 MB Datei → Error `file_too_large` (kein Crash).
- [ ] Session-Persistenz: Direkt nach Download `learnweb-get-courses` → kein Re-Login (Cookie-Jar valide).
- [ ] Keine Credentials/Cookie-Werte in blob-Inhalt (Spot-Check Base64-Decode der ersten 200 Bytes ≠ Login-Form).
- [ ] AGENTS.md-Abschluss: Feature direkt in Claude nutzbar (lokal stdio-Restart / Production Railway-Redeploy).

## Abbruchbedingungen
- Stoppe wenn: Cookie-Versand bei Test fehlt → Indiz, dass `this.client` nicht `wrapper(axios.create(...jar...))` ist. NICHT manuell `Cookie`-Header setzen. Ursache klären.
- Stoppe wenn: pluginfile.php konsistent 200 + HTML auch nach Re-Login → falsche Login-Konfig oder geänderte Moodle-Version. Nicht eigenmächtig auf neue Auth-Strategie wechseln. Status „Blockiert" + Diagnose-Kommentar.
- Stoppe wenn: TypeScript-Build neue strict-mode-Fehler in `parsers/resource.ts` durch FILENAME_RE-Re-Export → lokal duplizieren oder Refactor in `common.ts`. Keine größeren Refactorings ohne Bestätigung.
- Stoppe wenn: Datei-Größe-Heuristik unklar oder Streaming gewünscht → KEINE neuen NPM-Pakete ohne Bestätigung.
- Bei Abweichung vom Plan: STOP → Page-Kommentar mit Abweichung → nicht eigenmächtig fortfahren.
- NEVER: `.env`-Inhalt, Cookie-Werte oder Credentials in Logs/Errors/Tool-Output.
- NEVER: Force-Push auf `main`. PR-Workflow oder direkter Push mit klarer Commit-Message gemäß AGENTS.md.
