/**
 * Baut eindeutige Dateinamen für heruntergeladene Opencast-Aufzeichnungen.
 *
 * Reine Funktion ohne Seiteneffekte: `usedNames` wird nur gelesen, nie hier
 * befüllt — der Aufrufer entscheidet, wann ein zurückgegebener Name als
 * "verbraucht" gilt (z. B. erst nach erfolgreichem Download).
 */

import type { OpencastRecording } from "./parsers/recordings";

/** lowercase, nicht-alphanumerisch → "-", mehrfache "-" kollabieren, trimmen. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildRecordingFilename(
  recording: OpencastRecording,
  usedNames: Set<string>
): string {
  const slug = slugify(recording.title || "") || `recording-${recording.cmid}`;

  const base = `${slug}.mp4`;
  if (!usedNames.has(base)) return base;

  // Primärer Diskriminator: die ersten 8 Zeichen der Episode-UUID.
  if (recording.episode_id) {
    const shortId = recording.episode_id.slice(0, 8);
    const withDiscriminator = `${slug}-${shortId}.mp4`;
    if (!usedNames.has(withDiscriminator)) return withDiscriminator;
  }

  // Fallback: numerischer Zähler, solange bis ein freier Name gefunden wird.
  let counter = 2;
  let candidate = `${slug}-${counter}.mp4`;
  while (usedNames.has(candidate)) {
    counter++;
    candidate = `${slug}-${counter}.mp4`;
  }
  return candidate;
}
