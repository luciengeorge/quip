import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Independent fail-closed classifier for a bounded batch of Reddit and Stack Exchange buyer-intent asks. It returns only structured classifications and never writes or contacts anyone.",
  model: "openai/gpt-5.6-luna",
  reasoning: "high",
});
