import { defineTool } from "eve/tools";
import { z } from "zod";

import { applyDemandThemeAssignments } from "../lib/demand-runtime.ts";

export default defineTool({
  description:
    "Group this run's stored asks into recurring themes. Each assignment names one ask permalink " +
    "and either an existing themeKey or a new label. Assignments for asks outside this run are " +
    "rejected. Returns the themes that now need an incumbent check.",
  inputSchema: z
    .object({
      assignments: z
        .array(
          z
            .object({
              permalink: z.string().min(1),
              themeKey: z.string().min(1).optional(),
              newLabel: z.string().min(1).max(120).optional(),
            })
            .strict(),
        )
        .max(60),
    })
    .strict(),
  async execute({ assignments }) {
    return await applyDemandThemeAssignments(assignments);
  },
});
