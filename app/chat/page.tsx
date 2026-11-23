// Chat page (M2-6): loads the conversation's history from the database
// (server-side, user-scoped client) so a refresh reloads the conversation.
// A missing, unknown, or foreign conversation ID renders a fresh chat —
// RLS makes another user's conversation indistinguishable from one that
// does not exist, so there is nothing to leak either way.
import Chat from "@/components/chat";
import { createClient } from "@/utils/supabase/server";
import { dbMessagesToUIMessages } from "@/lib/chat-history";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  if (!id) return <Chat key="new" />;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return <Chat key="new" />;

  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .single();
  if (convError || !conv) return <Chat key="new" />;

  const { data } = await supabase
    .from("messages")
    .select("id, role, content, parts, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  return (
    <Chat
      key={id}
      conversationId={id}
      initialMessages={dbMessagesToUIMessages(data ?? [])}
    />
  );
}
