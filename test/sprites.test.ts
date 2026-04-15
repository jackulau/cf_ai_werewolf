// @ts-expect-error vite ?raw imports return strings
import spritesSource from "../public/sprites.js?raw";
// We import the actual module too — Vite handles it as a JS module
// (typecheck doesn't run on .js files, so no .d.ts needed)
// @ts-expect-error sprites.js is plain JS; types not declared
import * as sprites from "../public/sprites.js";
import { describe, it, expect } from "vitest";

describe("sprite module structure", () => {
  it("exports renderSprite function", () => {
    expect(typeof sprites.renderSprite).toBe("function");
  });

  it("exports starfield function", () => {
    expect(typeof sprites.starfield).toBe("function");
  });

  it("exports all 4 ROLE_SPRITES", () => {
    expect(Object.keys(sprites.ROLE_SPRITES).sort()).toEqual(
      ["doctor", "seer", "villager", "werewolf"],
    );
  });

  it("exports all 9 PERSONA_SPRITES (8 personas + traveler/human)", () => {
    const keys = Object.keys(sprites.PERSONA_SPRITES).sort();
    expect(keys).toContain("wren");
    expect(keys).toContain("morgan");
    expect(keys).toContain("tobias");
    expect(keys).toContain("elspeth");
    expect(keys).toContain("rorik");
    expect(keys).toContain("isolde");
    expect(keys).toContain("callum");
    expect(keys).toContain("branwen");
    expect(keys).toContain("human");
    expect(keys.length).toBe(9);
  });

  it("exports all 6 PHASE_SPRITES", () => {
    expect(Object.keys(sprites.PHASE_SPRITES).sort()).toEqual(
      ["day-debate", "ended", "lobby", "night", "resolution", "voting"],
    );
  });
});

describe("sprite grids are well-formed", () => {
  function allSpriteSpecs(): Record<string, { palette: string[]; grid: string[] }> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(sprites.ROLE_SPRITES)) out[`role:${k}`] = v;
    for (const [k, v] of Object.entries(sprites.PERSONA_SPRITES)) out[`persona:${k}`] = v;
    for (const [k, v] of Object.entries(sprites.PHASE_SPRITES)) out[`phase:${k}`] = v;
    out["log:skull"] = sprites.SKULL_TINY;
    out["log:ballot"] = sprites.BALLOT_TINY;
    out["log:chevron"] = sprites.CHEVRON_TINY;
    out["log:bubble"] = sprites.BUBBLE_TINY;
    out["log:star"] = sprites.STAR_TINY;
    out["log:zzz"] = sprites.ZZZ_TINY;
    return out;
  }

  it("every sprite has all rows the same width", () => {
    for (const [name, spec] of Object.entries(allSpriteSpecs())) {
      const widths = new Set(spec.grid.map((r) => r.length));
      expect(widths.size, `${name} has inconsistent row widths: ${[...widths].join(",")}`).toBe(1);
    }
  });

  it("every sprite has a non-empty palette and grid", () => {
    for (const [name, spec] of Object.entries(allSpriteSpecs())) {
      expect(spec.palette.length, `${name} palette empty`).toBeGreaterThan(0);
      expect(spec.grid.length, `${name} grid empty`).toBeGreaterThan(0);
    }
  });

  it("every non-transparent grid char references a valid palette index", () => {
    for (const [name, spec] of Object.entries(allSpriteSpecs())) {
      for (let y = 0; y < spec.grid.length; y++) {
        const row = spec.grid[y];
        for (let x = 0; x < row.length; x++) {
          const ch = row[x];
          if (ch === "." || ch === " ") continue;
          const idx = parseInt(ch, 36);
          expect(
            idx,
            `${name} grid[${y}][${x}] = '${ch}' is not a valid palette index`,
          ).not.toBeNaN();
          expect(
            spec.palette[idx],
            `${name} grid[${y}][${x}] = '${ch}' references missing palette[${idx}]`,
          ).toBeTruthy();
        }
      }
    }
  });
});

describe("renderSprite", () => {
  it("returns SVG with shape-rendering crispEdges", () => {
    const svg = sprites.renderSprite(sprites.VILLAGER);
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  it("respects size option", () => {
    const svg = sprites.renderSprite(sprites.VILLAGER, { size: 96 });
    expect(svg).toContain('width="96"');
    expect(svg).toContain('height="96"');
  });

  it("emits one rect per non-transparent pixel", () => {
    // Single-pixel sprite — should produce exactly 1 rect
    const tinySpec = { palette: ["transparent", "#ff0000"], grid: ["1"] };
    const svg = sprites.renderSprite(tinySpec);
    const rectCount = (svg.match(/<rect/g) ?? []).length;
    expect(rectCount).toBe(1);
  });

  it("ignores transparent and space cells", () => {
    const tinySpec = { palette: ["transparent", "#ff0000"], grid: [".1.", " 1 "] };
    const svg = sprites.renderSprite(tinySpec);
    const rectCount = (svg.match(/<rect/g) ?? []).length;
    expect(rectCount).toBe(2);
  });

  it("applies className option", () => {
    const svg = sprites.renderSprite(sprites.VILLAGER, { className: "avatar-sprite" });
    expect(svg).toContain("avatar-sprite");
  });
});

describe("starfield", () => {
  it("returns SVG containing exactly N rects", () => {
    const out = sprites.starfield(40, "test-seed");
    const rectCount = (out.match(/<rect/g) ?? []).length;
    expect(rectCount).toBe(40);
  });

  it("is deterministic for same seed", () => {
    const a = sprites.starfield(20, "seed-A");
    const b = sprites.starfield(20, "seed-A");
    expect(a).toBe(b);
  });

  it("differs across seeds", () => {
    const a = sprites.starfield(30, "seed-X");
    const b = sprites.starfield(30, "seed-Y");
    expect(a).not.toBe(b);
  });

  it("contains crispEdges", () => {
    const out = sprites.starfield(5, "x");
    expect(out).toContain("crispEdges");
  });
});

describe("served as a static asset", () => {
  it("sprites.js source contains export statements", () => {
    expect(spritesSource).toContain("export");
    expect(spritesSource).toContain("renderSprite");
  });
});
