// Dev-only guard (M1-5, TASKS.md §0.3): the test suite refuses to run unless
// APP_ENV=dev, and refuses if a live Supabase project URL is configured.
// In this build there is no live dev project — tests run only against a
// local in-process PGlite database — so any target other than local dev is
// a mistake, and this file makes it fail loudly instead of touching real data.
const appEnv = process.env.APP_ENV;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

if (appEnv !== "dev") {
  throw new Error(
    `Refusing to run tests: APP_ENV must be 'dev' (got ${JSON.stringify(appEnv ?? null)}). ` +
      `Tests only ever run against the local PGlite dev database — never against a live ` +
      `or production project. Run them with \`npm run test\`, which sets APP_ENV=dev.`,
  );
}

if (supabaseUrl.includes(".supabase.co")) {
  throw new Error(
    `Refusing to run tests: NEXT_PUBLIC_SUPABASE_URL points at a live Supabase project ` +
      `(${supabaseUrl}). Tests only run against the local PGlite dev database. ` +
      `Unset the variable before running the suite.`,
  );
}
