// Placeholder for screens whose milestone has not landed yet (M1-8).
// Honest by construction: the screen says plainly that it is not built
// yet, instead of showing fake content (DESIGN.md §9).
export default function NotBuiltYet({ title }: { title: string }) {
  return (
    <main className="flex min-h-[60vh] flex-col items-start justify-center gap-2 px-6">
      <h1 className="font-display text-2xl font-semibold">{title}</h1>
      <p className="text-text-secondary">Not built yet.</p>
    </main>
  );
}
