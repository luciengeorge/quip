import { defineAgent } from "eve";

export default defineAgent({
  // Quip's orchestrator uses Luna through the Vercel AI Gateway. Luna is the least costly
  // GPT-5.6 tier, so the agent config explicitly restores the reasoning depth it needs.
  // CRITICAL: GPT-5.6 defaults to reasoning "none". Never remove `reasoning`: omitting it
  // silently disables reasoning with no error.
  model: "openai/gpt-5.6-luna",
  reasoning: "xhigh",
});
