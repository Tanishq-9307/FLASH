// @vitest-environment jsdom
// Conversation panel tests (M2-7): list, empty and error states, collapse,
// rename and delete flows. The Server Actions are mocked; no network.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationPanel } from "@/components/conversation-panel";
import type { ConversationSummary } from "@/lib/conversations";

const mockPush = vi.fn();
const mockRename = vi.fn();
const mockDelete = vi.fn();
const mockList = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/app/chat/actions", () => ({
  listConversations: (...args: unknown[]) => mockList(...args),
  renameConversation: (...args: unknown[]) => mockRename(...args),
  deleteConversation: (...args: unknown[]) => mockDelete(...args),
}));

afterEach(() => cleanup());

const ROWS: ConversationSummary[] = [
  { id: "00000000-0000-4000-8000-000000000042", title: "Second chat", updated_at: "2026-11-24T10:00:00Z" },
  { id: "00000000-0000-4000-8000-000000000043", title: "First chat", updated_at: "2026-11-24T09:00:00Z" },
];

function renderPanel(props?: {
  initial?: ConversationSummary[];
  loadError?: boolean;
  activeId?: string | null;
}) {
  render(
    <ConversationPanel
      initial={props?.initial ?? ROWS}
      loadError={props?.loadError ?? false}
      activeId={props?.activeId ?? ROWS[0].id}
    >
      <div>chat body</div>
    </ConversationPanel>,
  );
}

describe("conversation panel (M2-7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists conversations with links and marks the active one", () => {
    renderPanel();
    const links = within(
      screen.getByRole("navigation", { name: "Conversations" }),
    )
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("/chat?id="));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/chat?id=${ROWS[0].id}`,
      `/chat?id=${ROWS[1].id}`,
    ]);
    expect(links[0]).toHaveAttribute("aria-current", "page");
    expect(links[1]).not.toHaveAttribute("aria-current");
    expect(screen.getByText("chat body")).toBeInTheDocument();
  });

  it("shows the empty state when there are no conversations", () => {
    renderPanel({ initial: [], activeId: null });
    expect(
      screen.getByText("No conversations yet. Your first message starts one."),
    ).toBeInTheDocument();
  });

  it("shows the load error state and no empty-state text", () => {
    renderPanel({ initial: [], loadError: true, activeId: null });
    expect(screen.getByRole("alert")).toHaveTextContent("Conversations unavailable.");
    expect(
      screen.queryByText("No conversations yet. Your first message starts one."),
    ).not.toBeInTheDocument();
  });

  it("collapses to a show button and back", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Hide conversations" }));
    expect(screen.queryByRole("navigation", { name: "Conversations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New chat" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show conversations" }));
    expect(screen.getByRole("navigation", { name: "Conversations" })).toBeInTheDocument();
  });

  it("renames a conversation only after the server confirms it", async () => {
    const renamed = { ...ROWS[0], title: "Renamed chat" };
    mockRename.mockResolvedValue({ ok: true, data: renamed });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Rename Second chat" }));
    const input = screen.getByLabelText("New title");
    fireEvent.change(input, { target: { value: "Renamed chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() =>
      expect(mockRename).toHaveBeenCalledWith(ROWS[0].id, "Renamed chat"),
    );
    expect(screen.getByText("Renamed chat")).toBeInTheDocument();
    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();
  });

  it("shows the rename error and keeps the old title", async () => {
    mockRename.mockResolvedValue({ ok: false, error: "invalid" });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Rename Second chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Titles need 1 to 255 characters.",
      ),
    );
    // The rename form stays open so the title can be fixed; the row is
    // not renamed.
    expect(screen.getByLabelText("New title")).toHaveValue("Second chat");
    expect(screen.queryByRole("link", { name: "Second chat" })).not.toBeInTheDocument();
  });

  it("deletes after confirmation and navigates away when the active row goes", async () => {
    mockDelete.mockResolvedValue({ ok: true, data: { id: ROWS[0].id } });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Delete Second chat" }));
    expect(
      screen.getByText("Delete “Second chat” and all its messages?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith(ROWS[0].id),
    );
    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();
    expect(screen.getByText("First chat")).toBeInTheDocument();
    expect(mockPush).toHaveBeenCalledWith("/chat");
  });

  it("a delete blocked by an open approval shows the guard message", async () => {
    mockDelete.mockResolvedValue({ ok: false, error: "open_approval" });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Delete Second chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Cancel the pending action first.",
      ),
    );
    expect(screen.getByText("Second chat")).toBeInTheDocument();
  });
});
