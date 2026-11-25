// @vitest-environment jsdom
// Navigation tests (M1-8): rail items and active state, tab bar items and
// the More menu, keyboard operation, and the responsive breakpoint classes
// (the layout switch itself is CSS: the rail is `hidden md:flex`, the tab
// bar `md:hidden`).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileTabBar, NavRail } from "@/components/nav";

afterEach(() => cleanup());

const pathnameState = vi.hoisted(() => ({ current: "/chat" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameState.current,
}));

function renderNav() {
  render(
    <>
      <NavRail />
      <MobileTabBar />
    </>,
  );
  return {
    rail: screen.getByRole("navigation", { name: "Primary" }),
    tabBar: screen.getByRole("navigation", { name: "Mobile" }),
  };
}

describe("navigation shell", () => {
  it("rail lists all seven items with real routes", () => {
    const { rail } = renderNav();
    const links = within(rail).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/",
      "/chat",
      "/tasks",
      "/reminders",
      "/memory",
      "/activity",
      "/settings",
    ]);
    expect(within(rail).getByRole("link", { name: /Tasks & Notes/ })).toBeDefined();
  });

  it("rail marks the current route with aria-current and switches by breakpoint class", () => {
    pathnameState.current = "/chat";
    const { rail } = renderNav();
    const active = within(rail).getByRole("link", { name: /Chat/ });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(within(rail).getByRole("link", { name: /Overview/ }).getAttribute("aria-current")).toBeNull();
    expect(rail.className).toContain("hidden");
    expect(rail.className).toContain("md:flex");
  });

  it("rail items meet the 44px touch target", () => {
    const { rail } = renderNav();
    for (const link of within(rail).getAllByRole("link")) {
      expect(link.className).toContain("min-h-11");
    }
  });

  it("tab bar lists Overview, Chat, Tasks, Activity plus More, and hides on desktop", () => {
    const { tabBar } = renderNav();
    const links = within(tabBar).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/",
      "/chat",
      "/tasks",
      "/activity",
    ]);
    expect(within(tabBar).getByRole("button", { name: /More/ })).toBeDefined();
    expect(tabBar.className).toContain("md:hidden");
  });

  it("tab bar items meet the 44px touch target", () => {
    const { tabBar } = renderNav();
    for (const link of within(tabBar).getAllByRole("link")) {
      expect(link.className).toContain("min-h-14");
    }
    expect(within(tabBar).getByRole("button", { name: /More/ }).className).toContain("min-h-14");
  });

  it("More opens Memory, Reminders and Settings, Escape closes it", () => {
    const { tabBar } = renderNav();
    const more = within(tabBar).getByRole("button", { name: /More/ });
    expect(within(tabBar).queryByRole("menu")).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const menu = within(tabBar).getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Memory/ }).getAttribute("href")).toBe("/memory");
    expect(within(menu).getByRole("menuitem", { name: /Reminders/ }).getAttribute("href")).toBe("/reminders");
    expect(within(menu).getByRole("menuitem", { name: /Settings/ }).getAttribute("href")).toBe("/settings");
    fireEvent.keyDown(more, { key: "Escape" });
    expect(within(tabBar).queryByRole("menu")).toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("choosing a More item closes the menu", () => {
    const { tabBar } = renderNav();
    const more = within(tabBar).getByRole("button", { name: /More/ });
    fireEvent.click(more);
    const menu = within(tabBar).getByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Memory/ }));
    expect(within(tabBar).queryByRole("menu")).toBeNull();
  });

  it("the More button is keyboard-operable", () => {
    const { tabBar } = renderNav();
    const more = within(tabBar).getByRole("button", { name: /More/ });
    more.focus();
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: "Enter" });
    fireEvent.click(more);
    expect(within(tabBar).getByRole("menu")).toBeDefined();
  });
});

describe("open-approval badge (M3-21b)", () => {
  it("shows a badge on the Activity item on both rail and tab bar while an approval is open", () => {
    render(
      <>
        <NavRail hasOpenApproval />
        <MobileTabBar hasOpenApproval />
      </>,
    );
    const rail = screen.getByRole("navigation", { name: "Primary" });
    const tabBar = screen.getByRole("navigation", { name: "Mobile" });
    expect(within(rail).getByRole("link", { name: /Activity.*Approval awaiting review/ })).toBeDefined();
    expect(within(tabBar).getByRole("link", { name: /Activity.*Approval awaiting review/ })).toBeDefined();
    // No other item carries the badge.
    expect(within(rail).getByRole("link", { name: "Overview" }).textContent).not.toContain("Approval awaiting review");
  });

  it("shows no badge when no approval is open", () => {
    const { rail, tabBar } = renderNav();
    expect(screen.queryByText("Approval awaiting review")).toBeNull();
    expect(within(rail).getByRole("link", { name: "Activity" }).textContent).not.toContain("Approval awaiting review");
    expect(within(tabBar).getByRole("link", { name: "Activity" }).textContent).not.toContain("Approval awaiting review");
  });
});
