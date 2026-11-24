// Model ids (client-safe: plain strings, no provider imports).
// components/chat.tsx displays the active model from these, and the
// server-only wrapper in lib/ai/provider.ts builds the model from
// them — so the id the header shows is always the id the route
// actually calls with.
//
// Primary: Groq `llama-3.3-70b-versatile` (verified:
// console.groq.com/docs/ai-sdk; env `GROQ_API_KEY`).
// Coding mode: Groq `openai/gpt-oss-120b` — OpenAI's flagship
// open-weight model (120B parameters, 131,072-token context,
// SWE-Bench Verified 62.4% per Groq's model page), verified
// 2026-11-24 at console.groq.com/docs/model/openai/gpt-oss-120b
// and console.groq.com/docs/models (Production tier).
// Backup (hot-swap failover): OpenRouter free
// `meta-llama/llama-3.3-70b-instruct:free` — the 70B free model,
// NOT the coding model: failover is about availability, so the
// backup stays the same in both modes (see lib/ai/provider.ts).
export const PRIMARY_MODEL_ID = "llama-3.3-70b-versatile";
export const CODING_MODEL_ID = "openai/gpt-oss-120b";
export const BACKUP_MODEL_ID = "meta-llama/llama-3.3-70b-instruct:free";

/** The Groq model id for a request: the coding model when coding
 * mode is on, the default 70B otherwise. */
export function modelIdFor(codingMode: boolean): string {
  return codingMode ? CODING_MODEL_ID : PRIMARY_MODEL_ID;
}
