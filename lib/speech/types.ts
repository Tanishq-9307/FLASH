// Speech provider interfaces (M4-1). Speech sits behind interfaces so the
// browser implementation can be swapped — a cloud voice later, a null
// implementation where the browser cannot do it — without touching the
// callers. ARCHITECTURE.md §2 (external adapters).
//
// The microphone starts only when start() is called — never on its own
// (PRD.md §5.7). Spoken replies are the browser's free speechSynthesis;
// the voice-selection rule lives in lib/speech/voice-select.ts (M4-3).

export type SpeechInputState = "idle" | "recording" | "transcribing";

export type SpeechInputErrorKind =
  | "permission-denied"
  | "no-speech"
  | "too-long"
  | "too-large"
  | "transcribe-failed"
  | "voice-limit-reached"
  | "unsupported"
  | "unknown";

export interface SpeechInputError {
  kind: SpeechInputErrorKind;
  message: string;
}

export interface SpeechInputEvents {
  onTranscript?: (text: string) => void;
  onStateChange?: (state: SpeechInputState) => void;
  onError?: (error: SpeechInputError) => void;
}

/**
 * Records audio and delivers a transcript. The transcript comes from the
 * injected transcribe function (M4-2 posts the clip to
 * POST /api/speech/transcribe); this interface never touches the network
 * itself, so it stays testable with a fake.
 */
export interface SpeechInput {
  readonly kind: "browser" | "null";
  readonly isSupported: boolean;
  readonly state: SpeechInputState;
  start(): void;
  stop(): void;
  cancel(): void;
}

export type SpeechOutputState = "idle" | "speaking";

export type SpeechOutputErrorKind = "unsupported" | "speak-failed" | "unknown";

export interface SpeechOutputError {
  kind: SpeechOutputErrorKind;
  message: string;
}

export interface SpeechOutputEvents {
  onStateChange?: (state: SpeechOutputState) => void;
  onError?: (error: SpeechOutputError) => void;
}

/**
 * Speaks text aloud. speak() interrupts anything currently speaking, so a
 * new reply or a new user message always wins over the old audio.
 */
export interface SpeechOutput {
  readonly kind: "browser" | "null";
  readonly isSupported: boolean;
  readonly state: SpeechOutputState;
  speak(text: string): void;
  stop(): void;
  isSpeaking(): boolean;
}
