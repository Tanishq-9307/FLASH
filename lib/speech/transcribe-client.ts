// Client wrapper for POST /api/speech/transcribe (M4-2). This is the
// TranscribeFn the chat UI (UI pass) hands to BrowserSpeechInput: it posts
// the recorded clip to our own server route, which checks the session and
// the clip and then calls ElevenLabs Scribe. The browser never sees the
// ElevenLabs key.
//
// Route errors are rethrown with the same `kind` the input interface
// understands, so BrowserSpeechInput maps them to its error states
// (voice-limit-reached, too-large) without knowing about HTTP at all.
import type { SpeechInputErrorKind } from "./types";
import type { TranscribeFn } from "./input";

function kinded(kind: SpeechInputErrorKind, message: string): Error & {
  kind: SpeechInputErrorKind;
} {
  return Object.assign(new Error(message), { kind });
}

export async function transcribeClip(audio: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", audio, "clip.webm");
  const res = await fetch("/api/speech/transcribe", {
    method: "POST",
    body: form,
  });
  if (res.ok) {
    const data = (await res.json()) as { text?: unknown };
    if (typeof data.text === "string") return data.text;
    throw kinded("transcribe-failed", "Transcription returned no text.");
  }
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  if (body?.error === "voice-limit-reached") {
    throw kinded(
      "voice-limit-reached",
      "Voice limit reached. The monthly speech-to-text allowance is used up.",
    );
  }
  if (body?.error === "too-large") {
    throw kinded(
      "too-large",
      "That recording was too large. Keep it under 60 seconds.",
    );
  }
  throw kinded("transcribe-failed", "Transcription failed. Try again.");
}

/** The TranscribeFn for BrowserSpeechInput (wired into the composer in the UI pass). */
export const transcribeViaServer: TranscribeFn = transcribeClip;
