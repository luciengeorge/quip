import { defineTool } from "eve/tools";
import { z } from "zod";

import { recordThemeResearch } from "../lib/demand-runtime.ts";

export default defineTool({
  description:
    "Store the incumbent check for one theme. The verdict is computed here from the coverage " +
    "judgement, not taken from the researcher, so a persuasive summary cannot change the outcome.",
  inputSchema: z
    .object({
      themeKey: z.string().min(1),
      incumbentCoverage: z.enum(["covers", "partial", "none"]),
      incumbents: z
        .array(z.object({ name: z.string().min(1).max(80), covers: z.string().min(1).max(240) }).strict())
        .max(8),
      researchSummary: z.string().min(1).max(600),
      sources: z
        .array(z.object({ url: z.string().min(1).max(500), claim: z.string().min(1).max(240) }).strict())
        .max(8),
      buildComponents: z.array(z.string().min(1).max(60)).max(12),
    })
    .strict(),
  async execute(input) {
    return await recordThemeResearch(input);
  },
});
