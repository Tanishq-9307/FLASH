// POST /api/speech/transcribe (M4-2): speech-to-text through ElevenLabs
// Scribe. The browser records a clip with MediaRecorder only after the
// owner presses the microphone button, then posts it here as multipart
// form data (`audio`).
//
// Order of operations:
// 1. Verify the session with getUser(). Unauthenticated → 401, and the
//    clip is never sent to the provider.
// 2. Validate the clip: it must be an audio file between 1 KB and 2 MB
//    (M4-0 limits). Missing / wrong-type / too-small → 400 invalid-clip;
//    too large → 413 too-large.
// 3. Send it to ElevenLabs Scribe (lib/speech/elevenlabs.ts, scribe_v2,
//    language auto-detected). Provider 402/429 → 429 voice-limit-reached;
//    any other provider failure → 502 provider-error.
// 4. Return { text }.
//
// No model-cap reservation: transcription is not a model call, and the
// daily cap of 20 governs Gemini replies only. The free Scribe allowance
// (about 4 h 30 min/month) is the backstop; ElevenLabs refuses when it
// runs out. CSP needs: none — the browser only fetches this same-origin
// route; ElevenLabs is called server-side.
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import {
  ElevenLabsError,
  transcribeWithElevenLabs,
} from "@/lib/speech/elevenlabs";
import { MAX_CLIP_BYTES, MIN_CLIP_BYTES } from "@/lib/speech/types";

export const maxDuration = 60;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid-clip" }, { status: 400 });
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob)) {
    return NextResponse.json({ error: "invalid-clip" }, { status: 400 });
  }
  if (!audio.type.startsWith("audio/")) {
    return NextResponse.json({ error: "invalid-clip" }, { status: 400 });
  }
  if (audio.size < MIN_CLIP_BYTES) {
    return NextResponse.json({ error: "invalid-clip" }, { status: 400 });
  }
  if (audio.size > MAX_CLIP_BYTES) {
    return NextResponse.json({ error: "too-large" }, { status: 413 });
  }

  try {
    const text = await transcribeWithElevenLabs(audio);
    return NextResponse.json({ text });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      if (err.kind === "voice-limit-reached") {
        return NextResponse.json(
          { error: "voice-limit-reached" },
          { status: 429 },
        );
      }
      if (err.kind === "provider-misconfigured") {
        return NextResponse.json(
          { error: "provider-misconfigured" },
          { status: 500 },
        );
      }
      return NextResponse.json({ error: "provider-error" }, { status: 502 });
    }
    throw err;
  }
}
