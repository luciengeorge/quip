import { disableTool } from "eve/tools";

// Declared subagents do not inherit the root's authored tools. Disable Eve's default
// human-input tool so a scheduled research pass cannot park waiting for a person.
export default disableTool();
