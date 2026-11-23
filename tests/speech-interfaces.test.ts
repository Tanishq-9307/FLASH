// @vitest-environment jsdom
// Speech provider interface tests (M4-1): null implementations, feature
// detection, browser input with a fake MediaRecorder, browser output with a
// fake speechSynthesis, and a fake provider proving the interfaces are
// usable without a browser at all. jsdom implements none of MediaRecorder,
// getUserMedia, speechSynthesis or SpeechSynthesisUtterance, so all four
// are faked here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSpeechInput,
  NullSpeechInput,
  createSpeechInput,
  isSpeechInputSupported,
} from "@/lib/speech/input";
import {
  BrowserSpeechOutput,
  NullSpeechOutput,
  createSpeechOutput,
  isSpeechOutputSupported,
} from "@/lib/speech/output";
import type {
  SpeechInput,
  SpeechInputEvents,
  SpeechOutput,
  SpeechOutputEvents,
} from "@/lib/speech/types";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function voice(
  name: string,
  lang: string,
  localService = false,
): SpeechSynthesisVoice {
  return {
    name,
    lang,
    localService,
    default: false,
    voiceURI: `urn:${name}`,
  } as SpeechSynthesisVoice;
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  started = false;

  constructor(
    public stream: unknown,
    public options?: unknown,
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.onstop?.();
  }

  emitData(data: Blob): void {
    this.ondataavailable?.({ data });
  }
}

class FakeUtterance {
  voice: SpeechSynthesisVoice | null = null;
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(public text: string) {}
}

function fakeStream() {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track], track };
}

function installMediaFakes(getUserMediaImpl: () => Promise<unknown>) {
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(getUserMediaImpl) },
    configurable: true,
  });
}

function installSynthFake() {
  const spoken: FakeUtterance[] = [];
  const synth = {
    spoken,
    speaking: false,
    getVoices: () => [
      voice("Google UK English Male", "en-GB"),
      voice("Google UK English Female", "en-GB"),
    ],
    speak: vi.fn((utterance: FakeUtterance) => {
      spoken.push(utterance);
    }),
    cancel: vi.fn(),
  };
  Object.defineProperty(window, "speechSynthesis", {
    value: synth,
    configurable: true,
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
  );
  return synth;
}

describe("null implementations", () => {
  it("null input reports unsupported with a clear message and never records", () => {
    const events: SpeechInputEvents = {
      onError: vi.fn(),
      onStateChange: vi.fn(),
      onTranscript: vi.fn(),
    };
    const input = new NullSpeechInput(events);
    expect(input.kind).toBe("null");
    expect(input.isSupported).toBe(false);
    expect(input.state).toBe("idle");
    input.start();
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unsupported",
        message: expect.stringContaining("not available in this browser"),
      }),
    );
    expect(() => {
      input.stop();
      input.cancel();
    }).not.toThrow();
    expect(input.state).toBe("idle");
    expect(events.onTranscript).not.toHaveBeenCalled();
  });

  it("null output reports unsupported with a clear message and never speaks", () => {
    const events: SpeechOutputEvents = {
      onError: vi.fn(),
      onStateChange: vi.fn(),
    };
    const output = new NullSpeechOutput(events);
    expect(output.kind).toBe("null");
    expect(output.isSupported).toBe(false);
    expect(output.isSpeaking()).toBe(false);
    output.speak("hello");
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unsupported",
        message: expect.stringContaining("not available in this browser"),
      }),
    );
    expect(() => output.stop()).not.toThrow();
  });
});

describe("feature detection", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // defineProperty'd fakes are not removed by unstubAllGlobals.
    delete (window as unknown as Record<string, unknown>).speechSynthesis;
    delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  });

  it("reports unsupported when the browser has no speech APIs", () => {
    expect(isSpeechInputSupported()).toBe(false);
    expect(isSpeechOutputSupported()).toBe(false);
    const input = createSpeechInput(async () => "", {});
    const output = createSpeechOutput(() => null, (t) => t, {});
    expect(input.kind).toBe("null");
    expect(output.kind).toBe("null");
  });

  it("reports supported once the fakes are installed", () => {
    installMediaFakes(async () => fakeStream());
    installSynthFake();
    expect(isSpeechInputSupported()).toBe(true);
    expect(isSpeechOutputSupported()).toBe(true);
  });
});

describe("BrowserSpeechInput", () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).speechSynthesis;
    delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  });

  it("records, transcribes, and reports the transcript with state changes", async () => {
    const stream = fakeStream();
    installMediaFakes(async () => stream);
    let captured: Blob | undefined;
    const transcribe = vi.fn(async (blob: Blob) => {
      captured = blob;
      return "hello world";
    });
    const events: SpeechInputEvents = {
      onTranscript: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
    };
    const input = new BrowserSpeechInput(transcribe, events);
    input.start();
    await flush();
    expect(input.state).toBe("recording");
    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder.started).toBe(true);
    recorder.emitData(new Blob(["x".repeat(2048)], { type: "audio/webm" }));
    input.stop();
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(captured?.size).toBe(2048);
    expect(events.onTranscript).toHaveBeenCalledWith("hello world");
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onStateChange).toHaveBeenCalledWith("recording");
    expect(events.onStateChange).toHaveBeenCalledWith("transcribing");
    expect(events.onStateChange).toHaveBeenCalledWith("idle");
    expect(input.state).toBe("idle");
    expect(stream.track.stop).toHaveBeenCalled();
  });

  it("reports permission-denied when the microphone is refused", async () => {
    installMediaFakes(async () => {
      const error = new DOMException("denied", "NotAllowedError");
      throw error;
    });
    const transcribe = vi.fn(async () => "");
    const events: SpeechInputEvents = { onError: vi.fn() };
    const input = new BrowserSpeechInput(transcribe, events);
    input.start();
    await flush();
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "permission-denied" }),
    );
    expect(transcribe).not.toHaveBeenCalled();
    expect(input.state).toBe("idle");
  });

  it("reports no-speech when nothing was recorded", async () => {
    installMediaFakes(async () => fakeStream());
    const transcribe = vi.fn(async () => "");
    const events: SpeechInputEvents = { onError: vi.fn() };
    const input = new BrowserSpeechInput(transcribe, events);
    input.start();
    await flush();
    input.stop();
    await flush();
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "no-speech" }),
    );
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("cancel discards the clip without transcribing", async () => {
    installMediaFakes(async () => fakeStream());
    const transcribe = vi.fn(async () => "should not happen");
    const events: SpeechInputEvents = {
      onTranscript: vi.fn(),
      onError: vi.fn(),
    };
    const input = new BrowserSpeechInput(transcribe, events);
    input.start();
    await flush();
    FakeMediaRecorder.instances[0].emitData(
      new Blob(["x".repeat(2048)], { type: "audio/webm" }),
    );
    input.cancel();
    await flush();
    expect(transcribe).not.toHaveBeenCalled();
    expect(events.onTranscript).not.toHaveBeenCalled();
    expect(input.state).toBe("idle");
  });

  it("cancel while permission is pending abandons the stream", async () => {
    const stream = fakeStream();
    let resolveMic: (value: unknown) => void = () => {};
    installMediaFakes(
      () =>
        new Promise((resolve) => {
          resolveMic = resolve;
        }),
    );
    const transcribe = vi.fn(async () => "");
    const input = new BrowserSpeechInput(transcribe, {});
    input.start();
    input.cancel();
    resolveMic(stream);
    await flush();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(stream.track.stop).toHaveBeenCalled();
    expect(input.state).toBe("idle");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("a second start while recording is ignored", async () => {
    installMediaFakes(async () => fakeStream());
    const getUserMedia = (
      navigator.mediaDevices as unknown as { getUserMedia: ReturnType<typeof vi.fn> }
    ).getUserMedia;
    const input = new BrowserSpeechInput(async () => "", {});
    input.start();
    input.start();
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    input.cancel();
    await flush();
  });

  it("maps a transcribe failure to transcribe-failed", async () => {
    installMediaFakes(async () => fakeStream());
    const transcribe = vi.fn(async () => {
      throw new Error("boom");
    });
    const events: SpeechInputEvents = { onError: vi.fn() };
    const input = new BrowserSpeechInput(transcribe, events);
    input.start();
    await flush();
    FakeMediaRecorder.instances[0].emitData(
      new Blob(["x".repeat(2048)], { type: "audio/webm" }),
    );
    input.stop();
    await flush();
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "transcribe-failed" }),
    );
    expect(input.state).toBe("idle");
  });

  it("maps a voice-limit transcribe error to voice-limit-reached", async () => {
    installMediaFakes(async () => fakeStream());
    const transcribe = vi.fn(async () => {
      const error = new Error("quota") as Error & { kind: string };
      error.kind = "voice-limit-reached";
      throw error;
    });
    const events: SpeechInputEvents = { onError: vi.fn() };
    const input = new BrowserSpeechInput(transcribe, events);
    input.start();
    await flush();
    FakeMediaRecorder.instances[0].emitData(
      new Blob(["x".repeat(2048)], { type: "audio/webm" }),
    );
    input.stop();
    await flush();
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "voice-limit-reached" }),
    );
  });

  it("auto-stops at the 60 second cap and still transcribes", async () => {
    vi.useFakeTimers();
    installMediaFakes(async () => fakeStream());
    const transcribe = vi.fn(async () => "capped");
    const events: SpeechInputEvents = { onTranscript: vi.fn() };
    const input = new BrowserSpeechInput(transcribe, events);
    input.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeMediaRecorder.instances[0].emitData(
      new Blob(["x".repeat(2048)], { type: "audio/webm" }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(events.onTranscript).toHaveBeenCalledWith("capped");
  });
});

describe("BrowserSpeechOutput", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).speechSynthesis;
    delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  });

  it("speaks with the selected voice, rate and pitch", () => {
    const synth = installSynthFake();
    const selector = vi.fn((voices: SpeechSynthesisVoice[]) => voices[1]);
    const events: SpeechOutputEvents = { onStateChange: vi.fn() };
    const output = new BrowserSpeechOutput(selector, (t) => t, events, {
      rate: 1.1,
      pitch: 0.9,
    });
    output.speak("hello there");
    expect(synth.speak).toHaveBeenCalledTimes(1);
    const utterance = synth.spoken[0];
    expect(utterance.text).toBe("hello there");
    expect(utterance.voice?.name).toBe("Google UK English Female");
    expect(utterance.rate).toBe(1.1);
    expect(utterance.pitch).toBe(0.9);
    expect(output.state).toBe("speaking");
    utterance.onend?.();
    expect(output.state).toBe("idle");
    expect(events.onStateChange).toHaveBeenCalledWith("speaking");
    expect(events.onStateChange).toHaveBeenCalledWith("idle");
  });

  it("interrupts current speech when speak is called again", () => {
    const synth = installSynthFake();
    const output = new BrowserSpeechOutput(() => null);
    output.speak("first");
    output.speak("second");
    // Each speak() cancels first (the second speak's cancel is the
    // interrupt), so two speaks mean two cancels.
    expect(synth.cancel).toHaveBeenCalledTimes(2);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.spoken[1].text).toBe("second");
  });

  it("stop cancels speech and returns to idle", () => {
    const synth = installSynthFake();
    const output = new BrowserSpeechOutput(() => null);
    output.speak("hello");
    output.stop();
    expect(synth.cancel).toHaveBeenCalled();
    expect(output.state).toBe("idle");
  });

  it("speaking nothing is a no-op", () => {
    const synth = installSynthFake();
    const output = new BrowserSpeechOutput(() => null);
    output.speak("   ");
    expect(synth.speak).not.toHaveBeenCalled();
    expect(output.state).toBe("idle");
  });

  it("a canceled utterance is silent; other errors report speak-failed", () => {
    installSynthFake();
    const events: SpeechOutputEvents = { onError: vi.fn() };
    const output = new BrowserSpeechOutput(() => null, (t) => t, events);
    const synth = window.speechSynthesis as unknown as {
      spoken: FakeUtterance[];
    };
    output.speak("hello");
    const utterance = synth.spoken[0];
    utterance.onerror?.({ error: "canceled" });
    expect(events.onError).not.toHaveBeenCalled();
    expect(output.state).toBe("idle");
    output.speak("again");
    synth.spoken[1].onerror?.({ error: "synthesis-failed" });
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "speak-failed" }),
    );
  });

  it("reports unsupported when speechSynthesis is absent", () => {
    const events: SpeechOutputEvents = { onError: vi.fn() };
    const output = new BrowserSpeechOutput(() => null, (t) => t, events);
    output.speak("hello");
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "unsupported" }),
    );
    expect(output.isSpeaking()).toBe(false);
  });
});

describe("fake provider", () => {
  it("the interfaces are usable with a scripted fake", () => {
    const calls: string[] = [];
    const fakeInput: SpeechInput = {
      kind: "browser",
      isSupported: true,
      state: "idle",
      start: () => {
        calls.push("start");
      },
      stop: () => {
        calls.push("stop");
      },
      cancel: () => {
        calls.push("cancel");
      },
    };
    const fakeOutput: SpeechOutput = {
      kind: "browser",
      isSupported: true,
      state: "idle",
      speak: (text: string) => {
        calls.push(`speak:${text}`);
      },
      stop: () => {
        calls.push("stop-speaking");
      },
      isSpeaking: () => false,
    };
    fakeInput.start();
    fakeInput.stop();
    fakeOutput.speak("hi");
    fakeOutput.stop();
    expect(calls).toEqual(["start", "stop", "speak:hi", "stop-speaking"]);
    // The factories return the null implementations when nothing is present.
    expect(createSpeechInput(async () => "", {}).kind).toBe("null");
  });
});
