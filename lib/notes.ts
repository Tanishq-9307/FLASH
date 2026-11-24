// Notes rules (M2-8b, DATABASE.md §3.6). Validation limits equal the
// database CHECKs: title 1–255 characters, content at most 100,000
// characters. Search queries are 1–200 characters. Free of Next.js and
// Supabase imports so the pure schemas can be unit-tested without mocks.
import { z } from "zod";

/** DATABASE.md §3.6: notes.title CHECK (<= 255), content CHECK (<= 100,000). */
export const MAX_NOTE_TITLE = 255;
export const MAX_NOTE_CONTENT = 100_000;
/** Longest search query the search action accepts. */
export const MAX_SEARCH_CHARS = 200;
/** Most rows a list or search ever returns. */
export const NOTES_LIMIT = 200;

export type Note = {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
};

export const noteIdSchema = z.string().uuid();

export const noteInputSchema = z.object({
  title: z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(MAX_NOTE_TITLE)),
  content: z.string().max(MAX_NOTE_CONTENT),
});
export type NoteInput = z.input<typeof noteInputSchema>;

export const noteSearchSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(MAX_SEARCH_CHARS));
