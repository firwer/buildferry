import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { api } from "../src/web/api.js";
afterEach(() => vi.unstubAllGlobals());

describe("dashboard response handling", () => {
  it.each([
    "<html>Proxy unavailable</html>",
    "",
    '{"message":"not an application error"}',
  ])("hides proxy response details for %s", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 502 })),
    );
    await expect(
      api("/api/dashboard", z.object({ ok: z.boolean() })),
    ).rejects.toThrow("The request could not be completed.");
  });
  it("provides a readable error for a malformed success response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    await expect(
      api("/api/dashboard", z.object({ ok: z.boolean() })),
    ).rejects.toThrow("unexpected response");
  });
});
