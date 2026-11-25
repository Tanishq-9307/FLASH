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

/** The M3-0 privacy decision (TECH_STACK.md §3.3, PRD.md §9), updated
 * for the Groq switch (2026-11-24): FLASH runs on Groq's free tier.
 * Groq's Services Agreement §4.2 bars Groq from using inputs or
 * outputs to train or fine-tune models, and inference data is not
 * retained by default (up to 30-day logs only for troubleshooting or
 * abuse; Zero Data Retention is available in the console). The
 * non-sensitive-only rule stays regardless: only non-sensitive facts
 * belong in memories. Shown on the Memory screen and in Settings. */
export const MEMORY_PRIVACY_WARNING =
  "FLASH runs on Groq's free tier. Groq does not use your prompts to train models, and does not retain them by default — but only save non-sensitive facts here anyway. Never save passwords, financial details, health information, or anything confidential. Saved facts are also embedded by Voyage AI (voyage-4-lite) so FLASH can retrieve them by meaning; the same non-sensitive-only rule applies to what gets embedded.";
