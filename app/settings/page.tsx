// Settings page (Phase 2, 2026-11-25): account plus the live
// configuration panel. The account row shows the signed-in email
// from the session; the panel is every app setting as a switch that
// applies immediately. A failed settings load shows "Unavailable"
// for the panel, never a guessed state. There is no field on this
// page for any credential — secrets stay in environment variables
// only. The memory privacy warning stays, because the Memory switch
// is one of the panel's rows.
import { createClient } from "@/utils/supabase/server";
import { getSettings } from "@/app/settings/actions";
import { SettingsPanel } from "@/components/settings-panel";
import { MEMORY_PRIVACY_WARNING } from "@/lib/memories";

export const metadata = { title: "Settings · FLASH" };

export default async function Page() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const settings = await getSettings();

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="font-display text-2xl font-semibold">Settings</h1>

      <section aria-label="Account" className="mt-4 rounded-md border border-border bg-surface p-3">
        <h2 className="font-display text-base font-semibold text-text-primary">Account</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Signed in as {user?.email ?? "Unavailable"}.
        </p>
        <p className="mt-1 text-sm text-text-secondary">
          Sign out from the account menu in the header.
        </p>
      </section>

      <section aria-label="Preferences" className="mt-4 rounded-md border border-border bg-surface p-3">
        <h2 className="font-display text-base font-semibold text-text-primary">Preferences</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Changes apply immediately — no restart, no redeploy.
        </p>
        <div className="mt-2">
          <SettingsPanel initial={settings.ok ? settings.data : null} />
        </div>
        <p className="mt-2 text-sm text-text-secondary">{MEMORY_PRIVACY_WARNING}</p>
      </section>
    </main>
  );
}
