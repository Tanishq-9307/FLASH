// ElevenLabs Scribe speech-to-text (M4-2, server-only). The browser never
// calls ElevenLabs directly: the API key stays on the server, and the route
// (app/api/speech/transcribe/route.ts) checks the session and the clip
// before this runs.
//
// Provider contract: POST https://api.elevenlabs.io/v1/speech-to-text with
// the `xi-api-key` header and multipart form fields `file` (the clip) and
// `model_id` = `scribe_v2`. No `language_code` is sent — Scribe
// auto-detects the language (TECH_STACK.md §3.5). The free plan includes
// about 4 h 30 min of Scribe v2 per month; when it runs out ElevenLabs
// answers 402, which surfaces as "voice-limit-reached".
import "server-only";

export type ElevenLabsErrorKind =
  | "voice-limit-reached"
  | "provider-error"
  | "provider-misconfigured";

export class ElevenLabsError extends Error {
  readonly kind: ElevenLabsErrorKind;

  constructor(kind: ElevenLabsErrorKind, message: string) {
    super(message);
    this.name = "ElevenLabsError";
    this.kind = kind;
  }
}

const SPEECH_TO_TEXT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
export const SCRIBE_MODEL_ID = "scribe_v2";

/** Minimal fetch shape: injectable so tests can pass a fake. */
export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** Sends a recorded clip to ElevenLabs Scribe and returns the transcript. */
export async function transcribeWithElevenLabs(
  audio: Blob,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new ElevenLabsError(
      "provider-misconfigured",
      "ELEVENLABS_API_KEY is not set.",
    );
  }
  const form = new FormData();
  form.append("file", audio, "clip.webm");
  form.append("model_id", SCRIBE_MODEL_ID);
  let res: Response;
  try {
    res = await fetchImpl(SPEECH_TO_TEXT_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
  } catch {
    throw new ElevenLabsError(
      "provider-error",
      "ElevenLabs speech-to-text is unreachable.",
    );
  }
  if (!res.ok) {
    // 402 = the free allowance is used up; 429 = rate-limited. Both mean
    // the user cannot transcribe right now, not that the clip was bad.
    if (res.status === 402 || res.status === 429) {
      throw new ElevenLabsError(
        "voice-limit-reached",
        "Voice limit reached. The monthly speech-to-text allowance is used up.",
      );
    }
    throw new ElevenLabsError(
      "provider-error",
      `ElevenLabs speech-to-text failed (${res.status}).`,
    );
  }
  const data = (await res.json()) as { text?: unknown };
  if (typeof data.text !== "string") {
    throw new ElevenLabsError(
      "provider-error",
      "ElevenLabs returned no transcript.",
    );
  }
  return data.text;
}
