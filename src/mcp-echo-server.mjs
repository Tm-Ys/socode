import { stdin, stdout } from "node:process";

stdin.setEncoding("utf8");
let buf = "";
stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
    nl = buf.indexOf("\n");
  }
});

function send(payload) {
  stdout.write(`${JSON.stringify(payload)}\n`);
}

function handle(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "0.0.1" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "ping",
            description: "echo ping",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
          {
            name: "shout",
            description: "uppercase text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    const text = String(msg.params?.arguments?.text ?? "");
    const out = msg.params?.name === "shout" ? text.toUpperCase() : `pong:${text}`;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: out }] },
    });
  }
}
