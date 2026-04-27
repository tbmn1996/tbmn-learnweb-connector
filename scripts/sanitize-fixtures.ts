import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const RAW_DIR = path.resolve("test/fixtures/learnweb/raw");
const FIXTURE_DIR = path.resolve("test/fixtures/learnweb");

const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const tokenRe = /(sesskey|logintoken|authtoken)=([^&"'<>]+)/gi;
const cookieRe = /(MoodleSession\w*|MOODLEID\w*)=([^;"'\s<>]+)/gi;

class StableMap {
  private values = new Map<string, string>();

  get(value: string, prefix: string): string {
    const existing = this.values.get(value);
    if (existing) return existing;
    const next = `${prefix} ${String.fromCharCode(65 + this.values.size)}`;
    this.values.set(value, next);
    return next;
  }
}

const courseNames = new StableMap();
const eventNames = new StableMap();

function redactText(input: string): string {
  return input
    .replace(emailRe, "user@example.test")
    .replace(tokenRe, "$1=REDACTED")
    .replace(cookieRe, "$1=REDACTED")
    .replace(/"sesskey"\s*:\s*"[^"]+"/gi, '"sesskey":"REDACTED"')
    .replace(/"wwwroot"\s*:\s*"([^"]+)"/gi, '"wwwroot":"https://learnweb.example.test"')
    .replace(/https:\/\/www\.uni-muenster\.de\/LearnWeb\/learnweb2/gi, "https://learnweb.example.test")
    .replace(/https:\/\/[^"'\s<>]+\/LearnWeb\/learnweb2/gi, "https://learnweb.example.test");
}

function sanitizeId(value: unknown, fallback: number): number | undefined {
  if (value == null) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return fallback;
}

function sanitizeAjax(raw: string): string {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return JSON.stringify(parsed, null, 2);
  const first = parsed[0];
  if (!first || typeof first !== "object") return JSON.stringify(parsed, null, 2);

  const result = { ...(first as Record<string, unknown>) };
  const data = result.data && typeof result.data === "object"
    ? { ...(result.data as Record<string, unknown>) }
    : undefined;
  if (data && Array.isArray(data.events)) {
    data.events = data.events.slice(0, 3).map((rawEvent: unknown, index: number) => {
      const event = { ...(rawEvent as Record<string, unknown>) };
      event.id = sanitizeId(event.id, 9000 + index);
      event.instance = sanitizeId(event.instance, 4000 + index);
      event.name = eventNames.get(String(event.name ?? `Event ${index + 1}`), "Event");
      if (event.url && typeof event.url === "string") {
        event.url = event.url.replace(/id=\d+/g, `id=${4000 + index}`);
      }
      if (event.action && typeof event.action === "object") {
        const action = { ...(event.action as Record<string, unknown>) };
        if (typeof action.url === "string") {
          action.url = action.url.replace(/id=\d+/g, `id=${4000 + index}`);
        }
        event.action = action;
      }
      if (event.course && typeof event.course === "object") {
        const course = { ...(event.course as Record<string, unknown>) };
        course.id = sanitizeId(course.id, 7000 + index);
        course.fullname = courseNames.get(String(course.fullname ?? `Course ${index + 1}`), "Course");
        event.course = course;
      }
      return event;
    });
    result.data = data;
  }

  return `${JSON.stringify([result], null, 2)}\n`;
}

async function tryRead(relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(RAW_DIR, relativePath), "utf8");
  } catch {
    return null;
  }
}

async function main() {
  await mkdir(FIXTURE_DIR, { recursive: true });

  const month = await tryRead("calendar-month-current.html");
  if (month) {
    await writeFile(path.join(FIXTURE_DIR, "calendar-month-with-events.html"), redactText(month), "utf8");
  }

  const ajax = await tryRead("calendar-ajax-action-events.json");
  if (ajax) {
    const sanitized = sanitizeAjax(redactText(ajax));
    const parsed = JSON.parse(ajax);
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    const target = first?.error || first?.exception
      ? "calendar-ajax-error-shape.json"
      : "calendar-ajax-success.json";
    await writeFile(path.join(FIXTURE_DIR, target), sanitized, "utf8");
  }

  const report = await tryRead("capture-report.json");
  if (report) {
    await writeFile(path.join(FIXTURE_DIR, "capture-report.sanitized.json"), redactText(report), "utf8");
  }

  console.log(`Sanitized fixtures written to ${FIXTURE_DIR}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
