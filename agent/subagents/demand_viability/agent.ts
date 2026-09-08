import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Independent researcher for one recurring buyer-intent theme. Reports which existing products already serve the want and how completely, but never decides the verdict.",
  model: "openai/gpt-5.6-luna",
  reasoning: "high",
});
