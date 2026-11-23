// Spoken-reply unit tests (M4-3): the en-GB voice-selection rule and the
// markdown-to-speech text cleaner. Both are pure functions, so these run
// in the default node environment; the wiring into BrowserSpeechOutput is
// covered in tests/speech-interfaces.test.ts (jsdom).
import { describe, expect, it } from "vitest";
import { selectVoice } from "@/lib/speech/voice-select";
import { cleanTextForSpeech } from "@/lib/speech/text-clean";

function voice(
  name: string,
  lang: string,
  localService = false,
  isDefault = false,
): SpeechSynthesisVoice {
  return {
    name,
    lang,
    localService,
    default: isDefault,
    voiceURI: `urn:${name}`,
  } as SpeechSynthesisVoice;
}

describe("selectVoice (M4-0 rule)", () => {
  it("returns null when the device offers no voices", () => {
    expect(selectVoice([])).toBeNull();
  });

  it("prefers an en-GB voice whose name suggests a male voice", () => {
    const voices = [
      voice("Google UK English Female", "en-GB"),
      voice("Google UK English Male", "en-GB"),
    ];
    expect(selectVoice(voices)?.name).toBe("Google UK English Male");
  });

  it("recognises male given names in en-GB voices", () => {
    const voices = [
      voice("Microsoft Hazel Online", "en-GB"),
      voice("Microsoft George Online", "en-GB"),
    ];
    expect(selectVoice(voices)?.name).toBe("Microsoft George Online");
    expect(
      selectVoice([
        voice("Microsoft Sonia Online", "en-GB"),
        voice("Daniel", "en-GB"),
      ])?.name,
    ).toBe("Daniel");
  });

  it("does not treat Danielle as a male name", () => {
    const voices = [
      voice("Microsoft Danielle Online", "en-GB"),
      voice("Microsoft George Online", "en-GB"),
    ];
    expect(selectVoice(voices)?.name).toBe("Microsoft George Online");
  });

  it("falls back to any en-GB voice when no male voice exists", () => {
    const voices = [
      voice("Google US English", "en-US"),
      voice("Google UK English Female", "en-GB"),
    ];
    expect(selectVoice(voices)?.name).toBe("Google UK English Female");
  });

  it("falls back to any English voice when no en-GB voice exists", () => {
    const voices = [
      voice("Google Deutsch", "de-DE"),
      voice("Google US English", "en-US"),
    ];
    expect(selectVoice(voices)?.name).toBe("Google US English");
  });

  it("an en-GB voice beats an en-US male voice", () => {
    const voices = [
      voice("Google US English Male", "en-US"),
      voice("Google UK English Female", "en-GB"),
    ];
    expect(selectVoice(voices)?.name).toBe("Google UK English Female");
  });

  it("falls back to the browser default when no English voice exists", () => {
    const voices = [
      voice("Google Deutsch", "de-DE"),
      voice("Google français", "fr-FR", false, true),
    ];
    expect(selectVoice(voices)?.name).toBe("Google français");
  });

  it("returns null when no English voice and no default exist", () => {
    expect(selectVoice([voice("Google Deutsch", "de-DE")])).toBeNull();
  });

  it("prefers a local voice within a group", () => {
    const voices = [
      voice("Google UK English Male", "en-GB", false),
      voice("Microsoft George Online", "en-GB", true),
    ];
    expect(selectVoice(voices)?.name).toBe("Microsoft George Online");
  });

  it("accepts en_GB with an underscore and mixed case", () => {
    const voices = [voice("UK Male", "en_GB")];
    expect(selectVoice(voices)?.name).toBe("UK Male");
  });
});

describe("cleanTextForSpeech", () => {
  it("leaves plain text alone apart from whitespace", () => {
    expect(cleanTextForSpeech("  Hello   world.  ")).toBe("Hello world.");
  });

  it("removes fenced code blocks entirely", () => {
    expect(
      cleanTextForSpeech(
        "Here is the code:\n```python\nprint('hi')\n```\nDone.",
      ),
    ).toBe("Here is the code: Done.");
  });

  it("keeps inline-code content without the backticks", () => {
    expect(cleanTextForSpeech("Use `pip install` to install it.")).toBe(
      "Use pip install to install it.",
    );
  });

  it("keeps link text and drops the URL", () => {
    expect(
      cleanTextForSpeech("See the [docs](https://example.com/docs) for more."),
    ).toBe("See the docs for more.");
  });

  it("removes images entirely", () => {
    expect(
      cleanTextForSpeech("A diagram: ![circuit](https://x.co/c.png) below."),
    ).toBe("A diagram: below.");
  });

  it("removes bare URLs", () => {
    expect(
      cleanTextForSpeech("Visit https://example.com or www.example.com now."),
    ).toBe("Visit or now.");
  });

  it("strips bold and italic asterisks", () => {
    expect(
      cleanTextForSpeech("This is **very** *important* news."),
    ).toBe("This is very important news.");
  });

  it("strips headings, quotes and list markers", () => {
    expect(
      cleanTextForSpeech(
        "# Title\n> A quote\n- first\n- second\n1. one\n2. two",
      ),
    ).toBe("Title A quote first second one two");
  });

  it("keeps underscores inside identifiers intact", () => {
    expect(
      cleanTextForSpeech("Call `my_function` and `__init__` next."),
    ).toBe("Call my_function and __init__ next.");
  });

  it("strips HTML tags and decodes common entities", () => {
    expect(
      cleanTextForSpeech("Fish &amp; chips <b>now</b> &lt;tag&gt;"),
    ).toBe("Fish & chips now <tag>");
  });

  it("returns empty text for markdown-only input", () => {
    expect(cleanTextForSpeech("```\ncode\n```\n---")).toBe("");
  });
});
