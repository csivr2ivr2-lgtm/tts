import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

function booleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function safeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function reasonFromEvent(event) {
  return event?.cause || event?.reason || event?.message || event?.response?.reason_phrase || null;
}

function createNodeSipSocket(WebSocketCtor, url, { origin, handshakeTimeoutMs, ipFamily, onDiagnostic } = {}) {
  return new (class NodeSipSocket {
    constructor() {
      const parsed = new URL(url);
      this.url = url;
      this.via_transport = "WSS";
      this.sip_uri = `sip:${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""};transport=ws`;
      this.onconnect = () => {};
      this.ondisconnect = () => {};
      this.ondata = () => {};
      this.ws = null;
      this.manualClose = false;
      this.disconnectNotified = false;
    }

    connect() {
      if (this.ws && [WebSocketCtor.OPEN, WebSocketCtor.CONNECTING].includes(this.ws.readyState)) return;
      this.manualClose = false;
      this.disconnectNotified = false;
      const options = { perMessageDeflate: false, handshakeTimeout: Number(handshakeTimeoutMs || 10000) };
      if (ipFamily === 4 || ipFamily === 6) options.family = ipFamily;
      else { options.autoSelectFamily = true; options.autoSelectFamilyAttemptTimeout = 250; }
      if (origin) options.origin = origin;

      const ws = new WebSocketCtor(url, "sip", options);
      this.ws = ws;

      const disconnected = (isError, code, reason) => {
        if (this.disconnectNotified) return;
        this.disconnectNotified = true;
        this.ws = null;
        onDiagnostic?.({ event: "disconnect", error: Boolean(isError), code: code ?? null, reason: reason || null, at: Date.now() });
        this.ondisconnect(Boolean(isError), code, reason);
      };

      ws.on("open", () => { onDiagnostic?.({ event: "open", at: Date.now() }); this.onconnect(); });
      ws.on("upgrade", (response) => onDiagnostic?.({ event: "upgrade", statusCode: response?.statusCode || 101, at: Date.now() }));
      ws.on("message", (data) => this.ondata(typeof data === "string" ? data : data.toString("utf8")));
      ws.on("unexpected-response", (_req, response) => {
        const code = Number(response?.statusCode || 0) || 1006;
        const reason = `HTTP ${response?.statusCode || "?"} ${response?.statusMessage || "unexpected WebSocket response"}`;
        onDiagnostic?.({ event: "unexpected-response", statusCode: response?.statusCode || null, at: Date.now() });
        try { response?.destroy?.(); } catch {}
        try { ws.terminate(); } catch {}
        disconnected(true, code, reason);
      });
      ws.on("close", (code, reason) => {
        const text = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
        disconnected(!this.manualClose && code !== 1000, code, text || null);
      });
      ws.on("error", (error) => {
        const message = safeError(error);
        console.error("[SIP] WSS error:", message);
        onDiagnostic?.({ event: "error", error: message, at: Date.now() });
        try { ws.terminate(); } catch {}
        disconnected(true, 1006, message);
      });
    }

    disconnect() {
      this.manualClose = true;
      const ws = this.ws;
      this.ws = null;
      if (!ws) return;
      try { if ([WebSocketCtor.OPEN, WebSocketCtor.CONNECTING].includes(ws.readyState)) ws.close(1000, "client disconnect"); } catch {}
    }

    send(data) {
      if (!this.ws || this.ws.readyState !== WebSocketCtor.OPEN) return false;
      try { this.ws.send(String(data)); return true; } catch { return false; }
    }
  })();
}

export function createSipController(options = {}) {
  const wsUrl = String(options.wsUrl || process.env.SIP_WS_URL || "wss://sip.yemot.co.il/ws").trim();
  const domain = String(options.domain || process.env.SIP_DOMAIN || "sip.yemot.co.il").trim();
  const user = String(options.user || process.env.SIP_USER || "").trim();
  const password = String(options.password || process.env.SIP_PASSWORD || "");
  const ha1 = String(options.ha1 || process.env.SIP_HA1 || "").trim();
  const realm = String(options.realm || process.env.SIP_REALM || `${domain}.wss`).trim();
  const uri = String(options.uri || process.env.SIP_URI || (user ? `sip:${user}@${domain}` : "")).trim();
  const displayName = String(options.displayName || process.env.SIP_DISPLAY_NAME || "Aharon Voice AI").trim();
  const registerExpires = Number(options.registerExpires || process.env.SIP_REGISTER_EXPIRES || 300);
  const autoConnect = options.autoConnect ?? booleanEnv("SIP_AUTO_CONNECT", false);
  const connectionRecovery = options.connectionRecovery ?? booleanEnv("SIP_CONNECTION_RECOVERY", false);
  const rejectUnbridged = options.rejectUnbridged ?? booleanEnv("SIP_REJECT_UNBRIDGED", true);
  const wsOrigin = String(options.wsOrigin || process.env.SIP_WS_ORIGIN || "").trim();
  const wsHandshakeTimeoutMs = Number(options.wsHandshakeTimeoutMs || process.env.SIP_WS_HANDSHAKE_TIMEOUT_MS || 10000);
  const connectTimeoutMs = Number(options.connectTimeoutMs || process.env.SIP_CONNECT_TIMEOUT_MS || 15000);
  const requestedFamily = Number(options.ipFamily ?? process.env.SIP_IP_FAMILY ?? 0);
  const ipFamily = requestedFamily === 4 || requestedFamily === 6 ? requestedFamily : 0;
  const hasCredential = Boolean(ha1 || password);

  let ua = null;
  let socket = null;
  let imports = null;
  let connectPromise = null;
  let connectTimer = null;
  let status = user && uri && hasCredential ? "idle" : "disabled";
  let connected = false;
  let registered = false;
  let lastEvent = "init";
  let lastError = null;
  let lastChangedAt = Date.now();
  let lastTransport = null;
  let incomingCall = null;

  const touch = (event, nextStatus = status, error = undefined) => {
    lastEvent = event;
    status = nextStatus;
    if (error !== undefined) lastError = error;
    lastChangedAt = Date.now();
    console.log(`[SIP] ${event} status=${status}`);
  };

  const info = () => ({
    configured: Boolean(user && uri && hasCredential), status, connected, registered, wsUrl,
    wsOrigin: wsOrigin || null, wsHandshakeTimeoutMs, connectTimeoutMs,
    connectionRecovery: Boolean(connectionRecovery), ipFamily: ipFamily || "auto", uri: uri || null,
    domain, realm, authMode: ha1 ? "ha1" : (password ? "password" : "none"),
    autoConnect: Boolean(autoConnect), rejectUnbridged: Boolean(rejectUnbridged), registerExpires,
    lastEvent, lastError, lastChangedAt, lastTransport, incomingCall
  });

  async function loadDeps() {
    if (imports) return imports;
    const [jssipModule, wsModule] = await Promise.all([import("jssip"), import("ws")]);
    const JsSIP = jssipModule.default || jssipModule;
    const WebSocketCtor = wsModule.WebSocket || wsModule.default || wsModule;
    if (!JsSIP?.UA || !WebSocketCtor) throw new Error("SIP dependencies did not expose expected APIs");
    imports = { JsSIP, WebSocketCtor };
    return imports;
  }

  function wireUa(nextUa) {
    nextUa.on("connecting", () => touch("connecting", "connecting"));
    nextUa.on("connected", () => {
      connected = true;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      touch("wss-connected", registered ? "registered" : "connected", null);
    });
    nextUa.on("registered", () => {
      connected = true; registered = true;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      touch("registered", "registered", null);
    });
    nextUa.on("unregistered", (event) => { registered = false; touch("unregistered", connected ? "connected" : "disconnected", reasonFromEvent(event)); });
    nextUa.on("registrationFailed", (event) => { registered = false; touch("registration-failed", connected ? "registration_failed" : "disconnected", reasonFromEvent(event) || "registration failed"); });
    nextUa.on("disconnected", (event) => {
      connected = false; registered = false;
      touch("disconnected", "disconnected", reasonFromEvent(event));
      if (!connectionRecovery) setImmediate(() => { try { nextUa.stop(); } catch {} });
    });
    nextUa.on("newRTCSession", (event) => {
      if (event?.originator !== "remote") return;
      const session = event.session;
      incomingCall = { at: Date.now(), from: session?.remote_identity?.uri?.toString?.() || null, displayName: session?.remote_identity?.display_name || null, state: "incoming" };
      touch("incoming-call", registered ? "registered" : status);
      if (rejectUnbridged) {
        try { session.terminate({ status_code: 480, reason_phrase: "Media bridge not enabled yet" }); incomingCall.state = "rejected-unbridged"; }
        catch (error) { incomingCall.state = "reject-failed"; lastError = safeError(error); }
      }
    });
  }

  async function connect() {
    if (!user || !uri || !hasCredential) {
      touch("missing-config", "disabled", "Set SIP_USER and either SIP_HA1 or SIP_PASSWORD");
      const error = new Error(lastError); error.code = "SIP_NOT_CONFIGURED"; throw error;
    }
    if (ha1 && !/^[a-f0-9]{32}$/i.test(ha1)) {
      const error = new Error("SIP_HA1 must be a 32-character hexadecimal MD5 HA1 value"); error.code = "SIP_INVALID_HA1"; throw error;
    }
    if (registered || status === "connecting" || connectPromise) return info();

    connectPromise = (async () => {
      try {
        const { JsSIP, WebSocketCtor } = await loadDeps();
        socket = createNodeSipSocket(WebSocketCtor, wsUrl, { origin: wsOrigin || undefined, handshakeTimeoutMs: wsHandshakeTimeoutMs, ipFamily, onDiagnostic: (event) => { lastTransport = event; } });
        const uaConfig = {
          sockets: [socket], uri, authorization_user: user, display_name: displayName, register: true,
          register_expires: Number.isFinite(registerExpires) ? registerExpires : 300,
          connection_recovery_min_interval: connectionRecovery ? 2 : 600,
          connection_recovery_max_interval: connectionRecovery ? 30 : 600
        };
        if (ha1) { uaConfig.ha1 = ha1; uaConfig.realm = realm; } else uaConfig.password = password;
        ua = new JsSIP.UA(uaConfig);
        wireUa(ua);
        touch("start", "connecting");
        ua.start();
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = setTimeout(() => {
          connectTimer = null;
          if (!connected && !registered && status === "connecting") {
            const message = `SIP WSS connection timed out after ${connectTimeoutMs}ms`;
            touch("connect-timeout", "error", message);
            try { ua?.stop(); } catch {}
          }
        }, connectTimeoutMs);
        connectTimer.unref?.();
        return info();
      } catch (error) {
        ua = null; socket = null; connected = false; registered = false;
        touch("connect-error", "error", safeError(error));
        throw error;
      } finally { connectPromise = null; }
    })();
    return connectPromise;
  }

  async function disconnect() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    const current = ua;
    ua = null; socket = null; connected = false; registered = false;
    if (current) try { current.stop(); } catch (error) { console.error("[SIP] stop failed:", safeError(error)); }
    touch("stopped", user && uri && hasCredential ? "idle" : "disabled");
    return info();
  }

  async function probe() {
    const { WebSocketCtor } = await loadDeps();
    const started = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (result, ws) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { ws?.terminate?.(); } catch {}
        lastTransport = { ...result, at: Date.now() };
        resolve({ ok: Boolean(result.ok), wsUrl, origin: wsOrigin || null, elapsedMs: Date.now() - started, ...result });
      };
      const opts = { perMessageDeflate: false, handshakeTimeout: wsHandshakeTimeoutMs };
      if (ipFamily) opts.family = ipFamily;
      if (wsOrigin) opts.origin = wsOrigin;
      const ws = new WebSocketCtor(wsUrl, "sip", opts);
      timer = setTimeout(() => finish({ ok: false, stage: "timeout", error: `WebSocket probe timed out after ${connectTimeoutMs}ms` }, ws), connectTimeoutMs);
      timer.unref?.();
      ws.once("open", () => finish({ ok: true, stage: "open", protocol: ws.protocol || "sip" }, ws));
      ws.once("unexpected-response", (_req, response) => finish({ ok: false, stage: "unexpected-response", statusCode: response?.statusCode || null }, ws));
      ws.once("error", (error) => finish({ ok: false, stage: "error", error: safeError(error) }, ws));
      ws.once("close", (code, reason) => finish({ ok: false, stage: "close", code, reason: String(reason || "") || null }, ws));
    });
  }

  async function diagnostics() {
    const parsed = new URL(wsUrl);
    const host = parsed.hostname;
    const port = Number(parsed.port || 443);
    const started = Date.now();
    const timeoutMs = Math.min(Math.max(wsHandshakeTimeoutMs, 3000), 10000);
    const result = { ok: false, wsUrl, host, port, elapsedMs: 0, dns: { ok: false, error: null, addresses: [] }, attempts: [], conclusion: "unknown" };
    try {
      result.dns.addresses = await dns.lookup(host, { all: true, verbatim: true });
      result.dns.ok = result.dns.addresses.length > 0;
    } catch (error) {
      result.dns.error = safeError(error); result.conclusion = "dns_failed"; result.elapsedMs = Date.now() - started; return result;
    }
    for (const entry of result.dns.addresses) {
      if (ipFamily && entry.family !== ipFamily) continue;
      const attempt = { address: entry.address, family: entry.family, tcp: null, tls: null };
      result.attempts.push(attempt);
      attempt.tcp = await new Promise((resolve) => {
        const s = net.connect({ host: entry.address, port, family: entry.family });
        const begin = Date.now(); let done = false;
        const finish = (x) => { if (done) return; done = true; clearTimeout(timer); try { s.destroy(); } catch {} resolve({ elapsedMs: Date.now() - begin, ...x }); };
        const timer = setTimeout(() => finish({ ok: false, stage: "timeout" }), timeoutMs);
        s.once("connect", () => finish({ ok: true, stage: "connected" }));
        s.once("error", (error) => finish({ ok: false, stage: "error", error: safeError(error) }));
      });
      if (!attempt.tcp.ok) continue;
      attempt.tls = await new Promise((resolve) => {
        const s = tls.connect({ host: entry.address, port, family: entry.family, servername: host, rejectUnauthorized: true });
        const begin = Date.now(); let done = false;
        const finish = (x) => { if (done) return; done = true; clearTimeout(timer); try { s.destroy(); } catch {} resolve({ elapsedMs: Date.now() - begin, ...x }); };
        const timer = setTimeout(() => finish({ ok: false, stage: "timeout" }), timeoutMs);
        s.once("secureConnect", () => finish({ ok: true, stage: "secure", protocol: s.getProtocol?.() || null }));
        s.once("error", (error) => finish({ ok: false, stage: "error", error: safeError(error) }));
      });
      if (attempt.tls.ok) break;
    }
    const anyTcp = result.attempts.some((x) => x.tcp?.ok);
    const anyTls = result.attempts.some((x) => x.tls?.ok);
    if (!anyTcp) result.conclusion = "tcp_failed";
    else if (!anyTls) result.conclusion = "tls_failed";
    else {
      const wsResult = await probe();
      result.websocket = wsResult; result.ok = wsResult.ok;
      result.conclusion = wsResult.ok ? "websocket_open" : "websocket_handshake_failed";
    }
    result.elapsedMs = Date.now() - started;
    lastTransport = { event: "diagnostics", conclusion: result.conclusion, at: Date.now() };
    return result;
  }

  return { connect, disconnect, probe, diagnostics, info };
}
