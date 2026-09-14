function booleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function safeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function reasonFromEvent(event) {
  if (!event) return null;
  return event.cause || event.reason || event.message || event.response?.reason_phrase || null;
}

function createNodeSipSocket(WebSocketCtor, url, { onDiagnostic, origin, handshakeTimeoutMs = 10000 } = {}) {
  return new (class NodeSipSocket {
    constructor() {
      const parsed = new URL(url);
      this.url = url;
      this.via_transport = "WSS";
      this.sip_uri = `sip:${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""};transport=ws`;
      this.onconnect = () => {};
      this.ondisconnect = () => {};
      this.ondata = () => {};
      this._ws = null;
      this._manualClose = false;
      this._disconnectNotified = false;
    }

    connect() {
      if (this._ws && (this._ws.readyState === WebSocketCtor.OPEN || this._ws.readyState === WebSocketCtor.CONNECTING)) return;
      this._manualClose = false;
      this._disconnectNotified = false;
      const wsOptions = {
        perMessageDeflate: false,
        handshakeTimeout: Number(handshakeTimeoutMs || 10000)
      };
      if (origin) wsOptions.origin = origin;
      const ws = new WebSocketCtor(this.url, "sip", wsOptions);
      this._ws = ws;

      const notifyDisconnect = (error, code, reason) => {
        if (this._disconnectNotified) return;
        this._disconnectNotified = true;
        this._ws = null;
        onDiagnostic?.({ event: "disconnect", error: Boolean(error), code: code ?? null, reason: reason || null, at: Date.now() });
        this.ondisconnect(Boolean(error), code, reason);
      };

      ws.on("open", () => {
        onDiagnostic?.({ event: "open", at: Date.now() });
        this.onconnect();
      });
      ws.on("upgrade", (response) => {
        onDiagnostic?.({ event: "upgrade", statusCode: response?.statusCode || 101, at: Date.now() });
      });
      ws.on("message", (data) => {
        const message = typeof data === "string" ? data : data.toString("utf8");
        this.ondata(message);
      });
      ws.on("unexpected-response", (_request, response) => {
        const code = Number(response?.statusCode || 0) || 1006;
        const reason = `HTTP ${response?.statusCode || "?"} ${response?.statusMessage || "unexpected WebSocket response"}`;
        onDiagnostic?.({ event: "unexpected-response", statusCode: response?.statusCode || null, statusMessage: response?.statusMessage || null, at: Date.now() });
        try { response?.destroy?.(); } catch {}
        try { ws.terminate(); } catch {}
        notifyDisconnect(true, code, reason);
      });
      ws.on("close", (code, reason) => {
        const text = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
        notifyDisconnect(!this._manualClose && code !== 1000, code, text || (code === 1000 ? "normal closure" : "WebSocket closed"));
      });
      ws.on("error", (error) => {
        const message = safeError(error);
        console.error("[SIP] WSS error:", message);
        onDiagnostic?.({ event: "error", error: message, at: Date.now() });
        try { ws.terminate(); } catch {}
        notifyDisconnect(true, 1006, message);
      });
    }

    disconnect() {
      this._manualClose = true;
      const ws = this._ws;
      if (!ws) return;
      if (ws.readyState === WebSocketCtor.OPEN || ws.readyState === WebSocketCtor.CONNECTING) {
        try { ws.close(1000, "client disconnect"); } catch {}
      }
      this._ws = null;
    }

    send(data) {
      const ws = this._ws;
      if (!ws || ws.readyState !== WebSocketCtor.OPEN) return false;
      try {
        ws.send(String(data));
        return true;
      } catch {
        return false;
      }
    }
  })();
}

export function createSipController(options = {}) {
  const wsUrl = String(options.wsUrl || process.env.SIP_WS_URL || "wss://sip.yemot.co.il:8089/ws").trim();
  const domain = String(options.domain || process.env.SIP_DOMAIN || "sip.yemot.co.il").trim();
  const user = String(options.user || process.env.SIP_USER || "").trim();
  const password = String(options.password || process.env.SIP_PASSWORD || "");
  const uri = String(options.uri || process.env.SIP_URI || (user ? `sip:${user}@${domain}` : "")).trim();
  const displayName = String(options.displayName || process.env.SIP_DISPLAY_NAME || "Aharon Voice AI").trim();
  const registerExpires = Number(options.registerExpires || process.env.SIP_REGISTER_EXPIRES || 300);
  const autoConnect = options.autoConnect ?? booleanEnv("SIP_AUTO_CONNECT", false);
  const rejectUnbridged = options.rejectUnbridged ?? booleanEnv("SIP_REJECT_UNBRIDGED", true);
  const wsOrigin = String(options.wsOrigin || process.env.SIP_WS_ORIGIN || "").trim();
  const wsHandshakeTimeoutMs = Number(options.wsHandshakeTimeoutMs || process.env.SIP_WS_HANDSHAKE_TIMEOUT_MS || 10000);
  const connectTimeoutMs = Number(options.connectTimeoutMs || process.env.SIP_CONNECT_TIMEOUT_MS || 15000);

  let ua = null;
  let socket = null;
  let status = user && password && uri ? "idle" : "disabled";
  let connected = false;
  let registered = false;
  let lastEvent = "init";
  let lastError = null;
  let lastChangedAt = Date.now();
  let incomingCall = null;
  let imports = null;
  let connectPromise = null;
  let lastTransport = null;
  let connectTimeout = null;

  const touch = (event, nextStatus = status, error = undefined) => {
    lastEvent = event;
    status = nextStatus;
    if (error !== undefined) lastError = error;
    lastChangedAt = Date.now();
    console.log(`[SIP] ${event} status=${status}`);
  };

  const info = () => ({
    configured: Boolean(user && password && uri),
    status,
    connected,
    registered,
    wsUrl,
    wsOrigin: wsOrigin || null,
    wsHandshakeTimeoutMs,
    connectTimeoutMs,
    uri: uri || null,
    domain,
    autoConnect: Boolean(autoConnect),
    rejectUnbridged: Boolean(rejectUnbridged),
    registerExpires,
    lastEvent,
    lastError,
    lastChangedAt,
    lastTransport,
    incomingCall
  });

  async function loadDeps() {
    if (imports) return imports;
    const [jssipModule, wsModule] = await Promise.all([import("jssip"), import("ws")]);
    const JsSIP = jssipModule.default || jssipModule;
    const WebSocketCtor = wsModule.WebSocket || wsModule.default || wsModule;
    if (!JsSIP?.UA || !WebSocketCtor) throw new Error("SIP dependencies did not expose the expected APIs");
    imports = { JsSIP, WebSocketCtor };
    return imports;
  }

  function wireUa(nextUa) {
    nextUa.on("connecting", () => touch("connecting", "connecting"));
    nextUa.on("connected", () => {
      connected = true;
      if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
      touch("wss-connected", registered ? "registered" : "connected", null);
    });
    nextUa.on("disconnected", (event) => {
      connected = false;
      registered = false;
      touch("disconnected", "disconnected", reasonFromEvent(event));
    });
    nextUa.on("registered", () => {
      connected = true;
      registered = true;
      if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
      touch("registered", "registered", null);
    });
    nextUa.on("unregistered", (event) => {
      registered = false;
      touch("unregistered", connected ? "connected" : "disconnected", reasonFromEvent(event));
    });
    nextUa.on("registrationFailed", (event) => {
      registered = false;
      touch("registration-failed", connected ? "registration_failed" : "disconnected", reasonFromEvent(event) || "registration failed");
    });
    nextUa.on("newRTCSession", (event) => {
      if (event?.originator !== "remote") return;
      const session = event.session;
      incomingCall = {
        at: Date.now(),
        from: session?.remote_identity?.uri?.toString?.() || null,
        displayName: session?.remote_identity?.display_name || null,
        state: "incoming"
      };
      touch("incoming-call", registered ? "registered" : status);
      if (rejectUnbridged) {
        try {
          session.terminate({ status_code: 480, reason_phrase: "Media bridge not enabled yet" });
          incomingCall.state = "rejected-unbridged";
        } catch (error) {
          incomingCall.state = "reject-failed";
          lastError = safeError(error);
        }
      }
    });
  }

  async function connect() {
    if (!user || !password || !uri) {
      touch("missing-config", "disabled", "Set SIP_USER and SIP_PASSWORD in Hostinger environment variables");
      const error = new Error(lastError);
      error.code = "SIP_NOT_CONFIGURED";
      throw error;
    }
    if (registered || status === "connecting" || connectPromise) return info();

    connectPromise = (async () => {
      try {
        const { JsSIP, WebSocketCtor } = await loadDeps();
        socket = createNodeSipSocket(WebSocketCtor, wsUrl, {
          origin: wsOrigin || undefined,
          handshakeTimeoutMs: wsHandshakeTimeoutMs,
          onDiagnostic: (event) => { lastTransport = event; }
        });
        ua = new JsSIP.UA({
          sockets: [socket],
          uri,
          password,
          authorization_user: user,
          display_name: displayName,
          register: true,
          register_expires: Number.isFinite(registerExpires) ? registerExpires : 300,
          connection_recovery_min_interval: 2,
          connection_recovery_max_interval: 30
        });
        wireUa(ua);
        touch("start", "connecting");
        ua.start();
        if (connectTimeout) clearTimeout(connectTimeout);
        connectTimeout = setTimeout(() => {
          connectTimeout = null;
          if (!connected && !registered && status === "connecting") {
            const message = `SIP WSS connection timed out after ${connectTimeoutMs}ms`;
            touch("connect-timeout", "error", message);
            try { ua?.stop(); } catch {}
          }
        }, connectTimeoutMs);
        connectTimeout.unref?.();
        return info();
      } catch (error) {
        ua = null;
        socket = null;
        connected = false;
        registered = false;
        touch("connect-error", "error", safeError(error));
        throw error;
      } finally {
        connectPromise = null;
      }
    })();
    return connectPromise;
  }

  async function disconnect() {
    if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
    const current = ua;
    ua = null;
    socket = null;
    registered = false;
    connected = false;
    if (current) {
      try { current.stop(); } catch (error) { console.error("[SIP] stop failed:", safeError(error)); }
    }
    touch("stopped", user && password && uri ? "idle" : "disabled");
    return info();
  }

  async function probe() {
    const { WebSocketCtor } = await loadDeps();
    const startedAt = Date.now();
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lastTransport = { ...result, at: Date.now() };
        resolve({
          ok: Boolean(result.ok),
          wsUrl,
          origin: wsOrigin || null,
          elapsedMs: Date.now() - startedAt,
          ...result
        });
      };
      const opts = { perMessageDeflate: false, handshakeTimeout: wsHandshakeTimeoutMs };
      if (wsOrigin) opts.origin = wsOrigin;
      const ws = new WebSocketCtor(wsUrl, "sip", opts);
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch {}
        finish({ ok: false, stage: "timeout", error: `WebSocket probe timed out after ${connectTimeoutMs}ms` });
      }, connectTimeoutMs);
      timer.unref?.();
      ws.on("open", () => {
        finish({ ok: true, stage: "open", protocol: ws.protocol || "sip" });
        try { ws.close(1000, "probe complete"); } catch {}
      });
      ws.on("unexpected-response", (_req, response) => {
        const result = { ok: false, stage: "unexpected-response", statusCode: response?.statusCode || null, statusMessage: response?.statusMessage || null };
        try { response?.destroy?.(); } catch {}
        try { ws.terminate(); } catch {}
        finish(result);
      });
      ws.on("error", (error) => finish({ ok: false, stage: "error", error: safeError(error) }));
      ws.on("close", (code, reason) => {
        if (settled) return;
        const text = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
        finish({ ok: false, stage: "close", code, reason: text || null });
      });
    });
  }

  return { connect, disconnect, probe, info };
}
