// Memory page (M3-23, DESIGN.md §5.1): the stored memories and the
// global switch, loaded server-side. A failed load passes null, which
// the screen renders as "Unavailable".
import { MemoryScreen } from "@/components/memory-screen";
import { getMemoryEnabled, listMemories } from "./actions";

export const metadata = { title: "Memory · FLASH" };

export default async function Page() {
  const [memories, enabled] = await Promise.all([listMemories(), getMemoryEnabled()]);
  return (
    <MemoryScreen
      initialMemories={memories.ok ? memories.data : null}
      memoryEnabled={enabled.ok ? enabled.data : null}
    />
  );
}
