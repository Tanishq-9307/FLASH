// @vitest-environment jsdom
// Header tests (M1-9): the status chip shows Online with today's usage
// percentage, or Offline, from the mocked /api/health response; the
// account menu shows the email and signs out; the header renders
// nothing on /login. There is no Limit reached state any more (owner
// decision 2026-11-24): the daily limit is a display limit only.
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
    ["checking", "Checking…"],
  ] as const)("shows %s with an icon and text", (status, label) => {
    render(<StatusChip status={status} />);
    const chip = screen.getByRole("status");
    expect(chip.textContent).toContain(label);
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("shows the usage percentage next to Online when it is known", () => {
    render(<StatusChip status="online" percent={5} />);
    expect(screen.getByRole("status").textContent).toContain("5% used");
  });

  it("shows no percentage when it is unknown", () => {
    render(<StatusChip status="online" percent={null} />);
    expect(screen.getByRole("status").textContent).not.toContain("% used");
  });
});

describe("Header", () => {
  beforeEach(() => {
    mockHealth({ status: "online", usage: 3, cap: 20 });
  });

  it("shows Online with today's usage percentage from /api/health", async () => {
    render(
      <QuickAskProvider>
        <Header userEmail={EMAIL} />
      </QuickAskProvider>,
    );
    expect(await screen.findByText("Online")).toBeDefined();
    // 3 of 20 = 15% — computed from the mocked figures, never hardcoded.
    expect(await screen.findByText(/15% used/)).toBeDefined();
    expect(global.fetch).toHaveBeenCalledWith("/api/health", { cache: "no-store" });
  });

  it("shows Online with no percentage when the health body has no figures", async () => {
    mockHealth({ status: "online" });
    render(
      <QuickAskProvider>
        <Header userEmail={EMAIL} />
      </QuickAskProvider>,
    );
    expect(await screen.findByText("Online")).toBeDefined();
    expect(screen.queryByText(/% used/)).toBeNull();
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
