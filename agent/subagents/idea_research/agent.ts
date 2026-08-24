import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Independent market researcher for one rejected weekly trend idea. Finds source-backed facts and may revise the proposal, but cannot admit it or override the deterministic idea gate.",
  model: "openai/gpt-5.6-luna",
  reasoning: "high",
});
