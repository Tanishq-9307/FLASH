// @vitest-environment jsdom
// Safe markdown tests (M1-10): raw HTML is never rendered, remote images
// are never fetched, links are safe and show their domain.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import SafeMarkdown from "@/components/markdown";

afterEach(() => cleanup());

describe("SafeMarkdown", () => {
  it("renders normal markdown", () => {
    const { container } = render(<SafeMarkdown text={"Hello **world**"} />);
    expect(container.querySelector("strong")?.textContent).toBe("world");
  });

  it("does not render raw HTML", () => {
    const { container } = render(
      <SafeMarkdown text={'<script>alert("x")</script> <b>bold</b> hello'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("hello");
    expect(container.textContent).toContain("bold");
  });

  it("blocks remote images and shows the alt text", () => {
    const { container } = render(
      <SafeMarkdown text={"![a cat](https://example.com/cat.png)"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("a cat");
  });

  it("renders nothing for an image with no alt text", () => {
    const { container } = render(
      <SafeMarkdown text={"![](https://example.com/cat.png)"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent?.trim()).toBe("");
  });

  it("makes links safe and shows their domain", () => {
    render(<SafeMarkdown text={"[Example](https://example.com/page)"} />);
    const link = screen.getByRole("link", { name: /Example/ });
    expect(link.getAttribute("href")).toBe("https://example.com/page");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("example.com");
  });
});
