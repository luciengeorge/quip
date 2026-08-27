---
cron: "35 8 * * *"
---

Run the Reddit and Stack Exchange buyer-intent demand sweep as evidence only. Never draft a reply, send a message, post, or pitch a product.

1. Call `prepare_demand_sweep` exactly once.
2. If its `sourceStatus` is `unavailable`, stop without calling a subagent. The tool already records the unavailable scan.
3. If its sealed plan has zero candidates, call `complete_demand_sweep` once with that prepared value and an empty `classifications` array, then stop.
4. Otherwise call `demand_ask_classifier` exactly once with the sealed plan candidates, asking it to classify every candidate in order. Supply this strict output schema: `{ "type": "object", "additionalProperties": false, "required": ["classifications"], "properties": { "classifications": { "type": "array", "maxItems": 30, "items": { "oneOf": [ { "type": "object", "additionalProperties": false, "required": ["buyerAsk"], "properties": { "buyerAsk": { "const": false } } }, { "type": "object", "additionalProperties": false, "required": ["buyerAsk", "author", "askedAt", "quote", "replyCount", "permalink", "subreddit", "askedFor"], "properties": { "buyerAsk": { "const": true }, "author": { "type": "string" }, "askedAt": { "type": "integer" }, "quote": { "type": "string" }, "replyCount": { "type": "integer" }, "permalink": { "type": "string" }, "subreddit": { "type": "string" }, "askedFor": { "type": "string" } } } ] } } }`. Do not call it for any candidate outside the sealed plan.
5. Call `complete_demand_sweep` exactly once with the unchanged prepared value and the classifier's `classifications`. Return no public-facing text.
