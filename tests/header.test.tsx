// @vitest-environment jsdom
// Header tests (M1-9): the status chip shows Online, Offline, and Limit
// reached from the mocked /api/health response; the account menu shows the
// email and signs out; the header renders nothing on /login.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Header, { StatusChip } from "@/components/header";
import { QuickAskProvider } from "@/components/quick-ask";

const pathnameState = vi.hoisted(() => ({ current: "/chat" }));
const signOutMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameState.current,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/app/login/actions", () => ({
  signOut: signOutMock,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pathnameState.current = "/chat";
});

const EMAIL = "tanishq.jshinde@gmail.com";

function mockHealth(response: unknown, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => response,
  }) as unknown as typeof fetch;
}

describe("StatusChip", () => {
  it.each([
    ["online", "Online"],
    ["offline", "Offline"],
    ["limit_reached", "Limit reached"],
    ["checking", "Checking…"],
  ] as const)("shows %s with an icon and text", (status, label) => {
    render(<StatusChip status={status} />);
    const chip = screen.getByRole("status");
    expect(chip.textContent).toContain(label);
    expect(chip.querySelector("svg")).not.toBeNull();
  });
});

describe("Header", () => {
  beforeEach(() => {
    mockHealth({ status: "online", usage: 3, cap: 20 });
  });

  it("shows Online from /api/health", async () => {
    render(
      <QuickAskProvider>
        <Header userEmail={EMAIL} />
      </QuickAskProvider>,
    );
    expect(await screen.findByText("Online")).toBeDefined();
    expect(global.fetch).toHaveBeenCalledWith("/api/health", { cache: "no-store" });
  });

  it("shows Limit reached when the cap is hit", async () => {
    mockHealth({ status: "limit_reached", usage: 20, cap: 20 });
    render(
      <QuickAskProvider>
        <Header userEmail={EMAIL} />
      </QuickAskProvider>,
    );
    expect(await screen.findByText("Limit reached")).toBeDefined();
  });

  it("shows Offline when the check fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    render(
      <QuickAskProvider>
        <Header userEmail={EMAIL} />
      </QuickAskProvider>,
    );
    expect(await screen.findByText("Offline")).toBeDefined();
  });

  it("shows Offline on a non-OK health response", async () => {
    mockHealth({ error: "unauthenticated" }, false);
    render(
      <QuickAskProvider>
        <Header userEmail={EMAIL} />
      </QuickAskProvider>,
    );
    expect(await screen.findByText("Offline")).toBeDefined();
  });

  it("renders nothing on /login", () => {
    pathnameState.current = "/login";
    const { container } = render(
      <QuickAskProvider>
        <Header userEmail={null} />
      </QuickAskProvider>,
    );
    expect(container.innerHTML).toBe("");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("shows the clock after mount", async () => {
    render(
      <QuickAskProvider>
        <Header userEmail={EMAIL} />
      </QuickAskProvider>,
    );
    const time = await screen.findByText(/\d{2}:\d{2}/);
    expect(time.tagName).toBe("TIME");
  });

  it("account menu shows the email and signs out", async () => {
    render(
      <QuickAskProvider>
        <Header userEmail={EMAIL} />
      </QuickAskProvider>,
    );
    const avatar = screen.getByRole("button", { name: `Account menu for ${EMAIL}` });
    expect(within(document.body).queryByRole("menu")).toBeNull();
    fireEvent.click(avatar);
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain(EMAIL);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Sign out/ }));
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(within(document.body).queryByRole("menu")).toBeNull();
  });

  it("Escape closes the account menu", () => {
    render(
      <QuickAskProvider>
        <Header userEmail={EMAIL} />
      </QuickAskProvider>,
    );
    const avatar = screen.getByRole("button", { name: `Account menu for ${EMAIL}` });
    fireEvent.click(avatar);
    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.keyDown(avatar, { key: "Escape" });
    expect(within(document.body).queryByRole("menu")).toBeNull();
  });
});
