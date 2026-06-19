/**
 * LearnwebSession
 * ---------------
 * Singleton-Klasse für HTTP-Zugriff auf Learnweb (Moodle).
 *
 * Verantwortlichkeiten:
 *   - Formular-Login mit logintoken (kein Moodle Web Service)
 *   - Cookie-persistenz über tough-cookie Jar
 *   - Transparente Re-Login-Logik bei Session-Expiry
 *   - Authentifizierter Datei-Download via pluginfile.php (downloadFile)
 *   - Rate-Limiting: Inter-Call-Delay + Intra-Call-Semaphore
 *   - Absolut keine Credentials in Logs, Errors oder Responses
 *
 * Nicht zuständig für:
 *   - HTML-Parsing (siehe src/learnweb/parsers/*)
 */

import axios, { AxiosInstance, AxiosResponse } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import { LEARNWEB_URL, LEARNWEB_USERNAME, LEARNWEB_PASSWORD } from "../config";

// Dieser User-Agent matcht den Python-Referenz-Scraper exakt, damit
// der Moodle-Server dasselbe Verhalten zeigt (wichtig bei evtl. Anti-Bot-Rules).
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

// Minimaler Zeitabstand zwischen zwei getrennten Tool-Calls, die je eine eigene
// Request-Sequenz lostreten. Verhindert, dass ein KI-Client durch paralleles
// Aufrufen mehrerer Tools den Moodle-Server unter Last setzt.
const INTER_CALL_DELAY_MS = 150;

// Maximale parallele HTTP-Requests innerhalb eines einzelnen Tool-Aufrufs
// (z.B. wenn ein Forum mehrere Diskussionsseiten gleichzeitig laden würde).
const INTRA_CALL_CONCURRENCY = 3;

// Hard-Timeout pro Einzelrequest. Moodle kann bei großen Kursseiten langsam sein,
// aber mehr als 15s deutet auf ein echtes Problem hin.
const REQUEST_TIMEOUT_MS = 15000;

export class LearnwebNotConfiguredError extends Error {
  constructor() {
    super("Learnweb is not configured. Set LEARNWEB_URL, LEARNWEB_USERNAME, LEARNWEB_PASSWORD.");
    this.name = "LearnwebNotConfiguredError";
  }
}

export class LearnwebAuthError extends Error {
  constructor(message = "Learnweb login failed (check credentials).") {
    super(message);
    this.name = "LearnwebAuthError";
  }
}

export class LearnwebTimeoutError extends Error {
  constructor(message = "Learnweb request timed out.") {
    super(message);
    this.name = "LearnwebTimeoutError";
  }
}

export class LearnwebFileTooLargeError extends Error {
  constructor(message = "Downloaded file exceeds configured byte limit.") {
    super(message);
    this.name = "LearnwebFileTooLargeError";
  }
}

export class LearnwebParseError extends Error {
  public readonly parser?: string;
  public readonly selector?: string;
  public readonly diagnostics?: Record<string, unknown>;

  constructor(message?: string, diagnostics?: Record<string, unknown>);
  constructor(
    parser: string,
    selector: string,
    message: string,
    diagnostics?: Record<string, unknown>
  );
  constructor(
    arg1 = "Learnweb response could not be parsed.",
    arg2?: string | Record<string, unknown>,
    arg3?: string,
    arg4?: Record<string, unknown>
  ) {
    const hasStructuredContext = typeof arg2 === "string";
    const message = hasStructuredContext ? (arg3 ?? "Learnweb response could not be parsed.") : arg1;
    super(message);
    this.name = "LearnwebParseError";
    if (hasStructuredContext) {
      this.parser = arg1;
      this.selector = arg2;
      this.diagnostics = arg4;
    } else {
      this.diagnostics = arg2 as Record<string, unknown> | undefined;
    }
  }
}

export class LearnwebUpstreamError extends Error {
  public readonly status?: number;
  public readonly path?: string;
  public readonly diagnostics?: Record<string, unknown>;

  constructor(message?: string, diagnostics?: Record<string, unknown>);
  constructor(
    status: number,
    path: string,
    message: string,
    diagnostics?: Record<string, unknown>
  );
  constructor(
    arg1: string | number = "Learnweb upstream returned non-2xx.",
    arg2?: string | Record<string, unknown>,
    arg3?: string,
    arg4?: Record<string, unknown>
  ) {
    const hasStructuredContext = typeof arg1 === "number";
    const message = hasStructuredContext ? (arg3 ?? "Learnweb upstream returned non-2xx.") : String(arg1);
    super(message);
    this.name = "LearnwebUpstreamError";
    if (hasStructuredContext) {
      this.status = arg1;
      this.path = typeof arg2 === "string" ? arg2 : undefined;
      this.diagnostics = arg4;
    } else {
      this.diagnostics = arg2 as Record<string, unknown> | undefined;
    }
  }
}

/**
 * Public contract einer Learnweb-Antwort. Wir reichen nur die für Parser
 * relevanten Felder durch; Cookie-Details bleiben im Jar.
 */
export interface LearnwebResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  data: string;
}

export interface DownloadFileResult {
  status: number;
  contentType: string;
  filename?: string;
  bytes: Buffer;
}

export class LearnwebSession {
  private static instance: LearnwebSession | null = null;

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly jar: CookieJar;
  private readonly client: AxiosInstance;

  // Dedupliziert parallele Re-Logins. Wenn zwei Tool-Calls gleichzeitig eine
  // abgelaufene Session erkennen, soll nur EIN POST /login/index.php rausgehen.
  private loginPromise: Promise<void> | null = null;

  // Semaphore für intra-call Parallelität.
  private runningRequests = 0;
  private waitQueue: Array<() => void> = [];

  // Throttle zwischen getrennten Tool-Calls.
  private lastRequestAt = 0;

  // Gecachter sesskey + Moodle-wwwroot — werden bei Re-Auth invalidiert.
  private sesskey: string | null = null;
  private moodleWwwroot: string | null = null;

  private constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
    this.jar = new CookieJar();
    this.client = wrapper(
      axios.create({
        baseURL: baseUrl,
        jar: this.jar,
        withCredentials: true,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { "User-Agent": USER_AGENT },
        // Wir wollen selbst entscheiden, was 3xx bedeutet — insbesondere für
        // Login-Redirects und Resource-View-Seiten.
        maxRedirects: 0,
        validateStatus: () => true,
      })
    );
  }

  /**
   * Singleton-Accessor. Wirft LearnwebNotConfiguredError wenn nötige Env-Vars
   * fehlen — das sollte jedoch nie passieren, weil registerLearnwebTools die
   * Tools nur registriert, wenn die Config vollständig ist.
   */
  public static getInstance(): LearnwebSession {
    if (LearnwebSession.instance) {
      return LearnwebSession.instance;
    }
    if (!LEARNWEB_URL || !LEARNWEB_USERNAME || !LEARNWEB_PASSWORD) {
      throw new LearnwebNotConfiguredError();
    }
    LearnwebSession.instance = new LearnwebSession(
      LEARNWEB_URL,
      LEARNWEB_USERNAME,
      LEARNWEB_PASSWORD
    );
    return LearnwebSession.instance;
  }

  /**
   * Reset für Tests. Nicht aus Produktionscode aufrufen.
   */
  public static resetForTests() {
    LearnwebSession.instance = null;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Prüft ob ein Moodle-Session-Cookie vorhanden ist — nur Boolean, kein Cookie-Wert. */
  public async hasMoodleCookie(): Promise<boolean> {
    const cookies = await this.jar.getCookies(this.baseUrl);
    return cookies.some((c) => c.key.toLowerCase().startsWith("moodlesession"));
  }

  /**
   * Liefert den Moodle-sesskey (CSRF-Token) für AJAX-Calls.
   * Wird lazy vom Dashboard `/my/index.php` geholt und bis zum nächsten
   * Re-Auth gecacht, da der sesskey Session-gebunden ist.
   */
  public async getSesskey(): Promise<string> {
    if (this.sesskey) return this.sesskey;

    const resp = await this.get("/my/index.php");
    const $ = cheerio.load(resp.data);

    // Primär: verstecktes Input-Feld (z.B. in Formular-Elementen).
    let key = $('input[name="sesskey"]').first().attr("value") ?? "";

    // Fallback: M.cfg-Inline-JS, das Moodle auf allen Seiten einbettet.
    if (!key) {
      const match = /"sesskey":"([^"]+)"/.exec(resp.data);
      if (match) key = match[1];
    }

    if (!key) {
      throw new LearnwebAuthError("Could not extract sesskey from Moodle dashboard.");
    }

    // wwwroot cachen — nötig für korrekte AJAX-URLs wenn baseURL nur den Domain-Root hat.
    const wwwrootMatch = /"wwwroot":"([^"]+)"/.exec(resp.data);
    if (wwwrootMatch) {
      this.moodleWwwroot = wwwrootMatch[1].replace(/\\\//g, "/");
    }

    this.sesskey = key;
    return key;
  }

  /**
   * Liefert die Moodle-wwwroot (z.B. "https://www.uni-muenster.de/LearnWeb/learnweb2").
   * Muss nach getSesskey() gecacht sein; Fallback ist baseUrl.
   */
  public getMoodleWwwroot(): string {
    return this.moodleWwwroot ?? this.baseUrl;
  }

  /**
   * POST mit JSON-Body. Wird für Moodle AJAX-Endpoints benötigt.
   * Nutzt dieselbe Session/Cookie-Jar wie `get()`.
   * Throttle und Semaphore liegen beim Caller.
   */
  public async postJson(path: string, body: unknown): Promise<LearnwebResponse> {
    try {
      const resp = await this.client.post(path, JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
      return {
        status: resp.status,
        url: resp.request?.res?.responseUrl ?? this.resolveUrl(path),
        headers: normalizeHeaders(resp.headers),
        data: typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data ?? ""),
      };
    } catch (error) {
      if (isAxiosTimeoutError(error)) {
        throw new LearnwebTimeoutError();
      }
      throw error;
    }
  }

  /**
   * Authentifizierter Download einer Moodle-Datei.
   * Nutzt dieselbe CookieJar wie `get()`, liefert aber Bytes statt HTML-Text.
   */
  public async downloadFile(
    url: string,
    options: { maxBytes?: number; timeoutMs?: number } = {}
  ): Promise<DownloadFileResult> {
    const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 60_000;

    await this.throttleInterCall();
    await this.acquireSemaphore();
    try {
      await this.ensureLoggedIn();
      let resp = await this.rawDownload(url, maxBytes, timeoutMs);

      if (this.isLoginRedirectDownload(resp)) {
        await this.performLogin(/* force */ true);
        resp = await this.rawDownload(url, maxBytes, timeoutMs);
        if (this.isLoginRedirectDownload(resp)) {
          throw new LearnwebAuthError("Session could not be re-established for download.");
        }
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new LearnwebUpstreamError("Download failed with non-2xx status.", {
          status: resp.status,
        });
      }

      return resp;
    } finally {
      this.releaseSemaphore();
    }
  }

  /**
   * GET auf einen Pfad oder eine absolute Learnweb-URL.
   * - Führt automatisch einen Login aus, falls noch keine Session besteht.
   * - Erkennt Login-Redirects und logged bei Bedarf transparent neu.
   * - Folgt redirects NICHT automatisch (Parser entscheiden selbst).
   *
   * @param path Pfad ("/course/view.php?id=123") oder absolute URL auf demselben Host
   * @param options.allowRedirects wenn true, folgen wir Redirects die NICHT auf Login zeigen
   * @param options.timeoutMs optionaler Request-Timeout nur für diesen GET
   */
  public async get(
    path: string,
    options: { allowRedirects?: boolean; timeoutMs?: number } = {}
  ): Promise<LearnwebResponse> {
    await this.throttleInterCall();
    await this.acquireSemaphore();
    try {
      await this.ensureLoggedIn();
      let resp = await this.rawGet(path, options.timeoutMs);

      // Login-Redirect erkannt → Re-Login und nochmal versuchen.
      if (this.isLoginRedirect(resp)) {
        await this.performLogin(/* force */ true);
        resp = await this.rawGet(path, options.timeoutMs);
        if (this.isLoginRedirect(resp)) {
          throw new LearnwebAuthError("Session could not be re-established.");
        }
      }

      if (options.allowRedirects && isRedirect(resp.status)) {
        const location = resp.headers["location"];
        if (location) {
          resp = await this.rawGet(location, options.timeoutMs);
        }
      }

      return resp;
    } finally {
      this.releaseSemaphore();
    }
  }

  /**
   * POST (Form-URL-Encoded). Wird aktuell nur für Login verwendet.
   */
  private async postForm(path: string, form: Record<string, string>): Promise<AxiosResponse> {
    const body = new URLSearchParams(form).toString();
    return this.client.post(path, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  /** Roher GET ohne Semaphore/Throttle — nur intern benutzen. */
  private async rawGet(
    path: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<LearnwebResponse> {
    try {
      const resp = await this.client.get(path, { timeout: timeoutMs });
      return {
        status: resp.status,
        url: resp.request?.res?.responseUrl ?? this.resolveUrl(path),
        headers: normalizeHeaders(resp.headers),
        data: typeof resp.data === "string" ? resp.data : String(resp.data ?? ""),
      };
    } catch (error) {
      if (isAxiosTimeoutError(error)) {
        throw new LearnwebTimeoutError();
      }
      throw error;
    }
  }

  /** Roher Datei-Download ohne Semaphore/Throttle — nur intern benutzen. */
  private async rawDownload(
    url: string,
    maxBytes: number,
    timeoutMs: number
  ): Promise<DownloadFileResult> {
    try {
      const resp = await this.client.get(url, {
        responseType: "arraybuffer",
        timeout: timeoutMs,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        // Datei-Downloads dürfen Moodle-/Token-Redirects folgen; HTML-Parser
        // bleiben bewusst bei maxRedirects:0, damit sie View-Seiten auswerten können.
        maxRedirects: 5,
        validateStatus: () => true,
      });
      const headers = normalizeHeaders(resp.headers);
      const contentType = headers["content-type"] ?? "application/octet-stream";
      const filename = extractFilenameFromContentDisposition(headers["content-disposition"]);
      return {
        status: resp.status,
        contentType,
        filename,
        bytes: Buffer.from(resp.data as ArrayBuffer),
      };
    } catch (error) {
      if (isAxiosTimeoutError(error)) {
        throw new LearnwebTimeoutError();
      }
      if (
        axios.isAxiosError(error) &&
        error.code === "ERR_BAD_RESPONSE" &&
        /maxContentLength size of .* exceeded/i.test(error.message)
      ) {
        throw new LearnwebFileTooLargeError();
      }
      throw error;
    }
  }

  /** Erzeugt absoluten URL-String aus Pfad oder URL. */
  private resolveUrl(pathOrUrl: string): string {
    try {
      return new URL(pathOrUrl, this.baseUrl + "/").toString();
    } catch {
      return this.baseUrl + pathOrUrl;
    }
  }

  /**
   * Stellt sicher, dass wir eingeloggt sind. Wenn bereits ein Login im Gange
   * ist, warten wir auf dessen Promise (Deduplizierung).
   */
  private async ensureLoggedIn(): Promise<void> {
    // Heuristik: Wir haben keinen persistierten "logged-in"-State. Stattdessen
    // prüfen wir beim ersten Call, ob der Jar einen Moodle-Session-Cookie hat.
    // Wenn nicht, erzwingen wir Login.
    const cookies = await this.jar.getCookies(this.baseUrl);
    const hasMoodleCookie = cookies.some((c) => c.key.toLowerCase().startsWith("moodlesession"));
    if (hasMoodleCookie) {
      return;
    }
    await this.performLogin();
  }

  /**
   * Führt Login durch. Parallele Aufrufe werden dedupliziert.
   */
  private async performLogin(force = false): Promise<void> {
    if (this.loginPromise && !force) {
      return this.loginPromise;
    }
    if (force) {
      // Bei erzwungenem Login (nach Session-Expiry) alten Jar-State + sesskey verwerfen.
      await this.jar.removeAllCookies();
      this.sesskey = null;
      this.moodleWwwroot = null;
    }
    this.loginPromise = this.doLogin().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async doLogin(): Promise<void> {
    // Schritt 1: Login-Seite holen, logintoken extrahieren.
    const getResp = await this.client.get("/login/index.php");
    if (getResp.status >= 500) {
      throw new LearnwebAuthError("Learnweb login page unavailable.");
    }
    const html = typeof getResp.data === "string" ? getResp.data : String(getResp.data ?? "");
    const $ = cheerio.load(html);
    const logintoken = $('input[name="logintoken"]').attr("value") ?? "";

    // Schritt 2: POST mit Credentials + logintoken.
    const postResp = await this.postForm("/login/index.php", {
      username: this.username,
      password: this.password,
      logintoken,
      anchor: "",
    });

    // Moodle redirected nach erfolgreichem Login entweder direkt auf /my/ (oder
    // Dashboard) oder zuerst auf /login/index.php?testsession=XXX. Letzteres ist
    // kein Fehler — Moodle prüft damit, dass Cookies korrekt gespeichert wurden,
    // und leitet anschließend zur Zielseite weiter. Uni-Münster-Moodle nutzt
    // diesen Bounce; viele kleinere Instanzen nicht.
    // Misserfolg: Response-Body enthält "loginerrormessage" oder Location zeigt
    // auf die Login-Form OHNE testsession-Parameter.
    const postBody =
      typeof postResp.data === "string" ? postResp.data : String(postResp.data ?? "");
    const location = (postResp.headers?.["location"] as string | undefined) ?? "";
    const locationIsLoginForm =
      location.includes("/login/index.php") && !location.includes("testsession=");
    const stillOnLogin = locationIsLoginForm || postBody.includes("loginerrormessage");

    if (stillOnLogin) {
      // Keine Credentials leaken — generische Fehlermeldung.
      throw new LearnwebAuthError();
    }
  }

  /**
   * Erkennt Redirects auf die Login-Seite als Zeichen abgelaufener Session.
   */
  private isLoginRedirect(resp: LearnwebResponse): boolean {
    if (!isRedirect(resp.status)) {
      // Manche Moodle-Setups servieren die Login-Seite mit 200 direkt,
      // wenn die Session abgelaufen ist. Daher zusätzlich Body prüfen.
      if (resp.status === 200 && /<form[^>]+action="[^"]*\/login\/index\.php/i.test(resp.data)) {
        return true;
      }
      return false;
    }
    const location = resp.headers["location"] ?? "";
    return location.includes("/login/index.php") || location.includes("/login/?");
  }

  private isLoginRedirectDownload(resp: DownloadFileResult): boolean {
    if (!resp.contentType.toLowerCase().startsWith("text/html")) {
      return false;
    }
    const head = resp.bytes.toString("utf8", 0, Math.min(resp.bytes.length, 8192));
    return /<form[^>]+action=["'][^"']*\/login\/index\.php/i.test(head);
  }

  /**
   * Blockiert, bis der letzte Inter-Call-Delay abgelaufen ist.
   */
  private async throttleInterCall(): Promise<void> {
    const now = Date.now();
    const wait = this.lastRequestAt + INTER_CALL_DELAY_MS - now;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    this.lastRequestAt = Date.now();
  }

  /**
   * Einfache Semaphore ohne externe Dependency.
   */
  private async acquireSemaphore(): Promise<void> {
    if (this.runningRequests < INTRA_CALL_CONCURRENCY) {
      this.runningRequests++;
      return;
    }
    await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    this.runningRequests++;
  }

  private releaseSemaphore(): void {
    this.runningRequests--;
    const next = this.waitQueue.shift();
    if (next) next();
  }
}

/**
 * Normalisiert Axios-Header-Objekt auf flaches Record.
 */
function normalizeHeaders(h: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!h || typeof h !== "object") return result;
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      result[k.toLowerCase()] = v.join(", ");
    } else if (v != null) {
      result[k.toLowerCase()] = String(v);
    }
  }
  return result;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isAxiosTimeoutError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  return error.code === "ECONNABORTED" || error.code === "ETIMEDOUT";
}

function extractFilenameFromContentDisposition(header?: string): string | undefined {
  if (!header) return undefined;

  const encodedMatch = /filename\*\s*=\s*(?:UTF-8'[^']*')?([^;\r\n]+)/i.exec(header);
  if (encodedMatch) {
    const encoded = stripContentDispositionQuotes(encodedMatch[1]);
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  const plainMatch = /filename\s*=\s*([^;\r\n]+)/i.exec(header);
  if (!plainMatch) return undefined;
  return stripContentDispositionQuotes(plainMatch[1]);
}

function stripContentDispositionQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
