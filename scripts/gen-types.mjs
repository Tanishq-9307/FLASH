#!/usr/bin/env node
// gen:types — generate types/supabase.ts from the migration-validated schema.
//
// How it works: starts an in-process PGlite database (real PostgreSQL compiled
// to WebAssembly, no server, no network), applies every migration in
// supabase/migrations/ in filename order, then introspects the resulting
// schema (tables, views, enums, functions) and emits a `Database` type in the
// supabase-js generated format.
//
// Why PGlite: this build has no remote Supabase project (see
// docs/TECH_STACK.md §2.1). The Supabase CLI's `gen types` needs a live
// Postgres connection, which PGlite cannot serve over TCP, so this script
// does the introspection itself against the same in-process database the
// migration tests use.
//
// Auth stand-ins: PGlite has no `auth` schema, so before applying migrations
// the script creates a minimal one — an `auth.users` table (id only) and an
// `auth.uid()` stub — plus the three Supabase built-in roles (`anon`,
// `authenticated`, `service_role`), which the migrations' GRANT/REVOKE
// statements reference. The stub returns the UUID in the session setting
// `app.current_user_id` when set, else the zero UUID, so tests can act as
// different users (see tests/db/helpers.ts `setTestUser` — the two copies
// are kept in sync by hand). Migrations must be written so they validate
// against these stand-ins (see the `add-migration` skill).
// RLS policies and functions are validated as SQL; auth-dependent paths are
// verified against the real service when the owner connects one.
//
// Limits (best-effort mapping, documented honestly): PostgreSQL types map to
// TypeScript by the table below; unknown types fall back to `string`.
// Function `TABLE(...)` / OUT-parameter returns are approximated as object
// types. For exact parity with the hosted generator, re-run `supabase gen
// types` against the real project once one exists.
//
// Usage:
//   node scripts/gen-types.mjs [--migrations <dir>] [--out <file>]
// Defaults: --migrations supabase/migrations --out types/supabase.ts
// Exits non-zero if any migration fails, naming the file and the error.

import { readdir, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { migrations: join(repoRoot, "supabase", "migrations"), out: join(repoRoot, "types", "supabase.ts") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--migrations") args.migrations = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

// PostgreSQL type name (information_schema data_type / udt_name) -> TypeScript.
const SCALARS = new Map([
  ["smallint", "number"],
  ["integer", "number"],
  ["bigint", "number"],
  ["real", "number"],
  ["double precision", "number"],
  ["numeric", "number"],
  ["boolean", "boolean"],
  ["text", "string"],
  ["character varying", "string"],
  ["character", "string"],
  ["uuid", "string"],
  ["date", "string"],
  ["time without time zone", "string"],
  ["time with time zone", "string"],
  ["timestamp without time zone", "string"],
  ["timestamp with time zone", "string"],
  ["interval", "string"],
  ["bytea", "string"],
  ["inet", "string"],
  ["cidr", "string"],
  ["macaddr", "string"],
  ["json", "Json"],
  ["jsonb", "Json"],
  // Postgres pseudo-type with no TypeScript equivalent. `set_updated_at` is
  // a trigger helper, never called from TypeScript; `unknown` is honest.
  ["trigger", "unknown"],
]);

function pgTypeToTs(dataType, udtName) {
  if (dataType === "ARRAY") {
    // information_schema names array types "_<element>".
    const element = udtName.startsWith("_") ? udtName.slice(1) : udtName;
    return `${SCALARS.get(element) ?? "string"}[]`;
  }
  if (dataType === "USER-DEFINED") return udtName; // enum or composite type
  return SCALARS.get(dataType) ?? "string";
}

// regtype name (from pg_proc, e.g. "uuid", "integer", "text[]") -> TypeScript.
// Unlike information_schema, pg_proc reports scalar types by name, so they
// go through the same scalar table. A missing type (an index past the end
// of the type array) maps to `unknown`, never to the literal `undefined`.
function regtypeToTs(name) {
  if (name === "undefined") return "unknown";
  if (name.endsWith("[]")) return `${regtypeToTs(name.slice(0, -2))}[]`;
  return SCALARS.get(name) ?? name;
}

function tsTypeForColumn(col) {
  const base = pgTypeToTs(col.data_type, col.udt_name);
  return col.is_nullable === "YES" ? `${base} | null` : base;
}

async function introspect(db) {
  const tables = (
    await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    )
  ).rows;
  const columns = (
    await db.query(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    )
  ).rows;
  const fks = (
    await db.query(
      `SELECT tc.table_name, kcu.column_name,
              ccu.table_name AS foreign_table_name,
              ccu.column_name AS foreign_column_name,
              tc.constraint_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
    )
  ).rows;
  const views = (
    await db.query(
      `SELECT table_name FROM information_schema.views
        WHERE table_schema = 'public' ORDER BY table_name`,
    )
  ).rows;
  const enums = (
    await db.query(
      `SELECT t.typname, e.enumlabel FROM pg_type t
          JOIN pg_enum e ON e.enumtypid = t.oid
          JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder`,
    )
  ).rows;
  const functions = (
    await db.query(
      `SELECT p.proname, p.proargnames,
              COALESCE(p.proallargtypes, p.proargtypes)::regtype[] AS arg_types,
              p.proargmodes, p.prorettype::regtype AS ret_type, p.proretset
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f' ORDER BY p.proname`,
    )
  ).rows;
  return { tables, columns, fks, views, enums, functions };
}

function render({ tables, columns, fks, views, enums, functions }) {
  const byTable = new Map();
  for (const col of columns) {
    if (!byTable.has(col.table_name)) byTable.set(col.table_name, []);
    byTable.get(col.table_name).push(col);
  }
  const fkByTable = new Map();
  for (const fk of fks) {
    if (!fkByTable.has(fk.table_name)) fkByTable.set(fk.table_name, []);
    fkByTable.get(fk.table_name).push(fk);
  }
  const enumByName = new Map();
  for (const e of enums) {
    if (!enumByName.has(e.typname)) enumByName.set(e.typname, []);
    enumByName.get(e.typname).push(e.enumlabel);
  }

  const lines = [];
  lines.push(
    `// Generated by scripts/gen-types.mjs from supabase/migrations/ via PGlite.`,
    `// Do not edit by hand; run \`npm run gen:types\` after changing migrations.`,
    ``,
    `export type Json =`,
    `  | string`,
    `  | number`,
    `  | boolean`,
    `  | null`,
    `  | { [key: string]: Json | undefined }`,
    `  | Json[]`,
    ``,
    `export type Database = {`,
    `  public: {`,
    `    Tables: {`,
  );
  for (const { table_name } of tables) {
    const cols = byTable.get(table_name) ?? [];
    const rels = fkByTable.get(table_name) ?? [];
    lines.push(`      ${table_name}: {`);
    lines.push(`        Row: {`);
    for (const c of cols) lines.push(`          ${c.column_name}: ${tsTypeForColumn(c)}`);
    lines.push(`        }`);
    lines.push(`        Insert: {`);
    for (const c of cols) {
      const optional = c.is_nullable === "YES" || c.column_default !== null;
      lines.push(`          ${c.column_name}${optional ? "?" : ""}: ${tsTypeForColumn(c)}`);
    }
    lines.push(`        }`);
    lines.push(`        Update: {`);
    for (const c of cols) lines.push(`          ${c.column_name}?: ${tsTypeForColumn(c)}`);
    lines.push(`        }`);
    lines.push(`        Relationships: [`);
    for (const r of rels) {
      lines.push(
        `          {`,
        `            foreignKeyName: "${r.constraint_name}",`,
        `            columns: ["${r.column_name}"],`,
        `            isOneToOne: false,`,
        `            referencedRelation: "${r.foreign_table_name}",`,
        `            referencedColumns: ["${r.foreign_column_name}"],`,
        `          },`,
      );
    }
    lines.push(`        ]`);
    lines.push(`      }`);
  }
  lines.push(`    }`);
  lines.push(`    Views: {`);
  for (const { table_name } of views) {
    const cols = byTable.get(table_name) ?? [];
    lines.push(`      ${table_name}: {`);
    lines.push(`        Row: {`);
    for (const c of cols) lines.push(`          ${c.column_name}: ${tsTypeForColumn(c)}`);
    lines.push(`        }`);
    lines.push(`        Relationships: []`);
    lines.push(`      }`);
  }
  lines.push(`    }`);
  lines.push(`    Functions: {`);
  for (const fn of functions) {
    const names = fn.proargnames ?? [];
    const types = fn.arg_types ?? [];
    const modes = fn.proargmodes ?? [];
    const inArgs = types
      .map((t, i) => ({ name: names[i] ?? `arg${i}`, type: regtypeToTs(String(t)), mode: modes[i] ?? "i" }))
      .filter((a) => a.mode === "i");
    const outArgs = types
      .map((t, i) => ({ name: names[i] ?? `arg${i}`, type: String(t), mode: modes[i] ?? "i" }))
      .filter((a) => a.mode === "o" || a.mode === "t");
    let returns = String(fn.ret_type);
    if (returns === "record" && outArgs.length > 0) {
      returns = `{ ${outArgs.map((a) => `${a.name}: ${regtypeToTs(a.type)}`).join("; ")} }`;
    } else if (returns === "void") {
      returns = "undefined";
    } else {
      returns = regtypeToTs(returns);
    }
    if (fn.proretset) returns = `${returns}[]`;
    lines.push(`      ${fn.proname}: {`);
    lines.push(`        Args: {`);
    // Postgres function arguments are always nullable at the SQL level
    // (a caller may pass NULL for any of them), so every arg type carries
    // `| null`. Without it, passing null for an optional argument such as
    // append_message's p_tool_call_id fails the type check (M2-6).
    for (const a of inArgs) lines.push(`          ${a.name}: ${a.type} | null`);
    lines.push(`        }`);
    lines.push(`        Returns: ${returns}`);
    lines.push(`      }`);
  }
  lines.push(`    }`);
  lines.push(`    Enums: {`);
  for (const [name, labels] of enumByName) {
    lines.push(`      ${name}: ${labels.map((l) => `"${l}"`).join(" | ")}`);
  }
  lines.push(`    }`);
  lines.push(`    CompositeTypes: {`);
  lines.push(`      [_ in never]: never`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`type DefaultSchema = Database[Extract<keyof Database, "public">]`);
  lines.push(``);
  lines.push(`export type Tables<`);
  lines.push(`  DefaultSchemaTableNameOrOptions extends`);
  lines.push(`    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])`);
  lines.push(`    | { schema: keyof Database },`);
  lines.push(`  TableName extends DefaultSchemaTableNameOrOptions extends {`);
  lines.push(`    schema: keyof Database`);
  lines.push(`  }`);
  lines.push(`    ? keyof (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &`);
  lines.push(`        Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])`);
  lines.push(`    : never = never,`);
  lines.push(`> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }`);
  lines.push(`  ? (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &`);
  lines.push(`      Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {`);
  lines.push(`      Row: infer R`);
  lines.push(`    }`);
  lines.push(`    ? R`);
  lines.push(`    : never`);
  lines.push(`  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &`);
  lines.push(`      DefaultSchema["Views"])`);
  lines.push(`    ? (DefaultSchema["Tables"] &`);
  lines.push(`        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {`);
  lines.push(`        Row: infer R`);
  lines.push(`      }`);
  lines.push(`      ? R`);
  lines.push(`      : never`);
  lines.push(`    : never`);
  lines.push(``);
  lines.push(`export type TablesInsert<`);
  lines.push(`  DefaultSchemaTableNameOrOptions extends`);
  lines.push(`    | keyof DefaultSchema["Tables"]`);
  lines.push(`    | { schema: keyof Database },`);
  lines.push(`  TableName extends DefaultSchemaTableNameOrOptions extends {`);
  lines.push(`    schema: keyof Database`);
  lines.push(`  }`);
  lines.push(`    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]`);
  lines.push(`    : never = never,`);
  lines.push(`> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }`);
  lines.push(`  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {`);
  lines.push(`      Insert: infer I`);
  lines.push(`    }`);
  lines.push(`    ? I`);
  lines.push(`    : never`);
  lines.push(`  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]`);
  lines.push(`    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {`);
  lines.push(`        Insert: infer I`);
  lines.push(`      }`);
  lines.push(`      ? I`);
  lines.push(`      : never`);
  lines.push(`    : never`);
  lines.push(``);
  lines.push(`export type TablesUpdate<`);
  lines.push(`  DefaultSchemaTableNameOrOptions extends`);
  lines.push(`    | keyof DefaultSchema["Tables"]`);
  lines.push(`    | { schema: keyof Database },`);
  lines.push(`  TableName extends DefaultSchemaTableNameOrOptions extends {`);
  lines.push(`    schema: keyof Database`);
  lines.push(`  }`);
  lines.push(`    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]`);
  lines.push(`    : never = never,`);
  lines.push(`> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }`);
  lines.push(`  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {`);
  lines.push(`      Update: infer U`);
  lines.push(`    }`);
  lines.push(`    ? U`);
  lines.push(`    : never`);
  lines.push(`  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]`);
  lines.push(`    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {`);
  lines.push(`        Update: infer U`);
  lines.push(`      }`);
  lines.push(`      ? U`);
  lines.push(`      : never`);
  lines.push(`    : never`);
  lines.push(``);
  lines.push(`export type Enums<`);
  lines.push(`  DefaultSchemaEnumNameOrOptions extends`);
  lines.push(`    | keyof DefaultSchema["Enums"]`);
  lines.push(`    | { schema: keyof Database },`);
  lines.push(`  EnumName extends DefaultSchemaEnumNameOrOptions extends {`);
  lines.push(`    schema: keyof Database`);
  lines.push(`  }`);
  lines.push(`    ? keyof Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]`);
  lines.push(`    : never = never,`);
  lines.push(`> = DefaultSchemaEnumNameOrOptions extends { schema: keyof Database }`);
  lines.push(`  ? Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]`);
  lines.push(`  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]`);
  lines.push(`    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]`);
  lines.push(`    : never`);
  lines.push(``);
  lines.push(`export type CompositeTypes<`);
  lines.push(`  PublicCompositeTypeNameOrOptions extends`);
  lines.push(`    | keyof DefaultSchema["CompositeTypes"]`);
  lines.push(`    | { schema: keyof Database },`);
  lines.push(`  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {`);
  lines.push(`    schema: keyof Database`);
  lines.push(`  }`);
  lines.push(`    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]`);
  lines.push(`    : never = never,`);
  lines.push(`> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }`);
  lines.push(`  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]`);
  lines.push(`  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]`);
  lines.push(`    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]`);
  lines.push(`    : never`);
  lines.push(``);
  lines.push(`export const Constants = {`);
  lines.push(`  public: {`);
  lines.push(`    Enums: {`);
  for (const [name, labels] of enumByName) {
    lines.push(`      ${name}: [${labels.map((l) => `"${l}"`).join(", ")}],`);
  }
  lines.push(`    },`);
  lines.push(`  },`);
  lines.push(`} as const`);
  lines.push(``);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = existsSync(args.migrations)
    ? (await readdir(args.migrations)).filter((f) => f.endsWith(".sql")).sort()
    : [];
  const db = new PGlite();
  try {
    // Auth stand-ins (see header): PGlite has no auth schema.
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
        AS $$ SELECT COALESCE(NULLIF(current_setting('app.current_user_id', true), '')::uuid, '00000000-0000-0000-0000-000000000000'::uuid) $$;
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN;
        END IF;
      END $$;
    `);
    for (const file of files) {
      const { readFile } = await import("node:fs/promises");
      const sql = await readFile(join(args.migrations, file), "utf8");
      try {
        await db.exec(sql);
      } catch (err) {
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
    const schema = await introspect(db);
    const out = render(schema);
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, out);
    console.log(
      `gen:types: ${files.length} migration(s) applied; ` +
        `${schema.tables.length} table(s), ${schema.views.length} view(s), ` +
        `${schema.enums.length} enum value(s), ${schema.functions.length} function(s) -> ${args.out}`,
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(`gen:types failed: ${err.message}`);
  process.exit(1);
});
