// Text cleaning for spoken replies (M4-3). Assistant replies are
// markdown, and reading the markup aloud is unintelligible ("asterisk
// asterisk bold asterisk asterisk"), so the reply is turned into plain
// speakable text before speechSynthesis sees it.
//
// What is removed: fenced code blocks (a code listing is not speakable),
// images, bare URLs, markdown markers, headings/quotes/list markers,
// horizontal rules, HTML tags. What is kept: the words — link text
// (without the URL), inline-code content (without the backticks), and
// plain text.
//
// Deliberate exception: underscores are NOT stripped. `_italic_` and
// `__bold__` markers are ambiguous with identifiers (`snake_case`,
// `__init__`), and corrupting an identifier is worse than hearing an
// underscore. Asterisk emphasis is stripped because `*` is rare inside
// words.
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Turns a markdown reply into plain text fit for speechSynthesis. */
export function cleanTextForSpeech(text: string): string {
  let clean = text;
  // Fenced code blocks first, so markdown inside them is not processed.
  clean = clean.replace(/```[\s\S]*?```/g, " ");
  // Images carry no speakable text.
  clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  // Links keep their text, lose the URL.
  clean = clean.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Inline code keeps its content, loses the backticks.
  clean = clean.replace(/`([^`]*)`/g, "$1");
  // Bold then italic (asterisks only — see the header note on underscores).
  clean = clean.replace(/\*\*([^*]+)\*\*/g, "$1");
  clean = clean.replace(/\*([^*]+)\*/g, "$1");
  clean = clean.replace(/~~([^~]+)~~/g, "$1");
  // Headings, blockquotes, list markers, horizontal rules.
  clean = clean.replace(/^#{1,6}\s+/gm, "");
  clean = clean.replace(/^>\s?/gm, "");
  clean = clean.replace(/^\s*[-*+]\s+/gm, "");
  clean = clean.replace(/^\s*\d+[.)]\s+/gm, "");
  clean = clean.replace(/^[-*_]{3,}\s*$/gm, " ");
  // Bare URLs, then any HTML tags.
  clean = clean.replace(/https?:\/\/\S+/g, " ");
  clean = clean.replace(/www\.\S+/g, " ");
  clean = clean.replace(/<[^>]+>/g, " ");
  // Common HTML entities.
  for (const [entity, replacement] of Object.entries(ENTITIES)) {
    clean = clean.split(entity).join(replacement);
  }
  // Collapse whitespace and trim.
  return clean.replace(/\s+/g, " ").trim();
}
