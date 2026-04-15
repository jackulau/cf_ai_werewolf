import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Don't try to proxy bindings to the cloud during tests.
      // Workers AI calls are mocked per-test via vi.spyOn(env.AI, "run").
      remoteBindings: false,
      miniflare: {
        compatibilityFlags: ["nodejs_compat", "service_binding_extra_handlers"],
        // Override per-phase timeouts so workflow tests don't wait minutes.
        bindings: {
          NIGHT_HUMAN_TIMEOUT: "1 second",
          DAY_HUMAN_TIMEOUT: "1 second",
          VOTE_HUMAN_TIMEOUT: "1 second",
        },
      },
    }),
  ],
});
