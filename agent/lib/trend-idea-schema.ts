import { z } from "zod";

/** The proposal is deliberately strict so a model cannot smuggle in an asserted duration. */
export const proposedIdeaSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    trendTitle: z.string().trim().min(1).max(240),
    mechanism: z.string().trim().min(1).max(700),
    evidence: z.string().trim().min(1).max(700),
    moatClass: z.string().trim().min(1).max(40),
    buildComponents: z.array(z.string().trim().min(1).max(80)).max(20),
    ownerFit: z.string().trim().max(500),
  })
  .strict();

export const weeklyIdeaListSchema = z
  .array(proposedIdeaSchema)
  .max(3)
  .refine(
    (ideas) => new Set(ideas.map((idea) => idea.title.toLocaleLowerCase())).size === ideas.length,
    "proposal titles must be unique within one digest",
  );
