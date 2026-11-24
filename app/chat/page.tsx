// Chat page (M2-6, M2-7): loads the conversation's history from the
// database (server-side, user-scoped client) so a refresh reloads the
// conversation, and the conversation list for the panel (ordered by
// updated_at). A missing, unknown, or foreign conversation ID renders a
// fresh chat — RLS makes another user's conversation indistinguishable
// from one that does not exist, so there is nothing to leak either way.
// A failed list load renders the panel with an error state, never an
// empty list pretending there are no conversations.
import Chat from "@/components/chat";
import { ConversationPanel } from "@/components/conversation-panel";
import { createClient } from "@/utils/supabase/server";
import { dbMessagesToUIMessages } from "@/lib/chat-history";
import type { ConversationSummary } from "@/lib/conversations";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let initial: ConversationSummary[] = [];
  let loadError = false;
  if (user) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, updated_at")
      .order("updated_at", { ascending: false });
    if (error) loadError = true;
    else initial = data ?? [];
  }

  const panel = (chat: React.ReactNode) => (
    <ConversationPanel initial={initial} loadError={loadError} activeId={id ?? null}>
      {chat}
    </ConversationPanel>
  );

  if (!id) return panel(<Chat key="new" />);
  if (!user) return panel(<Chat key="new" />);

  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .single();
  if (convError || !conv) return panel(<Chat key="new" />);

  const { data } = await supabase
    .from("messages")
    .select("id, role, content, parts, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  return panel(
    <Chat
      key={id}
      conversationId={id}
      initialMessages={dbMessagesToUIMessages(data ?? [])}
    />,
  );
}
