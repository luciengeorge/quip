import { defineTool } from "eve/tools";
import { z } from "zod";

import { weeklyTrendContextFromEnv } from "../lib/trend-runtime.ts";

export default defineTool({
  description:
    "Read the measured seven-day trend and demand window before proposing a weekly digest. Use only " +
    "these links, counts, distinct-asker totals, and directions as idea evidence. X and Reddit " +
    "availability are explicit.",
  inputSchema: z.object({}),
  async execute() {
    return await weeklyTrendContextFromEnv();
  },
});
