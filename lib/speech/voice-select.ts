// Voice selection (M4-3): the M4-0 rule for spoken replies.
//
// Order: an en-GB voice whose name suggests a male voice → any en-GB
// voice → any English voice → the browser default. Within a group, local
// voices are preferred (a downloaded voice speaks without the network).
//
// The browser exposes no gender for a voice, so "suggests a male voice"
// is a name heuristic only: the word "male", or one of the male given
// names attached to the en-GB voices named in TECH_STACK.md §3.5
// (Microsoft George and Ryan, macOS Daniel). Word boundaries matter:
// "Danielle" must not match "Daniel". If the heuristic picks wrong, the
// fallback is still an en-GB voice, and the choice is re-made on every
// speak() call (lib/speech/output.ts), so a voice that arrives late is
// still picked up.
const MALE_NAME = /\b(male|george|ryan|daniel)\b/i;

function langOf(voice: SpeechSynthesisVoice): string {
  return (voice.lang || "").toLowerCase().replace("_", "-");
}

function isEnGb(voice: SpeechSynthesisVoice): boolean {
  const lang = langOf(voice);
  return lang === "en-gb" || lang.startsWith("en-gb-");
}

function isEnglish(voice: SpeechSynthesisVoice): boolean {
  const lang = langOf(voice);
  return lang === "en" || lang.startsWith("en-");
}

function suggestsMaleVoice(voice: SpeechSynthesisVoice): boolean {
  return MALE_NAME.test(voice.name || "");
}

/** First voice in the group, preferring a local (downloaded) one. */
function preferLocal(
  group: SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  if (group.length === 0) return null;
  return group.find((voice) => voice.localService) ?? group[0];
}

/**
 * Picks the voice for a spoken reply from what this device offers, per
 * the M4-0 rule. Returns null when nothing matches — the browser then
 * uses its own default voice.
 */
export function selectVoice(
  voices: SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  const enGb = voices.filter(isEnGb);
  const male = preferLocal(enGb.filter(suggestsMaleVoice));
  if (male) return male;
  const anyGb = preferLocal(enGb);
  if (anyGb) return anyGb;
  const anyEnglish = preferLocal(voices.filter(isEnglish));
  if (anyEnglish) return anyEnglish;
  return voices.find((voice) => voice.default) ?? null;
}
