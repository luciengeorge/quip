import { defineTool } from "eve/tools";
import { z } from "zod";

import { ExaTrendingSource } from "../../../lib/exa.ts";
import { leakGuardConfigFromEnv } from "../../../lib/leak-guard.ts";

export default defineTool({
  description:
    "Search Exa for products that already serve one buyer-intent theme. Returns a small source " +
    "set and never reads X, so it cannot bypass the X read reservation and settlement budget.",
  inputSchema: z.object({ query: z.string().trim().min(1).max(700) }).strict(),
  async execute({ query }) {
    const apiKey = process.env.EXA_API_KEY?.trim();
    if (!apiKey) {
      return { available: false, sources: [], message: "Exa is not configured for research." };
    }
    try {
      const result = await new ExaTrendingSource({
        apiKey,
        query,
        limit: 5,
        leakGuard: leakGuardConfigFromEnv(),
      }).gather();
      return {
        available: true,
        sources: result.candidates.map(({ title, url, context }) => ({ title, url, context })),
        message: result.messages.join(" "),
      };
    } catch (error) {
      console.warn("[demand-verdict] Exa research failed cleanly:", error);
      return { available: false, sources: [], message: "Exa research was unavailable." };
    }
  },
});
