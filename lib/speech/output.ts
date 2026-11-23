// Browser spoken replies (M4-1, wired in M4-3). Wraps the browser's free
// speechSynthesis: speak() interrupts anything currently speaking, picks a
// voice through the injected selector (default: the M4-0 en-GB rule in
// lib/speech/voice-select.ts), and prepares the text through the injected
// function (default: the M4-3 markdown/URL cleaner in
// lib/speech/text-clean.ts). Rate and pitch are constructor settings.
//
// Voices load asynchronously in some browsers (getVoices() is empty until
// the voiceschanged event), so the selector runs fresh on every speak() —
// a voice that arrives late is still picked up.
import type {
  SpeechOutput,
  SpeechOutputError,
  SpeechOutputErrorKind,
  SpeechOutputEvents,
  SpeechOutputState,
} from "./types";
import { selectVoice as defaultSelectVoice } from "./voice-select";
import { cleanTextForSpeech } from "./text-clean";

/** Picks the voice for a reply from what this device offers. */
export type VoiceSelector = (
  voices: SpeechSynthesisVoice[],
) => SpeechSynthesisVoice | null;

/** Turns reply text into speakable text (M4-3 cleans markdown and URLs). */
export type PrepareText = (text: string) => string;

export function isSpeechOutputSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined"
  );
}

export interface SpeechOutputOptions {
  rate?: number;
  pitch?: number;
}

export class BrowserSpeechOutput implements SpeechOutput {
  readonly kind = "browser" as const;
  readonly isSupported = true;

  private _state: SpeechOutputState = "idle";

  constructor(
    private selectVoice: VoiceSelector = defaultSelectVoice,
    private prepareText: PrepareText = cleanTextForSpeech,
    private events: SpeechOutputEvents = {},
    private options: SpeechOutputOptions = {},
  ) {}

  get state(): SpeechOutputState {
    return this._state;
  }

  speak(text: string): void {
    if (!isSpeechOutputSupported()) {
      this.fail(
        "unsupported",
        "Spoken replies are not available in this browser.",
      );
      return;
    }
    const synth = window.speechSynthesis;
    // Interrupt: a new reply or a new user message always wins over the
    // audio still playing.
    synth.cancel();
    const clean = this.prepareText(text);
    if (clean.trim() === "") return;
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.voice = this.selectVoice(synth.getVoices());
    utterance.rate = this.options.rate ?? 1;
    utterance.pitch = this.options.pitch ?? 1;
    utterance.onend = () => {
      this.setState("idle");
    };
    utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
      // cancel() from stop() or from a new speak() fires "canceled" /
      // "interrupted" on the old utterance — that is the interrupt working,
      // not a failure, so it stays silent.
      if (event.error === "canceled" || event.error === "interrupted") {
        this.setState("idle");
        return;
      }
      this.fail("speak-failed", "Could not speak that reply. Try again.");
    };
    this.setState("speaking");
    synth.speak(utterance);
  }

  stop(): void {
    if (!isSpeechOutputSupported()) return;
    window.speechSynthesis.cancel();
    this.setState("idle");
  }

  isSpeaking(): boolean {
    return isSpeechOutputSupported() && window.speechSynthesis.speaking;
  }

  private fail(kind: SpeechOutputErrorKind, message: string): void {
    this.setState("idle");
    const error: SpeechOutputError = { kind, message };
    this.events.onError?.(error);
  }

  private setState(state: SpeechOutputState): void {
    this._state = state;
    this.events.onStateChange?.(state);
  }
}

export class NullSpeechOutput implements SpeechOutput {
  readonly kind = "null" as const;
  readonly isSupported = false;
  readonly state: SpeechOutputState = "idle";

  constructor(private events: SpeechOutputEvents = {}) {}

  speak(_text: string): void {
    // Null implementation: the text is accepted (interface contract) and
    // discarded — there is no speech engine to send it to.
    void _text;
    this.events.onError?.({
      kind: "unsupported",
      message: "Spoken replies are not available in this browser.",
    });
  }

  stop(): void {}

  isSpeaking(): boolean {
    return false;
  }
}

/** Browser implementation when the browser can speak, null otherwise. */
/** Defaults are the M4-0 voice rule and the M4-3 text cleaner. */
export function createSpeechOutput(
  selectVoice: VoiceSelector = defaultSelectVoice,
  prepareText: PrepareText = cleanTextForSpeech,
  events: SpeechOutputEvents = {},
  options: SpeechOutputOptions = {},
): SpeechOutput {
  return isSpeechOutputSupported()
    ? new BrowserSpeechOutput(selectVoice, prepareText, events, options)
    : new NullSpeechOutput(events);
}
