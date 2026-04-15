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

  it("name input has autocomplete=off and related attrs (prevents autofill)", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    const inputMatch = body.match(/<input[^>]*id="name-input"[^>]*>/);
    expect(inputMatch, "name-input element found").toBeTruthy();
    const input = inputMatch![0];
    expect(input).toContain('autocomplete="off"');
    expect(input).toContain('spellcheck="false"');
  });

  it("start button contains spinner markup (hidden by default)", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    // the start button should contain a spinner span with hidden attribute
    const btnMatch = body.match(/<button[^>]*id="start-btn"[^>]*>[\s\S]*?<\/button>/);
    expect(btnMatch).toBeTruthy();
    const btn = btnMatch![0];
    expect(btn).toMatch(/class="spinner"[^>]*hidden/);
  });
});

describe("design system (CSS + HTML)", () => {
  it("pixel fonts are preconnected and loaded (Press Start 2P + Pixelify Sans)", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    expect(body).toContain('rel="preconnect"');
    expect(body).toContain("fonts.gstatic.com");
    expect(body).toContain("Press+Start+2P");
    expect(body).toContain("Pixelify+Sans");
  });

  it("old Cinzel/Inter fonts are dropped from <head>", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    expect(body).not.toContain("Cinzel");
    expect(body).not.toMatch(/family=Inter/);
  });

  it("styles.css has phase-aware tokens (night + day-debate + voting)", async () => {
    const res = await SELF.fetch("https://app/styles.css");
    const body = await res.text();
    expect(body).toContain("body.phase-night");
    expect(body).toContain("body.phase-day-debate");
    expect(body).toContain("body.phase-voting");
  });

  it("styles.css declares required keyframes", async () => {
    const res = await SELF.fetch("https://app/styles.css");
    const body = await res.text();
    expect(body).toMatch(/@keyframes\s+death-pulse/);
    expect(body).toMatch(/@keyframes\s+thinking-dot/);
    expect(body).toMatch(/@keyframes\s+token-reveal/);
    expect(body).toMatch(/@keyframes\s+log-in/);
  });

  it("styles.css opts out animations for reduced-motion users", async () => {
    const res = await SELF.fetch("https://app/styles.css");
    const body = await res.text();
    expect(body).toContain("prefers-reduced-motion: reduce");
  });

  it("mobile media query exists (<=640px)", async () => {
    const res = await SELF.fetch("https://app/styles.css");
    const body = await res.text();
    expect(body).toMatch(/@media\s*\(\s*max-width:\s*640px/);
  });

  it("role card markup is present (tarot-style)", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    expect(body).toContain('id="role-card"');
    expect(body).toContain("role-card-inner");
    expect(body).toContain("role-card-front");
    expect(body).toContain("role-card-back");
  });

  it("mobile tab buttons are in DOM", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    expect(body).toContain('class="mobile-tabs"');
    expect(body).toContain('data-tab="log"');
    expect(body).toContain('data-tab="players"');
    expect(body).toContain('data-tab="action"');
  });

  it("activity strip element exists", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    expect(body).toContain('id="activity-strip"');
  });

  it("body starts with a phase class", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    expect(body).toMatch(/<body[^>]*class="[^"]*phase-\w+/);
  });
});

describe("pixel-art aesthetic", () => {
  // Common emoji ranges that should NOT appear in initial markup
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

  it("index.html initial markup contains no emoji glyphs", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    expect(body).not.toMatch(EMOJI_RE);
  });

  it("app.js source contains no emoji glyphs", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).not.toMatch(EMOJI_RE);
  });

  it("sprites.js is served as a JS module with exports", async () => {
    const res = await SELF.fetch("https://app/sprites.js");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("export");
    expect(body).toContain("renderSprite");
  });

  it("app.js imports the sprites module", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toMatch(/from\s+["']\.\/sprites\.js["']/);
  });

  it("app.js references ROLE_SPRITES, PERSONA_SPRITES, PHASE_SPRITES", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toContain("ROLE_SPRITES");
    expect(body).toContain("PERSONA_SPRITES");
    expect(body).toContain("PHASE_SPRITES");
  });

  it("app.js no longer exports/uses PERSONA_EMOJI map", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).not.toContain("PERSONA_EMOJI");
  });

  it("starfield element is in DOM", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    expect(body).toContain('id="starfield"');
  });

  it("phase-icon and role-emoji spans are empty (no emoji)", async () => {
    const res = await SELF.fetch("https://app/");
    const body = await res.text();
    expect(body).toMatch(/<span id="phase-icon"[^>]*>\s*<\/span>/);
    expect(body).toMatch(/<span class="role-card-emoji" id="role-emoji"[^>]*>\s*<\/span>/);
  });

  it("styles.css has zero non-zero border-radius declarations", async () => {
    const res = await SELF.fetch("https://app/styles.css");
    const body = await res.text();
    // Match border-radius: <number><non-zero unit/digit>
    const matches = body.match(/border-radius:\s*[1-9]/g) ?? [];
    expect(matches.length).toBe(0);
  });

  it("styles.css has no backdrop-filter declarations", async () => {
    const res = await SELF.fetch("https://app/styles.css");
    const body = await res.text();
    expect(body).not.toContain("backdrop-filter");
  });

  it("styles.css uses hard offset shadows (no blur)", async () => {
    const res = await SELF.fetch("https://app/styles.css");
    const body = await res.text();
    // At least one box-shadow with the form: <px> <px> 0 <color>
    expect(body).toMatch(/box-shadow:\s*[\d-]+px\s+[\d-]+px\s+0\s/);
  });

  it("styles.css uses steps() timing functions in animations/transitions", async () => {
    const res = await SELF.fetch("https://app/styles.css");
    const body = await res.text();
    const matches = body.match(/steps\s*\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("role card uses clip-path polygon for notched corners", async () => {
    const res = await SELF.fetch("https://app/styles.css");
    const body = await res.text();
    expect(body).toContain("clip-path: polygon(");
  });

  it("appendLogEntry uses sprite markers (SKULL/BALLOT/CHEVRON/BUBBLE)", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toContain("SKULL_TINY");
    expect(body).toContain("BALLOT_TINY");
    expect(body).toContain("CHEVRON_TINY");
    expect(body).toContain("BUBBLE_TINY");
  });

  it("avatar function uses persona sprites instead of initials letter", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toContain("avatar-sprite");
    // Old version used `${initial}` directly in avatar — no longer present
    expect(body).not.toMatch(/\.charAt\(0\)\.toUpperCase\(\)/);
  });
});

describe("app.js — activity + streaming + tabs", () => {
  it("handles activity message type", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toMatch(/case\s*"activity"/);
  });

  it("handles log-delta message type", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toMatch(/case\s*"log-delta"/);
  });

  it("sets body phase class on every phase message", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toContain("applyPhaseBodyClass");
    expect(body).toMatch(/phase-\$\{/);
  });

  it("stall threshold constant is 10 seconds", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toMatch(/STALL_THRESHOLD_MS\s*=\s*10_?000/);
  });

  it("mobile tab handler exists", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toContain("data-tab");
    expect(body).toMatch(/tab-\$\{/);
  });

  it("role-card click flips card", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toContain("setupRoleCardFlip");
    expect(body).toMatch(/classList\.toggle\s*\(\s*["']flipped["']\s*\)/);
  });

  it("in-progress speech append function exists", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toContain("appendInProgressSpeech");
    expect(body).toContain("in-progress");
  });

  it("activity strip render clears and redraws on every change", async () => {
    const res = await SELF.fetch("https://app/app.js");
    const body = await res.text();
    expect(body).toContain("renderActivityStrip");
  });
});
