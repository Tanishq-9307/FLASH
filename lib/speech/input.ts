// Browser speech input (M4-1). Records a clip with MediaRecorder only
// after the owner presses the microphone button, then hands the clip to an
// injected transcribe function (M4-2 posts it to POST /api/speech/transcribe).
// The microphone is never started by this module on its own, and the
// stream tracks are released on every terminal path so the mic indicator
// turns off as soon as recording ends.
//
// Clip limits (TECH_STACK.md §3.5): 60 s recorded in the browser, 2 MB
// accepted by the server, minimum 1 KB. The 60 s cap is enforced here with
// an auto-stop; the size limits are enforced by the server, which is the
// only party that can trust the byte count.
import type {
  SpeechInput,
  SpeechInputError,
  SpeechInputErrorKind,
  SpeechInputEvents,
  SpeechInputState,
} from "./types";

export const MAX_CLIP_SECONDS = 60;
export const MIN_CLIP_BYTES = 1024;

/** Turns a recorded clip into text. Implemented by M4-2 (the server route). */
export type TranscribeFn = (blob: Blob) => Promise<string>;

export function isSpeechInputSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

export class BrowserSpeechInput implements SpeechInput {
  readonly kind = "browser" as const;
  readonly isSupported = true;

  private _state: SpeechInputState = "idle";
  private starting = false;
  private abandoned = false;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private discard = false;
  private capTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private transcribe: TranscribeFn,
    private events: SpeechInputEvents = {},
  ) {}

  get state(): SpeechInputState {
    return this._state;
  }

  start(): void {
    if (this._state !== "idle" || this.starting) return;
    if (!isSpeechInputSupported()) {
      this.fail("unsupported", "Voice input is not available in this browser.");
      return;
    }
    this.starting = true;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        this.starting = false;
        // cancel() may have been called while permission was pending; in
        // that case release the stream and stay idle.
        if (this.abandoned) {
          this.abandoned = false;
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        this.stream = stream;
        this.chunks = [];
        this.discard = false;
        const mimeType = MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : undefined;
        const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        );
        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0) this.chunks.push(event.data);
        };
        recorder.onstop = () => {
          void this.finishRecording();
        };
        recorder.onerror = () => {
          this.fail("unknown", "Recording failed. Try again.");
        };
        this.recorder = recorder;
        recorder.start();
        this.setState("recording");
        this.capTimer = setTimeout(() => {
          this.stop();
        }, MAX_CLIP_SECONDS * 1000);
      })
      .catch((error: unknown) => {
        this.starting = false;
        const name =
          error instanceof DOMException ? error.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          this.fail(
            "permission-denied",
            "Microphone permission was denied. Allow microphone access and try again.",
          );
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          this.fail(
            "unknown",
            "No microphone was found on this device.",
          );
        } else {
          this.fail(
            "unknown",
            "Could not start the microphone. Try again.",
          );
        }
      });
  }

  stop(): void {
    if (this._state !== "recording" || !this.recorder) return;
    this.clearCapTimer();
    this.recorder.stop();
  }

  cancel(): void {
    if (this.starting) {
      this.abandoned = true;
      return;
    }
    if (this._state !== "recording") return;
    this.clearCapTimer();
    this.discard = true;
    this.recorder?.stop();
  }

  private async finishRecording(): Promise<void> {
    const blob = new Blob(this.chunks, {
      type: this.chunks[0]?.type || "audio/webm",
    });
    this.chunks = [];
    this.recorder = null;
    this.releaseStream();
    if (this.discard) {
      this.discard = false;
      this.setState("idle");
      return;
    }
    if (blob.size === 0) {
      this.fail(
        "no-speech",
        "Nothing was recorded. Try speaking closer to the microphone.",
      );
      return;
    }
    this.setState("transcribing");
    try {
      const text = await this.transcribe(blob);
      this.setState("idle");
      this.events.onTranscript?.(text);
    } catch (error: unknown) {
      const kind = (error as { kind?: unknown } | null)?.kind;
      if (kind === "voice-limit-reached") {
        this.fail(
          "voice-limit-reached",
          "Voice limit reached. The monthly speech-to-text allowance is used up.",
        );
      } else if (kind === "too-large") {
        this.fail(
          "too-large",
          "That recording was too long. Keep it under 60 seconds.",
        );
      } else {
        this.fail(
          "transcribe-failed",
          "Could not turn that recording into text. Try again.",
        );
      }
    }
  }

  private fail(kind: SpeechInputErrorKind, message: string): void {
    this.clearCapTimer();
    this.releaseStream();
    this.recorder = null;
    this.discard = false;
    this.starting = false;
    this.abandoned = false;
    this.setState("idle");
    const error: SpeechInputError = { kind, message };
    this.events.onError?.(error);
  }

  private setState(state: SpeechInputState): void {
    this._state = state;
    this.events.onStateChange?.(state);
  }

  private clearCapTimer(): void {
    if (this.capTimer !== null) {
      clearTimeout(this.capTimer);
      this.capTimer = null;
    }
  }

  private releaseStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }
}

export class NullSpeechInput implements SpeechInput {
  readonly kind = "null" as const;
  readonly isSupported = false;
  readonly state: SpeechInputState = "idle";

  constructor(private events: SpeechInputEvents = {}) {}

  start(): void {
    this.events.onError?.({
      kind: "unsupported",
      message: "Voice input is not available in this browser.",
    });
  }

  stop(): void {}

  cancel(): void {}
}

/** Browser implementation when the browser can record, null otherwise. */
export function createSpeechInput(
  transcribe: TranscribeFn,
  events: SpeechInputEvents = {},
): SpeechInput {
  return isSpeechInputSupported()
    ? new BrowserSpeechInput(transcribe, events)
    : new NullSpeechInput(events);
}
