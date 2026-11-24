// Conversation list types and validation (M2-7, DATABASE.md §3.3).
// The title limit (255) is the database CHECK on conversations.title;
// the Zod schema enforces the same limit on the server before the
// database ever sees the value, and rejects an empty title (the CHECK
// alone would allow one).
import { z } from "zod";

/** Longest title the database accepts (conversations.title CHECK). */
export const MAX_TITLE_CHARS = 255;

export const conversationIdSchema = z.string().uuid();

export const conversationTitleSchema = z
  .string()
  .trim()
  .min(1, "Title must not be empty.")
  .max(MAX_TITLE_CHARS, `Title must be ${MAX_TITLE_CHARS} characters or fewer.`);

/** One row of the conversation list, ordered by updated_at. */
export type ConversationSummary = {
  id: string;
  title: string;
  updated_at: string;
};
