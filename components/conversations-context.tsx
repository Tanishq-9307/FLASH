// Refresh handle for the conversation list (M2-7).
// The Chat component calls refresh() when a new conversation is created
// or a reply lands (updated_at moves it to the top); the panel re-lists
// from the server. The default is a no-op so Chat also renders outside
// the panel (for example in component tests).
"use client";

import { createContext, useContext } from "react";

export const ConversationsRefreshContext = createContext<() => void>(
  () => {},
);

export function useRefreshConversations(): () => void {
  return useContext(ConversationsRefreshContext);
}
