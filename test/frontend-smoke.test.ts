import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("frontend asset serving", () => {
  it("GET / returns 200 HTML with title and app root", async () => {
    const res = await SELF.fetch("https://app/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<title>");
    expect(body).toContain("cf_ai_werewolf");
    expect(body).toContain('id="app"');
  });

  it("GET /styles.css returns CSS", async () => {
    const res = await SELF.fetch("https://app/styles.css");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("body");
  });

  it("GET /app.js returns JS module", async () => {
    const res = await SELF.fetch("https://app/app.js");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("WebSocket");
  });

  it("SPA fallback: GET /unknown-path returns index.html", async () => {
    const res = await SELF.fetch("https://app/unknown-path-xyz");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<title>");
  });

  it("frontend has start button + name input", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    expect(body).toContain('id="start-btn"');
    expect(body).toContain('id="name-input"');
  });
});
