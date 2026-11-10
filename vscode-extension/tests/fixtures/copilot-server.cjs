#!/usr/bin/env node
// Small protocol server for tests of the bundled SDK. It makes no network calls.
let buffer = Buffer.alloc(0);
let sessionId;
function write(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function event(type, data = {}) {
  write({
    method: "session.event",
    params: {
      sessionId,
      event: {
        id: `${type}-event`,
        type,
        timestamp: new Date().toISOString(),
        parentId: null,
        data,
      },
    },
  });
}
function handle(message) {
  if (message.id === "question") {
    if (message.error) throw new Error(JSON.stringify(message.error));
    event("assistant.message", {
      messageId: "answer",
      content: `Selected: ${message.result.answer}`,
    });
    event("session.idle");
    return;
  }
  let result = {};
  switch (message.method) {
    case "connect":
    case "ping":
      result = { protocolVersion: 3 };
      break;
    case "status.get":
      result = { version: "test-runtime", protocolVersion: 3 };
      break;
    case "session.create":
    case "session.resume":
      sessionId = message.params.sessionId;
      result = { sessionId };
      break;
    case "session.mode.set":
      result = { mode: message.params.mode };
      break;
    case "session.send":
      result = { messageId: "prompt" };
      write({ id: message.id, result });
      write({
        id: "question",
        method: "userInput.request",
        params: {
          sessionId,
          question: "Select a database",
          choices: ["SQLite", "Postgres"],
          allowFreeform: true,
        },
      });
      return;
    case "session.detach":
      result = { success: true };
      break;
    case "runtime.shutdown":
      write({ id: message.id, result });
      process.exit(0);
      return;
  }
  if (message.id !== undefined) write({ id: message.id, result });
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(
      buffer
        .subarray(0, end)
        .toString()
        .match(/Content-Length: (\d+)/i)[1],
    );
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString();
    buffer = buffer.subarray(end + 4 + length);
    handle(JSON.parse(body));
  }
});
