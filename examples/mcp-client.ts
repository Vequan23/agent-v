import { connectMcpServer, type McpConnectionAuthorizer } from "@vraxis/agent-v/mcp";
import { SystemCredentialStore } from "@vraxis/agent-v/node";

/** Connect only after the product has rendered and recorded the exact request. */
export function connectApprovedIssueTracker(authorizer: McpConnectionAuthorizer) {
  return connectMcpServer({
    id: "issue-tracker",
    name: "Issue tracker",
    transport: {
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
      bearerCredentialRef: "keychain://mcp/issue-tracker",
    },
  }, {
    authorizer,
    credentials: new SystemCredentialStore({ service: "example-app" }),
  });
}
