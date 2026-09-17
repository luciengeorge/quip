import { defineTool } from "eve/tools";
import { z } from "zod";

import { recordClassificationAudit } from "../lib/demand-runtime.ts";

export default defineTool({
  description:
    "Record the independent audit of Jev's classification. Pass the classifier's verdicts through unchanged as `verdicts`: each needs the exact `permalink` from the sample and a boolean `buyerAsk`. Agreement is computed here, not by you. Every sampled ask was accepted by Jev, so a `buyerAsk: false` is a disagreement and is recorded as one.",
  inputSchema: z.object({
    verdicts: z
      .array(z.object({ permalink: z.string().min(1), buyerAsk: z.boolean() }).strict())
      .max(30),
  }),
  async execute({ verdicts }) {
    return await recordClassificationAudit(verdicts);
  },
});
