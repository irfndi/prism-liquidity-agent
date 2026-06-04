#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools.js";

const server = new McpServer({
  name: "prism-mcp-server",
  version: "0.0.2",
});

registerAllTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
