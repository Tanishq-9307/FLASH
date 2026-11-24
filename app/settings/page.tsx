// Settings page (M3-23, DESIGN.md §5.1): account and the memory
// toggle. The account row shows the signed-in email from the session;
// the memory toggle is the same switch as on the Memory screen. A
// failed settings load shows "Unavailable" for the toggle, never a
// guessed state.
import { createClient } from "@/utils/supabase/server";
import { MemoryToggle } from "@/components/memory-toggle";
import { MEMORY_PRIVACY_WARNING } from "@/lib/memories";
import { getMemoryEnabled } from "@/app/memory/actions";

export const metadata = { title: "Settings · FLASH" };

export default async function Page() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const enabled = await getMemoryEnabled();

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

      <section aria-label="Memory" className="mt-4 rounded-md border border-border bg-surface p-3">
        <h2 className="font-display text-base font-semibold text-text-primary">Memory</h2>
        <div className="mt-2">
          <MemoryToggle initialEnabled={enabled.ok ? enabled.data : null} />
        </div>
        <p className="mt-2 text-sm text-text-secondary">{MEMORY_PRIVACY_WARNING}</p>
      </section>
    </main>
  );
}
