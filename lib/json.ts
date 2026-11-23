// JSON-safe values for Supabase rpc arguments (M3-17).
//
// Plain language: the generated Supabase types want `Json` for jsonb
// arguments, and the AI SDK wants `JSONValue` for tool-result output.
// Ordinary TypeScript objects (records, interfaces, `unknown`) are not
// assignable to those types, even when the data is plain JSON. A
// round trip through JSON.stringify/parse produces a value that is,
// and it drops `undefined` properties — which is exactly what
// Postgres jsonb stores anyway, so nothing is lost that the database
// would have kept.
import type { Json } from "@/types/supabase";

/** Round-trip a JSON-safe value so it is typed as `Json`. */
export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
