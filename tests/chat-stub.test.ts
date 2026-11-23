import { describe, expect, it } from "vitest";
import { maxDuration, POST } from "../app/api/chat/route";

describe("M0-5: stub chat route", () => {
  it("exports maxDuration 60", () => {
    expect(maxDuration).toBe(60);
  });

  it("POST returns 501 not implemented", async () => {
    const response = await POST();
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not implemented");
  });
});
