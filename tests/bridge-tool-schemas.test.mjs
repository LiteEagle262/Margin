import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_TOOLS,
  MCP_PROXIED_TOOLS,
  RECON_TOOLS,
  WEB_SEARCH_TOOLS,
  WORKSPACE_TOOL_NAMES,
  toMcpToolSchema,
} from "../shared/tool-schemas.js";
import { BUILT_IN_TOOL_NAMES } from "../sidepanel/settings/sections/tool-access.js";

// Mirrors TOOL_NAME_PATTERN in mcp-server/index.js. A name that fails this is
// silently dropped by the bridge validator, so the tool would vanish from every
// MCP client without any error surfacing.
const BRIDGE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

test("every proxied tool survives the bridge validator and reaches MCP shape", () => {
  assert.ok(MCP_PROXIED_TOOLS.length > 0);

  // The sweep below covers whatever is proxied; this pins that fill_secret is
  // actually among it, so the leak-free credential path exists on both surfaces.
  const proxiedNames = new Set(MCP_PROXIED_TOOLS.map((tool) => tool.function.name));
  assert.ok(proxiedNames.has("fill_secret"), "fill_secret must flow from BROWSER_TOOLS to the bridge");

  for (const tool of MCP_PROXIED_TOOLS) {
    const schema = toMcpToolSchema(tool);
    assert.match(schema.name, BRIDGE_NAME_PATTERN, `${schema.name} would be dropped by the bridge`);
    assert.ok(schema.name.length <= 64, `${schema.name} exceeds the bridge name limit`);
    assert.ok(schema.description.length > 0, `${schema.name} has no description`);
    assert.ok(schema.description.length <= 4000, `${schema.name} description would be truncated`);
    assert.equal(typeof schema.inputSchema, "object");
    assert.equal(Array.isArray(schema.inputSchema), false);
    assert.equal(schema.inputSchema.type, "object", `${schema.name} needs an object input schema`);
  }
});

test("a proxied tool the user cannot toggle would never be pushed", () => {
  for (const tool of MCP_PROXIED_TOOLS) {
    const name = tool.function.name;
    assert.ok(BUILT_IN_TOOL_NAMES.has(name),
      `${name} is missing from TOOL_ACCESS_GROUPS, so it can never be enabled or pushed`);
  }
});

test("workspace and web-search tools stay off the bridge", () => {
  const proxied = new Set(MCP_PROXIED_TOOLS.map((tool) => tool.function.name));

  for (const name of WORKSPACE_TOOL_NAMES) {
    assert.equal(proxied.has(name), false, `${name} is the extension's own workspace, not the client's`);
  }
  for (const tool of WEB_SEARCH_TOOLS) {
    assert.equal(proxied.has(tool.function.name), false,
      `${tool.function.name} is gated and defined by the bridge server itself`);
  }
  assert.equal(proxied.size, BROWSER_TOOLS.length + RECON_TOOLS.length, "no duplicate names across groups");
});

test("conversion carries the schema across verbatim", () => {
  const batch = MCP_PROXIED_TOOLS.find((tool) => tool.function.name === "browser_batch");
  assert.ok(batch, "browser_batch should be proxied to MCP clients");

  const schema = toMcpToolSchema(batch);
  assert.equal(schema.inputSchema, batch.function.parameters);
  assert.deepEqual(schema.inputSchema.required, ["actions"]);

  assert.deepEqual(toMcpToolSchema({ function: { name: "bare" } }), {
    name: "bare",
    description: "",
    inputSchema: { type: "object", properties: {} },
  });
});
