import { disableTool } from "eve/tools";

// Declared subagents do not inherit the root's authored tools. Disable Eve's
// default human-input tool here so a scheduled research pass cannot park while
// waiting for a person.
export default disableTool();
