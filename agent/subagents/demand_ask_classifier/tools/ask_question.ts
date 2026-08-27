import { disableTool } from "eve/tools";

// Declared subagents do not inherit the root's authored tools. Disable Eve's
// default human-input tool so an autonomous demand sweep cannot wait for a person.
export default disableTool();
