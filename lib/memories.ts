// Memory rules (M3-23, DATABASE.md §3.7, PRD.md §5.3).
// Validation limits equal the database CHECKs: fact 1–10000
// characters after trimming. Free of Next.js and Supabase imports so
// the pure schemas can be unit-tested without mocks.
import { z } from "zod";

/** DATABASE.md §3.7: memories.fact CHECK (char_length(btrim(fact)) BETWEEN 1 AND 10000). */
export const MAX_MEMORY_FACT = 10_000;

export type Memory = {
  id: string;
  fact: string;
  created_at: string;
  updated_at: string;
};

export const memoryIdSchema = z.string().uuid();

export const memoryFactSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(MAX_MEMORY_FACT));

/** The M3-0 privacy decision (TECH_STACK.md §3.3, PRD.md §9):
 * FLASH runs on the free Gemini tier, so only non-sensitive facts
 * belong in memories. Shown on the Memory screen and in Settings. */
export const MEMORY_PRIVACY_WARNING =
  "FLASH runs on Google's free Gemini tier. Free-tier prompts may be used by Google to improve its products, and human reviewers may read them — so only save non-sensitive facts here. Never save passwords, financial details, health information, or anything confidential.";
