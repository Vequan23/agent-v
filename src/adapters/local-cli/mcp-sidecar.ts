#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { connect } from "node:net";

interface BridgeDescriptor {
  host: string;
  port: number;
  token: string;
}

async function main() {
  const descriptorPath = process.env.AGENT_V_MCP_DESCRIPTOR;
  if (!descriptorPath) throw new Error("AGENT_V_MCP_DESCRIPTOR is required.");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as BridgeDescriptor;
  const socket = connect({ host: descriptor.host, port: descriptor.port });
  socket.setNoDelay(true);
  socket.once("connect", () => {
    socket.write(`${JSON.stringify({ type: "agent-v-auth", token: descriptor.token })}\n`);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.once("error", (error) => {
    process.stderr.write(`agent-v MCP bridge failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  process.stdin.once("end", () => socket.end());
}

void main().catch((error: unknown) => {
  process.stderr.write(`agent-v MCP bridge failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
