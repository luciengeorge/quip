import { defineTool } from "eve/tools";
import { z } from "zod";

import { classificationAuditSample } from "../lib/demand-runtime.ts";

export default defineTool({
  description:
    "Ask whether an independent audit of Jev's buyer-ask classification is due, and if so get the sample to re-decide. Jev classified these asks, so Jev must not grade them: you re-decide the sample yourself with the demand_ask_classifier subagent, then call record_classification_audit with its verdicts. Returns due:false when the last audit is recent, and there is nothing to do.",
  inputSchema: z.object({}),
  async execute() {
    return await classificationAuditSample();
  },
});
