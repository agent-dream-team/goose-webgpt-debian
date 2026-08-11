const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  runBrowserHelperOperation,
  verifyConnectorWithBrowserHelper,
} = require("../electron/browser-helper-verifier.cjs");

test("launcher verification delegates exact connector selection to the browser helper protocol", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-verify-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "verify") return;
      if (message.config.appName !== "Codex Native") process.exit(2);
      if (message.config.browserHostDescriptorPath !== "/runtime/launcher-browser.json") process.exit(3);
      send({ type: "result", id: message.id, text: message.config.appName });
    });
  `);

  const result = await verifyConnectorWithBrowserHelper({
    helper: { executable: process.execPath, script },
    descriptorPath: "/runtime/launcher-browser.json",
    appName: "Codex Native",
    logger: { info() {} },
  });

  assert.deepEqual(result, { ok: true, appName: "Codex Native" });
});

test("launcher maintenance operations carry typed payloads through the browser helper protocol", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goose-browser-helper-maintenance-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "inspect") return;
      if (message.config.appName !== "Goose Native") process.exit(2);
      if (message.detectPro !== true) process.exit(3);
      send({ type: "result", id: message.id, value: {
        authenticated: true,
        temporary: true,
        url: "https://chatgpt.com/?temporary-chat=true",
        proAvailable: true,
      } });
    });
  `);

  const result = await runBrowserHelperOperation({
    helper: { executable: process.execPath, script },
    descriptorPath: "/runtime/launcher-browser.json",
    appName: "Goose Native",
    operation: "inspect",
    payload: { detectPro: true },
    logger: { info() {} },
  });

  assert.equal(result.type, "result");
  assert.deepEqual(result.value, {
    authenticated: true,
    temporary: true,
    url: "https://chatgpt.com/?temporary-chat=true",
    proAvailable: true,
  });
});

test("launcher verification consumes a helper input EOF after the result", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-eof-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type !== "verify") return;
      send({ type: "result", id: message.id, text: message.config.appName });
      process.stdin.destroy();
      setTimeout(() => process.exit(0), 100);
    });
  `);

  const result = await verifyConnectorWithBrowserHelper({
    helper: { executable: process.execPath, script },
    descriptorPath: "/runtime/launcher-browser.json",
    appName: "Codex Native",
    logger: { info() {} },
  });

  assert.deepEqual(result, { ok: true, appName: "Codex Native" });
});
