const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    class WebContentsView {
      constructor() {
        this.webContents = {};
      }
    }
    return {
      WebContentsView,
      shell: { openExternal: async () => {} },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
} = require("../electron/browser-state.cjs");
const {
  allowedAuthUrl,
  BrowserHost,
  CHATGPT_VIEWPORT_CSS,
  isChatGptCloudflareChallengeResponse,
  isTemporaryChatUrl,
  validateChatGptStorageState,
} = require("../electron/browser-host.cjs");

test("authentication routing is limited to explicit auth paths and known identity providers", () => {
  assert.equal(allowedAuthUrl("https://chatgpt.com/?temporary-chat=true"), false);
  assert.equal(allowedAuthUrl("https://chatgpt.com/"), false);
  assert.equal(allowedAuthUrl("https://chatgpt.com/c/abc123"), false);
  assert.equal(allowedAuthUrl("https://chatgpt.com/login"), true);
  assert.equal(allowedAuthUrl("https://chatgpt.com/auth"), true);
  assert.equal(allowedAuthUrl("https://chatgpt.com/auth/login"), true);
  assert.equal(allowedAuthUrl("https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(allowedAuthUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"), true);
  assert.equal(allowedAuthUrl("https://login.example.com"), false);
  assert.equal(allowedAuthUrl("https://example.com/login"), false);
});

test("only an explicit Cloudflare challenge on a ChatGPT backend response triggers recovery", () => {
  assert.equal(isChatGptCloudflareChallengeResponse({
    statusCode: 403,
    url: "https://chatgpt.com/backend-api/subscriptions",
    responseHeaders: {
      "Cf-Mitigated": ["challenge"],
      "Content-Type": ["text/html; charset=UTF-8"],
    },
  }), true);
  assert.equal(isChatGptCloudflareChallengeResponse({
    statusCode: 403,
    url: "https://chatgpt.com/backend-api/subscriptions",
    responseHeaders: { "Content-Type": ["application/json"] },
  }), false);
  assert.equal(isChatGptCloudflareChallengeResponse({
    statusCode: 403,
    url: "https://example.com/backend-api/subscriptions",
    responseHeaders: { "cf-mitigated": ["challenge"] },
  }), false);
});

test("the idle home browser performs one bounded reload for a Cloudflare challenge burst", async () => {
  const calls = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(),
    manualOperation: null,
    cloudflareChallengeRecovery: null,
    cloudflareChallengeRecoveryArmed: true,
    cloudflareChallengeRecoveryDelayMs: 0,
    cloudflareChallengeRecoverySettleMs: 0,
    view: {
      webContents: {
        id: 42,
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        isDestroyed: () => false,
        loadURL: async (url) => calls.push(["loadURL", url]),
      },
    },
    logger: {
      info: (event, detail) => calls.push(["info", event, detail]),
      warn: (event, detail) => calls.push(["warn", event, detail]),
      error: (event, detail) => calls.push(["error", event, detail]),
    },
    setState: (patch) => calls.push(["setState", patch]),
    probeAuthentication: async () => calls.push(["probeAuthentication"]),
  });
  const challenge = {
    statusCode: 403,
    url: "https://chatgpt.com/backend-api/subscriptions",
    webContentsId: 42,
    responseHeaders: { "cf-mitigated": ["challenge"] },
  };

  assert.equal(BrowserHost.prototype.handleChatGptBackendResponse.call(fixture, challenge), true);
  assert.equal(BrowserHost.prototype.handleChatGptBackendResponse.call(fixture, challenge), true);
  await fixture.cloudflareChallengeRecovery;

  assert.deepEqual(calls.filter(([name]) => name === "loadURL"), [
    ["loadURL", "https://chatgpt.com/?temporary-chat=true"],
  ]);
  assert.equal(fixture.cloudflareChallengeRecoveryArmed, false);

  BrowserHost.prototype.handleChatGptBackendResponse.call(fixture, {
    statusCode: 200,
    url: "https://chatgpt.com/backend-api/subscriptions",
    webContentsId: 42,
    responseHeaders: { "content-type": ["application/json"] },
  });
  assert.equal(fixture.cloudflareChallengeRecoveryArmed, true);
});

function createContents() {
  const calls = [];
  const history = {
    canGoBack: () => true,
    canGoForward: () => false,
    goBack: () => calls.push("back"),
    goForward: () => calls.push("forward"),
  };
  const webContents = {
    navigationHistory: history,
    getURL: () => "https://chatgpt.com/?temporary-chat=true",
    getTitle: () => "ChatGPT",
    isDestroyed: () => false,
    isLoading: () => false,
    focus: () => calls.push("focus"),
    reload: () => calls.push("reload"),
  };
  return { calls, webContents };
}

test("browser surface visibility requires both requested and active state", () => {
  assert.equal(browserViewVisible(false, false, false), false);
  assert.equal(browserViewVisible(true, false, true), false);
  assert.equal(browserViewVisible(false, true, true), false);
  assert.equal(browserViewVisible(true, true, false), false);
  assert.equal(browserViewVisible(true, true, true), true);
});

test("smoke preserves an already-hydrated Temporary Chat page", () => {
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/?temporary-chat=true"), true);
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/?temporary-chat=false"), false);
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/c/abc?temporary-chat=true"), false);
  assert.equal(isTemporaryChatUrl("not a url"), false);
});

test("session inspection delegates to the shared browser helper without changing Goose capability semantics", async () => {
  const calls = [];
  const fixture = {
    helper: { executable: "/runtime/electron", script: "/runtime/browser-helper.cjs" },
    descriptorPath: "/runtime/launcher-browser.json",
    logger: { info() {} },
    view: { webContents: { getURL: () => "https://chatgpt.com/" } },
    runBrowserHelperOperation: async options => {
      calls.push(options);
      return {
        type: "result",
        value: {
          authenticated: true,
          temporary: true,
          url: "https://chatgpt.com/?temporary-chat=true",
          proAvailable: true,
        },
      };
    },
  };

  const inspected = await BrowserHost.prototype.runSessionInspection.call(fixture, true);

  assert.deepEqual(inspected, {
    authenticated: true,
    temporary: true,
    url: "https://chatgpt.com/?temporary-chat=true",
    proAvailable: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, "inspect");
  assert.equal(calls[0].appName, "Goose Native");
  assert.deepEqual(calls[0].payload, { detectPro: true });
});

test("session inspection fails closed on incomplete shared-helper Pro evidence", async () => {
  const fixture = {
    helper: {},
    descriptorPath: "/runtime/launcher-browser.json",
    logger: { info() {} },
    view: { webContents: { getURL: () => "https://chatgpt.com/?temporary-chat=true" } },
    runBrowserHelperOperation: async () => ({
      type: "result",
      value: { authenticated: true, temporary: true, url: "https://chatgpt.com/?temporary-chat=true" },
    }),
  };

  await assert.rejects(
    BrowserHost.prototype.runSessionInspection.call(fixture, true),
    /incomplete ChatGPT Pro capability evidence/,
  );
});

test("browser surface reactivation preserves its last measured bounds", () => {
  const visibility = [];
  const fixture = {
    surfaceActive: true,
    boundsReady: true,
    syncViewVisibility() {
      visibility.push({ active: this.surfaceActive, boundsReady: this.boundsReady });
    },
    setState() {},
    snapshot() {
      return { surfaceActive: this.surfaceActive, boundsReady: this.boundsReady };
    },
  };

  BrowserHost.prototype.setSurfaceActive.call(fixture, false);
  BrowserHost.prototype.setSurfaceActive.call(fixture, true);

  assert.deepEqual(visibility, [
    { active: false, boundsReady: true },
    { active: true, boundsReady: true },
  ]);
  assert.equal(fixture.boundsReady, true);
});

test("manual browser operations wait for the first measured surface", async () => {
  let readinessReads = 0;
  const fixture = {
    surfaceActive: true,
    get boundsReady() {
      readinessReads += 1;
      return readinessReads >= 3;
    },
  };

  await BrowserHost.prototype.waitForSurfaceReady.call(fixture, 100, 1);

  assert.equal(readinessReads, 3);
});

test("manual browser operations fail closed without measured surface bounds", async () => {
  await assert.rejects(
    BrowserHost.prototype.waitForSurfaceReady.call(
      { surfaceActive: true, boundsReady: false },
      2,
      1,
    ),
    /did not receive measured bounds/,
  );
});

test("browser bounds are clipped to the launcher content area", () => {
  assert.deepEqual(
    constrainBrowserBounds({ x: 260, y: 78, width: 1000, height: 900 }, { width: 1200, height: 800 }),
    { x: 260, y: 78, width: 940, height: 722 },
  );
  assert.deepEqual(
    constrainBrowserBounds({ x: -20, y: -10, width: 0, height: 0 }, { width: 1200, height: 800 }),
    { x: 0, y: 0, width: 1, height: 1 },
  );
});

test("authentication windows stay in the owned browser surface", () => {
  const source = require("node:fs").readFileSync(require.resolve("../electron/browser-host.cjs"), "utf8");
  assert.match(source, /routeAuthenticationToSystemBrowser\(url\)/);
  assert.match(source, /openLogin\(\{ force = false \} = {}\)/);
  assert.doesNotMatch(source, /createWindow:\s*\(options\)\s*=>\s*this\.createAuthView\(options\)/);
});

test("Temporary Chat navigation does not invoke system login", () => {
  const calls = [];
  const fixture = {
    openLogin: async () => calls.push("login"),
    logger: { error() {} },
  };
  assert.equal(BrowserHost.prototype.routeAuthenticationToSystemBrowser.call(fixture, "https://chatgpt.com/?temporary-chat=true"), false);
  assert.deepEqual(calls, []);
});

test("session refresh auth redirects do not nest an interactive login", () => {
  const calls = [];
  const fixture = {
    manualOperation: "session refresh",
    openLogin: async () => calls.push("login"),
    logger: { error() {} },
  };
  assert.equal(BrowserHost.prototype.routeAuthenticationToSystemBrowser.call(fixture, "https://chatgpt.com/login"), true);
  assert.deepEqual(calls, []);
});

test("concurrent login requests share one authentication operation", async () => {
  let resolveLogin;
  let loginCalls = 0;
  const fixture = {
    state: { authenticated: false },
    loginOperation: null,
    show() {},
    setState() {},
    snapshot() { return { authenticated: false }; },
    logger: { info() {} },
    view: { webContents: { getURL: () => "https://chatgpt.com/", loadURL: async () => {} } },
    loginWithSystemBrowser: async () => {
      loginCalls += 1;
      return await new Promise((resolve) => {
        resolveLogin = resolve;
      });
    },
    installSystemBrowserLogin: async () => ({ authenticated: true, storageState: { cookies: [], origins: [] } }),
    activateHomeSurface() {},
    withManualOperation: async (_name, action) => await action(),
  };
  const first = BrowserHost.prototype.openLogin.call(fixture);
  const second = BrowserHost.prototype.openLogin.call(fixture);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(loginCalls, 1);
  resolveLogin({ authenticated: true, cleanup: async () => {}, storageState: { cookies: [], origins: [] } });
  const snapshot = await first;
  assert.equal(snapshot.authenticated, true);
});

test("logout clears only the owned ChatGPT session and returns to the sign-in surface", async () => {
  const calls = [];
  let currentUrl = "https://chatgpt.com/?temporary-chat=true";
  const authView = { webContents: { isDestroyed: () => false } };
  const fixture = {
    authView,
    state: { authenticated: true, status: "ready" },
    view: {
      webContents: {
        getURL: () => currentUrl,
        loadURL: async (url) => {
          calls.push(["loadURL", url]);
          currentUrl = url;
        },
        session: {
          clearStorageData: async () => calls.push(["clearStorageData"]),
        },
      },
    },
    closeAuthView(view, closeContents, refreshMain) {
      calls.push(["closeAuthView", view, closeContents, refreshMain]);
      this.authView = null;
    },
    setState(patch) {
      this.state = { ...this.state, ...patch };
      calls.push(["setState", patch]);
    },
    probeAuthentication: async function () {
      this.state = { ...this.state, authenticated: false, status: "signed-out" };
      calls.push(["probeAuthentication"]);
      return this.snapshot();
    },
    activateHomeSurface() { calls.push(["activateHomeSurface"]); },
    show() { calls.push(["show"]); },
    snapshot() { return { ...this.state, url: currentUrl }; },
    logger: { info(event) { calls.push(["log", event]); } },
    withManualOperation: async (name, action) => {
      calls.push(["manualOperation", name]);
      return await action();
    },
  };

  const result = await BrowserHost.prototype.logout.call(fixture);

  assert.equal(result.authenticated, false);
  assert.equal(result.status, "signed-out");
  assert.deepEqual(calls[0], ["manualOperation", "ChatGPT logout"]);
  assert.deepEqual(calls[1], ["closeAuthView", authView, true, false]);
  assert.deepEqual(calls[2], ["clearStorageData"]);
  assert.deepEqual(calls[4], ["loadURL", "https://chatgpt.com/?temporary-chat=true"]);
  assert.ok(calls.some(([name]) => name === "activateHomeSurface"));
  assert.ok(calls.some(([name]) => name === "show"));
});

test("OAuth completion is confirmed on the primary Temporary Chat surface before login succeeds", async () => {
  let primaryReady = false;
  const stateUpdates = [];
  const completedAuthView = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async () => ({ composer: true, readyState: "complete" }),
    },
  };
  const fixture = {
    activeTraceId: null,
    manualOperation: "ChatGPT login",
    authView: completedAuthView,
    state: { authenticated: false },
    logger: { info() {} },
    view: {
      webContents: {
        getURL: () => primaryReady
          ? "https://chatgpt.com/?temporary-chat=true"
          : "https://chatgpt.com/auth/login",
        isDestroyed: () => false,
        executeJavaScript: async () => ({
          composer: primaryReady,
          readyState: "complete",
        }),
        loadURL: async (url) => {
          assert.equal(url, "https://chatgpt.com/?temporary-chat=true");
          primaryReady = true;
        },
      },
    },
    closeAuthView(view, closeContents, refreshMain) {
      assert.equal(view, completedAuthView);
      assert.equal(closeContents, true);
      assert.equal(refreshMain, false);
      this.authView = null;
    },
    setState(patch) {
      this.state = { ...this.state, ...patch };
      stateUpdates.push(patch);
    },
    snapshot() {
      return this.state;
    },
  };

  const result = await BrowserHost.prototype.probeAuthentication.call(fixture);

  assert.equal(result.authenticated, true);
  assert.equal(fixture.authView, null);
  assert.equal(stateUpdates.at(-1).url, "https://chatgpt.com/?temporary-chat=true");
});

test("an authenticated primary surface closes a stale auth popup before browser automation", async () => {
  const staleAuthView = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async () => ({ composer: false, readyState: "complete" }),
    },
  };
  const closed = [];
  const fixture = {
    activeTraceId: null,
    manualOperation: "connector verification",
    authView: staleAuthView,
    state: { authenticated: true },
    logger: { info() {} },
    view: {
      webContents: {
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        isDestroyed: () => false,
        executeJavaScript: async () => ({ composer: true, readyState: "complete" }),
      },
    },
    closeAuthView(view, closeContents, refreshMain) {
      closed.push([view, closeContents, refreshMain]);
      this.authView = null;
    },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    snapshot() { return this.state; },
  };

  const result = await BrowserHost.prototype.probeAuthentication.call(fixture);

  assert.equal(result.authenticated, true);
  assert.equal(fixture.authView, null);
  assert.deepEqual(closed, [[staleAuthView, true, false]]);
});

test("browser chrome navigation delegates to WebContents navigation history", () => {
  const { calls, webContents } = createContents();
  navigateBrowser(webContents, "back");
  navigateBrowser(webContents, "forward");
  navigateBrowser(webContents, "reload");

  assert.deepEqual(calls, ["back", "reload"]);
  assert.throws(() => navigateBrowser(webContents, "unknown"), /Unknown browser navigation action/);
});

test("browser chrome state is read from the owned WebContents", () => {
  const { webContents } = createContents();
  const state = readBrowserNavigationState(webContents, {
    title: "Fallback",
    url: "about:blank",
    loading: true,
    canGoBack: false,
    canGoForward: true,
  });
  assert.deepEqual(state, {
    title: "ChatGPT",
    url: "https://chatgpt.com/?temporary-chat=true",
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
});

test("embedded ChatGPT is constrained to the owned horizontal viewport", () => {
  assert.match(CHATGPT_VIEWPORT_CSS, /max-width:\s*100% !important/);
  assert.match(CHATGPT_VIEWPORT_CSS, /overflow-x:\s*hidden !important/);
  assert.match(CHATGPT_VIEWPORT_CSS, /overscroll-behavior-x:\s*none !important/);
});

test("launcher delegates smoke execution to the shared browser worker", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/browser-host.cjs"), "utf8");
  assert.doesNotMatch(source, /Input\.dispatch|send-button|conversation-turn-|menuitemradio/);
  assert.match(source, /operation:\s*"smoke"/);
  assert.match(source, /operation:\s*"inspect"/);

  const calls = [];
  const fixture = {
    helper: { executable: "/runtime/electron", script: "/runtime/browser-helper.cjs" },
    descriptorPath: "/runtime/launcher-browser.json",
    logger: { info: (...args) => calls.push(["log", ...args]) },
    show: () => calls.push(["show"]),
    waitForSurfaceReady: async () => calls.push(["ready"]),
    setState: patch => calls.push(["state", patch]),
    runBrowserHelperOperation: async options => {
      calls.push(["helper", options]);
      return { type: "result", value: { effort: "High", response: "CODEX WEB GPT READY" } };
    },
  };

  assert.deepEqual(await BrowserHost.prototype.runSmokeTest.call(fixture), {
    ok: true,
    effort: "High",
    response: "CODEX WEB GPT READY",
  });
  const helperCall = calls.find(call => call[0] === "helper")[1];
  assert.equal(helperCall.operation, "smoke");
  assert.equal(helperCall.appName, "Goose Native");
});

test("connector verification is effort-independent and works while the browser surface is hidden", async () => {
  const calls = [];
  const fixture = {
    helper: { executable: "/runtime/electron", script: "/runtime/browser-helper.cjs" },
    descriptorPath: "/runtime/launcher-browser.json",
    logger: { info: (event, detail) => calls.push(["log", event, detail]) },
    setState: (patch) => calls.push(["state", patch]),
    show: () => calls.push(["show"]),
    waitForAuthenticated: async () => calls.push(["authenticated"]),
    refreshChatGptHomeDocument: async () => calls.push(["refresh"]),
    selectHighEffort: async () => {
      throw new Error("connector verification must not select an effort");
    },
    verifyConnectorWithBrowserHelper: async (options) => {
      calls.push(["helper", options]);
      return { ok: true, appName: options.appName };
    },
    view: {
      webContents: {
        getURL: () => "about:blank",
        loadURL: async (url) => calls.push(["load", url]),
      },
    },
  };

  const result = await BrowserHost.prototype.runConnectorVerification.call(fixture, "Codex Native");

  assert.deepEqual(result, { ok: true, appName: "Codex Native" });
  assert.equal(calls.some(([type]) => type === "show"), false);
  assert.deepEqual(
    calls.filter(([type]) => ["load", "helper"].includes(type)),
    [
      ["helper", {
        helper: fixture.helper,
        descriptorPath: fixture.descriptorPath,
        appName: "Codex Native",
        logger: fixture.logger,
      }],
    ],
  );
});

test("connector verification has no independent CDP typing or coordinate-click path", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/browser-host.cjs"), "utf8");
  const start = source.indexOf("async runConnectorVerification");
  const end = source.indexOf("async inspectSession", start);
  const verificationSource = source.slice(start, end);
  assert.match(source, /verifyConnectorWithBrowserHelper/);
  assert.doesNotMatch(verificationSource, /typeTrustedBrowserText|clickTrustedBrowserPoint|connectorMenuOpen|waitForConnectorSuggestion/);
});

test("a live helper retains exclusive ownership of its running turn", () => {
  const tab = {
    id: "tab-live-owner",
    traceId: "trace_live_owner",
    helperPid: process.pid,
    status: "running",
  };
  assert.throws(
    () => BrowserHost.prototype.beginTurn.call({
      manualOperation: null,
      turnTabs: new Map([[tab.id, tab]]),
    }, tab.traceId, false, process.pid + 1),
    /owned by another helper process/,
  );
});

test("a replacement helper takes over only after the previous owner exited", () => {
  const deadPid = 2_147_483_647;
  const tab = {
    id: "tab-dead-owner",
    surfaceId: "surface-dead-owner",
    traceId: "trace_dead_owner",
    helperPid: deadPid,
    status: "running",
    loading: true,
    message: "ChatGPT is working",
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling() {},
      },
    },
  };
  const warnings = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[tab.id, tab]]),
    selectedTabId: "home",
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { info() {}, warn: (event, detail) => warnings.push([event, detail]) },
  });

  const lease = BrowserHost.prototype.beginTurn.call(fixture, tab.traceId, false, process.pid);

  assert.deepEqual(lease, { surfaceId: tab.surfaceId, tabId: tab.id });
  assert.equal(tab.helperPid, process.pid);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "browser.stale_turn_owner_replaced");
  assert.equal(warnings[0][1].previousHelperPid, deadPid);
});

test("a live turn heartbeat refreshes its lease and rejects another helper", () => {
  const tab = {
    id: "tab-heartbeat",
    traceId: "trace_heartbeat",
    helperPid: 444,
    status: "running",
    lastHeartbeatAt: 1,
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    snapshot: () => ({ activeTabId: tab.id }),
  });

  const before = Date.now();
  const snapshot = BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, tab.helperPid);

  assert.deepEqual(snapshot, { activeTabId: tab.id });
  assert.ok(tab.lastHeartbeatAt >= before);
  assert.throws(
    () => BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, 445),
    /ownership mismatch: expected 444, received 445/,
  );
});

test("bootstrap and heartbeat expiry reap orphan turn surfaces", () => {
  for (const [kind, tab, now, evidence] of [
    ["bootstrap", {
      id: "tab-bootstrap-orphan",
      traceId: "trace_bootstrap_orphan",
      helperPid: 555,
      status: "running",
      bootstrapReady: false,
      bootstrapDeadlineAt: 100,
      lastHeartbeatAt: 100,
    }, 101, "browser_surface_bootstrap_timeout"],
    ["heartbeat", {
      id: "tab-heartbeat-orphan",
      traceId: "trace_heartbeat_orphan",
      helperPid: 556,
      status: "running",
      bootstrapReady: true,
      bootstrapDeadlineAt: 1,
      lastHeartbeatAt: 100,
    }, 60_100, "helper_heartbeat_expired"],
  ]) {
    const closed = [];
    const warnings = [];
    tab.view = { webContents: { isDestroyed: () => false, close: () => closed.push("contents") } };
    const fixture = Object.assign(Object.create(BrowserHost.prototype), {
      turnTabs: new Map([[tab.id, tab]]),
      closedTurnOwners: new Map(),
      selectedTabId: tab.id,
      window: { contentView: { removeChildView: () => closed.push("view") } },
      view: { webContents: { getURL: () => "about:blank#codex-web-gpt-browser-host" } },
      syncViewVisibility() {},
      hide() {},
      snapshot: () => ({ tabs: [] }),
      publishState() {},
      writeDescriptor() {},
      logger: { warn: (event, detail) => warnings.push([event, detail]) },
    });

    BrowserHost.prototype.reapExpiredTurnTabs.call(fixture, now);

    assert.equal(fixture.turnTabs.size, 0, kind);
    assert.equal(fixture.closedTurnOwners.get(tab.traceId), tab.helperPid, kind);
    assert.deepEqual(closed, ["view", "contents"], kind);
    assert.equal(warnings[0][0], "browser.orphan_turn_reaped", kind);
    assert.equal(warnings[0][1].evidence, evidence, kind);
  }
});

test("connector verification preserves an already hydrated Temporary Chat page", async () => {
  let refreshed = false;
  let loaded = false;
  const fixture = {
    logger: { info() {} },
    setState() {},
    waitForAuthenticated: async () => {},
    refreshChatGptHomeDocument: async () => { refreshed = true; },
    helper: { executable: "/runtime/electron", script: "/runtime/browser-helper.cjs" },
    descriptorPath: "/runtime/launcher-browser.json",
    verifyConnectorWithBrowserHelper: async ({ appName }) => ({ ok: true, appName }),
    view: {
      webContents: {
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        loadURL: async () => { loaded = true; },
      },
    },
  };

  await BrowserHost.prototype.runConnectorVerification.call(fixture, "Codex Native");

  assert.equal(refreshed, true);
  assert.equal(loaded, false);
});

test("launcher session refresh resolves persisted authentication before setup actions", async () => {
  const calls = [];
  const fixture = {
    state: { authenticated: false },
    snapshot: () => ({ authenticated: true }),
    setState: (patch) => calls.push(["state", patch]),
    probeAuthentication: async () => {
      calls.push(["probe"]);
      return { authenticated: true };
    },
    withManualOperation: async (name, action) => {
      calls.push(["operation", name]);
      return await action();
    },
    view: {
      webContents: {
        getURL: () => "about:blank#codex-web-gpt-browser-host",
        loadURL: async (url) => calls.push(["load", url]),
      },
    },
  };

  const state = await BrowserHost.prototype.refreshAuthentication.call(fixture);

  assert.deepEqual(state, { authenticated: true });
  assert.deepEqual(calls, [
    ["operation", "session refresh"],
    ["state", { status: "loading", message: "Checking saved ChatGPT session" }],
    ["load", "https://chatgpt.com/?temporary-chat=true"],
    ["probe"],
  ]);
});

test("launcher session refresh converts aborted auth redirects into signed-out state", async () => {
  const calls = [];
  const fixture = {
    state: { authenticated: true },
    snapshot: () => ({ authenticated: false, status: "signed-out" }),
    setState: (patch) => calls.push(["state", patch]),
    probeAuthentication: async () => {
      calls.push(["probe"]);
      return { authenticated: false, status: "signed-out" };
    },
    withManualOperation: async (name, action) => {
      calls.push(["operation", name]);
      return await action();
    },
    view: {
      webContents: {
        getURL: () => "about:blank#codex-web-gpt-browser-host",
        loadURL: async () => {
          calls.push(["load"]);
          const error = new Error("navigation aborted");
          error.code = "ERR_ABORTED";
          throw error;
        },
      },
    },
  };

  const state = await BrowserHost.prototype.refreshAuthentication.call(fixture);

  assert.deepEqual(state, { authenticated: false, status: "signed-out" });
  assert.deepEqual(calls, [
    ["operation", "session refresh"],
    ["state", { status: "loading", message: "Checking saved ChatGPT session" }],
    ["load"],
    ["state", { status: "signed-out", message: "Sign in to ChatGPT", authenticated: false }],
    ["probe"],
  ]);
});

test("manual browser operations disable background throttling until completion", async () => {
  const throttling = [];
  const surfaces = [];
  const fixture = {
    activeTraceId: null,
    manualOperation: null,
    ready: async () => {},
    activateHomeSurface: () => surfaces.push("home"),
    setState() {},
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (enabled) => throttling.push(enabled),
      },
    },
  };

  const result = await BrowserHost.prototype.withManualOperation.call(fixture, "hidden check", async () => "ok");

  assert.equal(result, "ok");
  assert.deepEqual(surfaces, ["home"]);
  assert.deepEqual(throttling, [false, true]);
  assert.equal(fixture.manualOperation, null);
});

test("manual browser operations wait for BrowserHost readiness before starting", async () => {
  const calls = [];
  let releaseReady;
  const fixture = {
    activeTraceId: null,
    manualOperation: null,
    ready: () => new Promise((resolve) => {
      releaseReady = resolve;
    }),
    activateHomeSurface: () => calls.push("home"),
    setState() {},
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (enabled) => calls.push(["throttle", enabled]),
      },
    },
  };
  const operation = BrowserHost.prototype.withManualOperation.call(fixture, "hidden check", async () => {
    calls.push("action");
    return "ok";
  });
  await Promise.resolve();
  assert.deepEqual(calls, []);
  releaseReady();
  assert.equal(await operation, "ok");
  assert.deepEqual(calls, ["home", ["throttle", false], "action", ["throttle", true]]);
});

test("session inspection waits for the startup refresh rendezvous before taking manual ownership", async () => {
  const calls = [];
  let releaseRefresh;
  const fixture = {
    startupAuthenticationRefresh: new Promise((resolve) => {
      releaseRefresh = resolve;
    }),
    state: { authenticated: true },
    withManualOperation: async (name, action) => {
      calls.push(["manual", name]);
      return await action();
    },
    runSessionInspection: async (detectPro) => {
      calls.push(["inspect", detectPro]);
      return { authenticated: true, temporary: true, url: "https://chatgpt.com/?temporary-chat=true" };
    },
  };
  const resultPromise = BrowserHost.prototype.inspectSession.call(fixture, true);
  await Promise.resolve();
  assert.deepEqual(calls, []);
  releaseRefresh();
  const result = await resultPromise;
  assert.equal(result.authenticated, true);
  assert.deepEqual(calls, [["manual", "session inspection"], ["inspect", true]]);
});

test("session inspection returns login-required when startup refresh proves the saved session is signed out", async () => {
  const calls = [];
  const fixture = {
    startupAuthenticationRefresh: Promise.resolve({ authenticated: false }),
    state: { authenticated: false },
    withManualOperation: async () => {
      calls.push("manual");
      throw new Error("manual operation should not start");
    },
    runSessionInspection: async () => {
      calls.push("inspect");
      throw new Error("helper inspection should not run");
    },
  };

  await assert.rejects(
    BrowserHost.prototype.inspectSession.call(fixture, false),
    /login-required: saved ChatGPT session is not authenticated/,
  );
  assert.deepEqual(calls, []);
});

test("session inspection returns login-required after a completed signed-out startup refresh", async () => {
  const calls = [];
  const fixture = {
    startupAuthenticationRefresh: null,
    state: { authenticated: false },
    withManualOperation: async () => {
      calls.push("manual");
      throw new Error("manual operation should not start");
    },
    runSessionInspection: async () => {
      calls.push("inspect");
      throw new Error("helper inspection should not run");
    },
  };

  await assert.rejects(
    BrowserHost.prototype.inspectSession.call(fixture, false),
    /login-required: saved ChatGPT session is not authenticated/,
  );
  assert.deepEqual(calls, []);
});

test("manual operations show the home surface without discarding retained task tabs", () => {
  const events = [];
  const taskTab = { id: "tab-ready", status: "ready" };
  const fixture = {
    selectedTabId: taskTab.id,
    turnTabs: new Map([[taskTab.id, taskTab]]),
    visible: true,
    surfaceActive: true,
    activeView: () => ({ webContents: { focus: () => events.push("focus") } }),
    syncViewVisibility: () => events.push("visibility"),
    snapshot: () => ({ activeTabId: "home" }),
    publishState: () => events.push("publish"),
    writeDescriptor: () => events.push("descriptor"),
  };

  BrowserHost.prototype.activateHomeSurface.call(fixture);

  assert.equal(fixture.selectedTabId, "home");
  assert.equal(fixture.turnTabs.size, 1);
  assert.deepEqual(events, ["visibility", "focus", "publish", "descriptor"]);
});

test("selected home surface remains represented while task tabs are retained", () => {
  const { webContents } = createContents();
  const taskTab = { id: "tab-ready", traceId: "trace_ready" };
  const fixture = {
    selectedTabId: "home",
    turnTabs: new Map([[taskTab.id, taskTab]]),
    state: {
      title: "ChatGPT",
      status: "signed-out",
      loading: false,
      visible: true,
      surfaceActive: true,
    },
    visible: true,
    surfaceActive: true,
    activeView: () => ({ webContents }),
    selectedTurnTab: () => null,
    tabSnapshot: (tab) => ({ id: tab.id, traceId: tab.traceId, active: false }),
  };

  const snapshot = BrowserHost.prototype.snapshot.call(fixture);

  assert.equal(snapshot.activeTabId, "home");
  assert.deepEqual(snapshot.tabs.map((tab) => tab.id), ["home", "tab-ready"]);
  assert.equal(snapshot.tabs[0].active, true);
});

test("selecting a task tab shows and focuses its owned Playwright surface", () => {
  const visibility = [];
  const focused = [];
  const makeView = (id) => ({
    setVisible: (visible) => visibility.push([id, visible]),
    webContents: { focus: () => focused.push(id) },
  });
  const first = { id: "tab-first", view: makeView("first") };
  const second = { id: "tab-second", view: makeView("second") };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: makeView("home"),
    authView: null,
    turnTabs: new Map([[first.id, first], [second.id, second]]),
    selectedTabId: first.id,
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    snapshot: () => ({ activeTabId: fixture.selectedTabId }),
    publishState() {},
    writeDescriptor() {},
  });

  const state = BrowserHost.prototype.selectTab.call(fixture, second.id);

  assert.equal(fixture.selectedTabId, second.id);
  assert.deepEqual(visibility, [
    ["home", false],
    ["first", false],
    ["second", true],
  ]);
  assert.deepEqual(focused, ["second"]);
  assert.equal(state.activeTabId, second.id);
});

test("a stale helper cannot end a replacement turn with the same trace id", async () => {
  const turnTabs = new Map([["tab-1", {
    id: "tab-1",
    traceId: "trace_same_retry",
    helperPid: 222,
  }]]);
  await assert.rejects(
    BrowserHost.prototype.endTurn.call(
      { turnTabs, closedTurnOwners: new Map() },
      "trace_same_retry",
      111,
      "failed",
      false,
      "stale helper exited",
    ),
    /Browser helper ownership mismatch: expected 222, received 111/,
  );
});

test("closing a running browser tab preserves ownership until its helper reports termination", () => {
  const closed = [];
  const tab = {
    id: "tab-running",
    traceId: "trace_running",
    helperPid: 333,
    status: "running",
    view: {
      webContents: { isDestroyed: () => false, close: () => closed.push("contents") },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView: () => closed.push("view") } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { info() {} },
  });

  BrowserHost.prototype.closeTab.call(fixture, tab.id);

  assert.deepEqual(closed, ["view", "contents"]);
  assert.equal(fixture.closedTurnOwners.get("trace_running"), 333);
  assert.equal(fixture.selectedTabId, "home");
});

test("a later provider round reuses its task tab and restores active ownership", () => {
  const throttling = [];
  const tab = {
    id: "tab-reused",
    surfaceId: "surface-reused",
    traceId: "trace_reused",
    helperPid: 111,
    status: "ready",
    loading: false,
    message: "Task completed",
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (enabled) => throttling.push(enabled),
      },
    },
  };
  const events = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[tab.id, tab]]),
    selectedTabId: "home",
    syncViewVisibility: () => events.push("visible"),
    snapshot: () => ({ tabs: [] }),
    publishState: () => events.push("published"),
    writeDescriptor: () => events.push("descriptor"),
    logger: { info: (event) => events.push(event) },
  });

  const lease = BrowserHost.prototype.beginTurn.call(fixture, "trace_reused", false, 222);

  assert.deepEqual(lease, { surfaceId: "surface-reused", tabId: "tab-reused" });
  assert.equal(tab.helperPid, 222);
  assert.equal(tab.status, "running");
  assert.equal(tab.loading, true);
  assert.equal(tab.message, "ChatGPT is working");
  assert.equal(fixture.selectedTabId, tab.id);
  assert.deepEqual(throttling, [false]);
  assert.deepEqual(events, ["visible", "published", "descriptor", "browser.tab_reused"]);
});

test("five browser tabs are a hard account-safety limit", () => {
  const turnTabs = new Map(Array.from({ length: 5 }, (_unused, index) => [
    `tab-${index + 1}`,
    { ordinal: index + 1 },
  ]));

  assert.throws(
    () => BrowserHost.prototype.createTurnTab.call({ turnTabs }, "trace_six", 444),
    /already has 5 browser tabs.*avoid excessive parallel traffic/,
  );
});

test("ending one browser turn does not stop another running tab", async () => {
  let closedViews = 0;
  let removedViews = 0;
  const ended = {
    id: "tab-ended",
    traceId: "trace_ended",
    helperPid: 555,
    status: "running",
    loading: true,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {}, close: () => { closedViews += 1; } } },
  };
  const active = {
    id: "tab-active",
    traceId: "trace_active",
    helperPid: 666,
    status: "running",
    loading: true,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[ended.id, ended], [active.id, active]]),
    closedTurnOwners: new Map(),
    selectedTabId: ended.id,
    window: { contentView: { removeChildView: (view) => {
      assert.equal(view, ended.view);
      removedViews += 1;
    } } },
    syncViewVisibility() {},
    writeDescriptor() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    hide: () => assert.fail("a second running tab must keep the browser host active"),
    logger: { info() {} },
  });

  await BrowserHost.prototype.endTurn.call(
    fixture,
    ended.traceId,
    ended.helperPid,
    "completed",
    true,
  );

  assert.equal(ended.status, "ready");
  assert.equal(fixture.turnTabs.has(ended.id), false);
  assert.equal(fixture.turnTabs.has(active.id), true);
  assert.equal(fixture.selectedTabId, active.id);
  assert.equal(closedViews, 1);
  assert.equal(removedViews, 1);
  assert.equal(active.status, "running");
  assert.equal(fixture.activeTraceId, active.traceId);
});

test("failed and aborted browser turns release their tab slots", async () => {
  for (const status of ["failed", "aborted"]) {
    let closed = false;
    const tab = {
      id: `tab-${status}`,
      traceId: `trace_${status}`,
      helperPid: 777,
      status: "running",
      loading: true,
      view: { webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling() {},
        close: () => { closed = true; },
      } },
    };
    const fixture = Object.assign(Object.create(BrowserHost.prototype), {
      turnTabs: new Map([[tab.id, tab]]),
      closedTurnOwners: new Map(),
      selectedTabId: tab.id,
      window: { contentView: { removeChildView() {} } },
      syncViewVisibility() {},
      writeDescriptor() {},
      publishState() {},
      snapshot: () => ({ tabs: [] }),
      hide() {},
      logger: { info() {} },
    });

    await BrowserHost.prototype.endTurn.call(
      fixture,
      tab.traceId,
      tab.helperPid,
      status,
      true,
      `turn ${status}`,
    );

    assert.equal(fixture.turnTabs.size, 0);
    assert.equal(fixture.selectedTabId, "home");
    assert.equal(tab.status, status === "aborted" ? "aborted" : "error");
    assert.equal(closed, true);
  }
});
