import { defineTool } from "eve/tools";
import { z } from "zod";

import { weeklyTrendContextFromEnv } from "../lib/trend-runtime.ts";

export default defineTool({
  description:
    "Read the measured seven-day trend window before proposing a weekly digest. Use only these " +
    "trend links, counts, and directions as idea evidence. X availability is explicit.",
  inputSchema: z.object({}),
  async execute() {
    return await weeklyTrendContextFromEnv();
  },
});
