import { defineTool } from "eve/tools";
import { z } from "zod";

import { buildDemandReport } from "../lib/demand-runtime.ts";

export default defineTool({
  description:
    "Render the day's demand report from stored themes and stored asks. Takes no arguments: the " +
    "report is built entirely from persisted values so nothing in it can be supplied by a model.",
  inputSchema: z.object({}).strict(),
  async execute() {
    return await buildDemandReport();
  },
});
