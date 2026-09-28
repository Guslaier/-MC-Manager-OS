import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ConsoleEvent, ContainerMetrics, ProvisionReport, ServerRecord } from "@mcm/contracts";
import { api, backendOrigin, getToken, type ServerNetworkInfo } from "../api";
import { ErrorText } from "../components/Feedback";
import { UsageBar } from "../components/UsageBar";
import { describeStorage, formatClock, UNAVAILABLE_TEXT } from "../lib/format";

/** Persisted console preferences (font size, timestamps, follow output, wrap lines). */
type ConsolePrefs = {
  fontSize: number;
  showTime: boolean;
  follow: boolean;
  wrap: boolean;
};

const PREFS_KEY = "mcm.console.prefs";
const DEFAULT_PREFS: ConsolePrefs = {
  fontSize: 13,
  showTime: true,
  follow: true,
  wrap: true,
};

function loadPrefs(): ConsolePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ConsolePrefs>;
    return {
      fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : DEFAULT_PREFS.fontSize,
      showTime: typeof parsed.showTime === "boolean" ? parsed.showTime : DEFAULT_PREFS.showTime,
      follow: typeof parsed.follow === "boolean" ? parsed.follow : DEFAULT_PREFS.follow,
      wrap: typeof parsed.wrap === "boolean" ? parsed.wrap : DEFAULT_PREFS.wrap,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Classify log line into severity for badge and color. */
function parseSeverity(event: ConsoleEvent): "info" | "warn" | "error" | "system" | "stdout" {
  if (event.stream === "stderr") return "error";
  if (event.stream === "system") return "system";
  if (/\b(ERROR|SEVERE|FATAL|Exception)\b/i.test(event.line)) return "error";
  if (/\bWARN(ING)?\b/i.test(event.line)) return "warn";
  if (/\bINFO\b/i.test(event.line)) return "info";
  return "stdout";
}

/** Bar tone by load: normal under 70%, warn to 90%, danger above. */
function metricTone(pct: number, base: "cpu" | "ram"): "cpu" | "ram" | "warn" | "danger" {
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return base;
}

const QUICK_COMMANDS = [
  { label: "list", desc: "ผู้เล่นออนไลน์", cmd: "list" },
  { label: "save-all", desc: "บันทึกโลก", cmd: "save-all" },
  { label: "tps", desc: "เช็ค TPS", cmd: "tps" },
  { label: "help", desc: "ดูคำสั่ง", cmd: "help" },
  { label: "day", desc: "ตั้งเวลาเช้า", cmd: "time set day" },
  { label: "clear weather", desc: "เคลียร์ฝน", cmd: "weather clear" },
  { label: "stop", desc: "ปิดเซิร์ฟเวอร์", cmd: "stop" },
];

const BEDROCK_QUICK_COMMANDS = [
  { label: "list", desc: "ผู้เล่นออนไลน์", cmd: "list" },
  { label: "save hold", desc: "เตรียมบันทึก", cmd: "save hold" },
  { label: "save resume", desc: "บันทึกเสร็จสิ้น", cmd: "save resume" },
  { label: "help", desc: "ดูคำสั่ง", cmd: "help" },
  { label: "day", desc: "ตั้งเวลาเช้า", cmd: "time set day" },
  { label: "clear weather", desc: "เคลียร์ฝน", cmd: "weather clear" },
  { label: "stop", desc: "ปิดเซิร์ฟเวอร์", cmd: "stop" },
];

export function ConsoleTab({
  server,
  metrics,
}: {
  server: ServerRecord;
  metrics: ContainerMetrics | null;
}) {
  const serverId = server.id;

  const [events, setEvents] = useState<ConsoleEvent[]>([]);
  const [command, setCommand] = useState("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provision, setProvision] = useState<ProvisionReport | null>(null);
  const [prefs, setPrefs] = useState<ConsolePrefs>(loadPrefs);
  const [showSettings, setShowSettings] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  const [network, setNetwork] = useState<ServerNetworkInfo | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [filter, setFilter] = useState<"all" | "info" | "warn" | "error">("all");
  const [search, setSearch] = useState("");

  const bottom = useRef<HTMLPreElement>(null);
  const socket = useRef<Socket | null>(null);

  // Poll provision report
  useEffect(() => {
    api
      .provision()
      .then(setProvision)
      .catch(() => setProvision(null));
  }, []);

  // Poll server network information (IPv4, IPv6, Online)
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const fetchNet = () => {
      if (inFlight) return;
      inFlight = true;
      api
        .serverNetwork(serverId)
        .then((info) => {
          if (active) setNetwork(info);
        })
        .catch(() => {
          // Retain current network info on transient error to prevent disappearing
        })
        .finally(() => {
          inFlight = false;
        });
    };
    fetchNet();
    const timer = setInterval(fetchNet, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [serverId]);

  // Persist console preferences
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // session-only fallback
    }
  }, [prefs]);

  // Socket.io stream connection
  useEffect(() => {
    setEvents([]);
    const sock = io(backendOrigin || undefined, {
      auth: { token: getToken() },
      query: { serverId },
    });
    socket.current = sock;

    sock.on("connect", () => {
      setConnected(true);
      setError(null);
    });
    sock.on("disconnect", () => setConnected(false));
    sock.on("connect_error", (err: Error) => {
      setConnected(false);
      setError(`Live stream error: ${err.message}`);
    });
    sock.on("console", (event: ConsoleEvent) => {
      setEvents((prev) => [...prev, event]);
    });

    return () => {
      sock.close();
      socket.current = null;
      setConnected(false);
    };
  }, [serverId]);

  // Auto-scroll when new lines arrive
  useEffect(() => {
    if (!prefs.follow) return;
    bottom.current?.scrollTo({ top: bottom.current.scrollHeight });
  }, [events, prefs.follow]);

  // Escape to close settings modal
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);

  function copyToClipboard(text: string, key: string) {
    if (!text) return;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 2000);
  }

  function fallbackCopy(text: string) {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    try {
      document.execCommand("copy");
    } catch {
      // ignore
    }
    document.body.removeChild(el);
  }

  function send(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const line = command.trim();
    if (!line) return;
    if (!connected) {
      setError("Cannot send command: live stream is disconnected.");
      return;
    }
    socket.current?.emit("stdin", { serverId, line });
    setCmdHistory((prev) => (prev[prev.length - 1] === line ? prev : [...prev, line]));
    setHistoryIdx(-1);
    setCommand("");
  }

  function executeQuickCommand(cmd: string) {
    if (!connected) {
      setCommand(cmd);
      return;
    }
    socket.current?.emit("stdin", { serverId, line: cmd });
    setCmdHistory((prev) => (prev[prev.length - 1] === cmd ? prev : [...prev, cmd]));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdHistory.length === 0) return;
      const nextIdx = historyIdx + 1 < cmdHistory.length ? historyIdx + 1 : historyIdx;
      setHistoryIdx(nextIdx);
      setCommand(cmdHistory[cmdHistory.length - 1 - nextIdx] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx > 0) {
        const nextIdx = historyIdx - 1;
        setHistoryIdx(nextIdx);
        setCommand(cmdHistory[cmdHistory.length - 1 - nextIdx] ?? "");
      } else if (historyIdx === 0) {
        setHistoryIdx(-1);
        setCommand("");
      }
    }
  }

  function onScroll() {
    const el = bottom.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }

  function jumpToLatest() {
    bottom.current?.scrollTo({ top: bottom.current.scrollHeight, behavior: "smooth" });
    setPrefs((p) => ({ ...p, follow: true }));
  }

  function exportLogs() {
    const text = events.length
      ? events.map((e) => `[${e.at}] [${e.stream}] ${e.line}`).join("\n")
      : "No console output captured.";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${server.name.replace(/\s+/g, "-").toLowerCase()}-console.log`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  // Filter & Search calculations
  const counts = useMemo(() => {
    let info = 0;
    let warn = 0;
    let error = 0;
    for (const e of events) {
      const s = parseSeverity(e);
      if (s === "error") error++;
      else if (s === "warn") warn++;
      else if (s === "info") info++;
    }
    return { all: events.length, info, warn, error };
  }, [events]);

  const visibleEvents = useMemo(() => {
    return events.filter((e) => {
      const s = parseSeverity(e);
      if (filter === "info" && s !== "info" && s !== "stdout") return false;
      if (filter === "warn" && s !== "warn") return false;
      if (filter === "error" && s !== "error") return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return e.line.toLowerCase().includes(q) || formatClock(e.at).includes(q);
      }
      return true;
    });
  }, [events, filter, search]);

  const isRunning = server.state === "running" || network?.online === true;
  const isReady = network?.ready === true || network?.status === "ready";
  const isExplicitStarting = network?.status === "starting";

  const serverStatus: "ready" | "starting" | "offline" = !isRunning
    ? "offline"
    : isReady
      ? "ready"
      : isExplicitStarting
        ? "starting"
        : "ready";
  const gamePort = network?.gamePort ?? server.gamePort;
  const primaryIpv4 = network?.primaryIpv4 ?? null;
  const primaryIpv6 = network?.primaryIpv6 ?? null;
  const vpnIpv4 = network?.vpnIpv4 ?? null;
  const publicIpv4 = network?.publicIpv4 ?? null;

  const rawCpu = metrics?.cpuPercent ?? null;
  const cores = Math.max(1, server.cpuCores || 1);
  const cpuPct = rawCpu !== null
    ? (rawCpu > 100 ? Math.min(100, Math.round((rawCpu / cores) * 10) / 10) : rawCpu)
    : null;
  const ramPct =
    metrics?.memoryMb != null && metrics.memoryLimitMb > 0
      ? (metrics.memoryMb / metrics.memoryLimitMb) * 100
      : null;
  const storage = describeStorage(metrics);

  const isBedrock = server.serverType === "bedrock";
  const quickCommands = isBedrock ? BEDROCK_QUICK_COMMANDS : QUICK_COMMANDS;
  const v6Port = gamePort;

  const [eulaAcceptedNotice, setEulaAcceptedNotice] = useState(false);
  const [eulaBusy, setEulaBusy] = useState(false);

  const eulaDetected = useMemo(() => {
    if (isBedrock) return false;
    return events.some(
      (e) =>
        e.line.includes("You need to agree to the EULA") ||
        e.line.includes("eula.txt") ||
        e.line.includes("agree to our EULA"),
    );
  }, [events, isBedrock]);

  async function handleAcceptEulaFromConsole() {
    setEulaBusy(true);
    try {
      await api.setEula(serverId, true);
      setEulaAcceptedNotice(true);
    } catch (err) {
      alert("Error accepting EULA: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setEulaBusy(false);
    }
  }

  function renderIpCard({
    id,
    icon,
    iconColor,
    title,
    tag,
    ip,
    port,
    javaAddress,
    isCgnat,
    tooltip,
  }: {
    id: string;
    icon: string;
    iconColor: string;
    title: string;
    tag?: { label: string; tone: "warn" | "vpn" | "rec" | "info" };
    ip: string;
    port: number;
    javaAddress?: string;
    isCgnat?: boolean;
    tooltip?: string;
  }) {
    const ipKey = `${id}-ip`;
    const portKey = `${id}-port`;
    const javaKey = `${id}-java`;
    const isIpCopied = copiedKey === ipKey;
    const isPortCopied = copiedKey === portKey;
    const isJavaCopied = copiedKey === javaKey;

    return (
      <div
        key={id}
        className={`cx-ip-card ${isCgnat ? "is-cgnat" : ""}`}
        title={tooltip}
      >
        <div className="cx-ip-header">
          <div className="cx-ip-title-group">
            <span className={`cx-ip-title-icon codicon ${icon}`} style={{ color: iconColor }} aria-hidden="true" />
            <span className="cx-ip-title">{title}</span>
          </div>
          {tag && <span className={`cx-ip-tag ${tag.tone}`}>{tag.label}</span>}
        </div>

        <div className="cx-ip-chips">
          {isBedrock ? (
            <>
              <button
                type="button"
                className={`cx-ip-chip cx-ip-chip-address ${isIpCopied ? "copied" : ""}`}
                onClick={() => copyToClipboard(ip, ipKey)}
                title={`คลิกคัดลอก IP: ${ip}`}
              >
                <span className="cx-chip-badge">IP</span>
                <span className="cx-chip-value" style={isCgnat ? { textDecoration: "line-through", opacity: 0.7 } : undefined}>
                  {isIpCopied ? "คัดลอกแล้ว!" : ip}
                </span>
                <span className={`codicon cx-chip-icon ${isIpCopied ? "codicon-check" : "codicon-copy"}`} />
              </button>

              <button
                type="button"
                className={`cx-ip-chip cx-ip-chip-port ${isPortCopied ? "copied" : ""}`}
                onClick={() => copyToClipboard(String(port), portKey)}
                title={`คลิกคัดลอก Port: ${port}`}
              >
                <span className="cx-chip-badge">PORT</span>
                <span className="cx-chip-value">
                  {isPortCopied ? "คัดลอกแล้ว!" : port}
                </span>
                <span className={`codicon cx-chip-icon ${isPortCopied ? "codicon-check" : "codicon-copy"}`} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`cx-ip-chip cx-ip-chip-full ${isJavaCopied ? "copied" : ""}`}
              onClick={() => copyToClipboard(javaAddress || `${ip}:${port}`, javaKey)}
              title={`คลิกคัดลอก: ${javaAddress || `${ip}:${port}`}`}
            >
              <span className="cx-chip-value" style={isCgnat ? { textDecoration: "line-through", opacity: 0.7 } : undefined}>
                {isJavaCopied ? "คัดลอกแล้ว!" : (javaAddress || `${ip}:${port}`)}
              </span>
              <span className={`codicon cx-chip-icon ${isJavaCopied ? "codicon-check" : "codicon-copy"}`} />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="console-view">
      <ErrorText message={error} />

      {/* --- Top Connection & Status Banner --- */}
      <div className="cx-banner">
        <div className="cx-banner-status">
          <div
            className="cx-edition-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 10px",
              borderRadius: "20px",
              fontSize: "12px",
              fontWeight: 600,
              background: isBedrock ? "rgba(56, 189, 248, 0.12)" : "rgba(245, 158, 11, 0.12)",
              color: isBedrock ? "#38bdf8" : "#f59e0b",
              border: `1px solid ${isBedrock ? "rgba(56, 189, 248, 0.25)" : "rgba(245, 158, 11, 0.25)"}`,
            }}
          >
            <span className={`codicon ${isBedrock ? "codicon-game" : "codicon-coffee"}`} />
            <span>{isBedrock ? "Bedrock Edition" : "Java Edition"}</span>
          </div>

          <div className="cx-status-pill">
            <span
              className={`cx-pulse-dot ${
                serverStatus === "ready" ? "online" : serverStatus === "starting" ? "starting" : "offline"
              }`}
            />
            <span>
              {serverStatus === "ready"
                ? "Online (พร้อมเข้าเล่น)"
                : serverStatus === "starting"
                  ? "Starting... (กำลังโหลด/รอสักครู่)"
                  : "Server Stopped"}
            </span>
          </div>

          {network?.version && (
            <div className="cx-ver-badge" title="Minecraft Server Version">
              <span className="codicon codicon-tag" aria-hidden="true" />
              <span>{network.version}</span>
            </div>
          )}

          {network?.players && (
            <div className="cx-players-badge" title="Online Players">
              <span className="codicon codicon-account" aria-hidden="true" />
              <span>
                {network.players.online} / {network.players.max} Players
              </span>
            </div>
          )}

          <div className="cx-port-badge" title={isBedrock ? "Minecraft Bedrock UDP Port" : "Minecraft Server Port"}>
            <span className="codicon codicon-plug" aria-hidden="true" />
            <span>Port: {gamePort} {isBedrock ? "(UDP)" : "(TCP)"}</span>
          </div>

          <div
            className="cx-dualstack-badge"
            title={
              isBedrock
                ? "Bedrock Dual-Stack Active (IPv4 + IPv6 UDP)"
                : "JVM Dual-Stack Active: -Djava.net.preferIPv4Stack=false -Djava.net.preferIPv6Addresses=true"
            }
          >
            <span className="codicon codicon-check" aria-hidden="true" />
            <span>Dual-Stack (IPv4 + IPv6)</span>
          </div>
        </div>

        {/* IP Addresses to Connect */}
        <div className="cx-banner-ips">
          {/* Localhost (This PC) */}
          {renderIpCard({
            id: "local",
            icon: "codicon-device-desktop",
            iconColor: "#38bdf8",
            title: "เล่นบนเครื่องนี้ (Localhost)",
            ip: "127.0.0.1",
            port: gamePort,
            javaAddress: `127.0.0.1:${gamePort}`,
            tooltip: "สำหรับเปิดเกมเข้าเล่นบนเครื่องเดียวกันกับที่รันเซิร์ฟเวอร์",
          })}

          {/* LAN IPv4 */}
          {primaryIpv4 &&
            renderIpCard({
              id: "lan",
              icon: "codicon-home",
              iconColor: "#60a5fa",
              title: "วงแลน (Wi-Fi บ้าน)",
              ip: primaryIpv4,
              port: gamePort,
              javaAddress: `${primaryIpv4}:${gamePort}`,
              tooltip: "สำหรับผู้เล่นที่ต่อ Wi-Fi หรือสาย LAN วงเดียวกันในบ้าน",
            })}

          {/* Global IPv6 */}
          {primaryIpv6 &&
            renderIpCard({
              id: "ipv6",
              icon: "codicon-broadcast",
              iconColor: "var(--ok, #3ecf8e)",
              title: "IPv6 Direct (เล่นผ่านเน็ต)",
              ip: primaryIpv6,
              port: v6Port,
              javaAddress: `[${primaryIpv6}]:${v6Port}`,
              tooltip: "เชื่อมต่อตรงผ่าน IPv6 ทะลุอินเทอร์เน็ตโดยไม่ต้องตั้ง Forward Port",
            })}

          {/*  VPN IP */}
          {vpnIpv4 &&
            renderIpCard({
              id: "vpn",
              icon: "codicon-shield",
              iconColor: "#c084fc",
              title: "VPN",
              tag: { label: "VPN", tone: "vpn" },
              ip: vpnIpv4,
              port: gamePort,
              javaAddress: `${vpnIpv4}:${gamePort}`,
              tooltip: "สำหรับเพื่อนที่เชื่อมต่อเครือข่ายเสมือน VPN  เดียวกัน",
            })}

          {/* Public IPv4 (CGNAT Warning) */}
          {publicIpv4 &&
            publicIpv4 !== primaryIpv4 &&
            renderIpCard({
              id: "wan",
              icon: "codicon-globe",
              iconColor: "var(--danger, #ff5c5c)",
              title: "Public IPv4",
              tag: { label: "ติด CGNAT", tone: "warn" },
              ip: publicIpv4,
              port: gamePort,
              javaAddress: `${publicIpv4}:${gamePort}`,
              isCgnat: true,
              tooltip:
                "IP นี้เป็น CGNAT จากผู้ให้บริการอินเทอร์เน็ต คนภายนอกเชื่อมตรงไม่ได้ ให้ใช้ IPv6 หรือ VPN แทน",
            })}
        </div>
      </div>

      {/* --- Main Area: Terminal (Left) + Stats Rail (Right) --- */}
      <div className="cx-shell">
        <div className="cx-main">
          {/* Terminal Toolbar */}
          <div className="cx-toolbar">
            {/* Filter Pills */}
            <div className="cx-filters">
              <button
                type="button"
                className={`cx-filter-btn ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                All ({counts.all})
              </button>
              <button
                type="button"
                className={`cx-filter-btn info ${filter === "info" ? "active" : ""}`}
                onClick={() => setFilter("info")}
              >
                Info ({counts.info})
              </button>
              <button
                type="button"
                className={`cx-filter-btn warn ${filter === "warn" ? "active" : ""}`}
                onClick={() => setFilter("warn")}
              >
                Warn ({counts.warn})
              </button>
              <button
                type="button"
                className={`cx-filter-btn error ${filter === "error" ? "active" : ""}`}
                onClick={() => setFilter("error")}
              >
                Error ({counts.error})
              </button>
            </div>

            {/* Live Search */}
            <div className="cx-search-wrap">
              <span className="codicon codicon-search" aria-hidden="true" />
              <input
                className="cx-search-input"
                placeholder="Search console logs..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="cx-search-clear"
                  onClick={() => setSearch("")}
                  title="Clear search"
                >
                  <span className="codicon codicon-close" />
                </button>
              )}
            </div>

            {/* Actions */}
            <div className="cx-tool-actions">
              <button
                type="button"
                className={prefs.follow ? "cx-iconbtn on" : "cx-iconbtn"}
                title={prefs.follow ? "Auto-scroll: ON" : "Auto-scroll: OFF"}
                aria-pressed={prefs.follow}
                onClick={() => setPrefs((p) => ({ ...p, follow: !p.follow }))}
              >
                <span className="codicon codicon-arrow-down" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="cx-iconbtn"
                title="Clear console view"
                onClick={() => setEvents([])}
              >
                <span className="codicon codicon-clear-all" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="cx-iconbtn"
                title="Export logs to file"
                onClick={exportLogs}
              >
                <span className="codicon codicon-desktop-download" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="cx-iconbtn"
                title="Console display settings"
                onClick={() => setShowSettings(true)}
              >
                <span className="codicon codicon-settings-gear" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Terminal Logs Output */}
          <div className="cx-terminal">
            <pre
              className={`console ${prefs.wrap ? "wrap" : "nowrap"}`}
              ref={bottom}
              onScroll={onScroll}
              style={{ fontSize: `${prefs.fontSize}px` }}
            >
              {visibleEvents.length === 0 ? (
                <div className="cx-empty">
                  <span className="codicon codicon-terminal" style={{ fontSize: "28px" }} />
                  <span>
                    {events.length === 0
                      ? "Waiting for server console output..."
                      : "No log lines match your filter or search query."}
                  </span>
                </div>
              ) : (
                visibleEvents.map((e, i) => {
                  const s = parseSeverity(e);
                  return (
                    <div key={i} className="cx-line">
                      {prefs.showTime && <span className="cx-ts">[{formatClock(e.at)}]</span>}
                      {s !== "stdout" && <span className={`cx-badge ${s}`}>{s}</span>}
                      <span className={`cx-text ${s}`}>{e.line}</span>
                    </div>
                  );
                })
              )}
            </pre>

            {!atBottom && (
              <button type="button" className="cx-jump" onClick={jumpToLatest}>
                <span className="codicon codicon-arrow-down" aria-hidden="true" />
                Jump to latest
              </button>
            )}
          </div>

          {/* Quick Command Buttons Bar */}
          <div className="cx-quick-bar">
            <span className="cx-quick-label">Quick:</span>
            {quickCommands.map((q) => (
              <button
                key={q.cmd}
                type="button"
                className="cx-quick-chip"
                title={`${q.desc} (${q.cmd})`}
                disabled={!connected}
                onClick={() => executeQuickCommand(q.cmd)}
              >
                {q.label}
              </button>
            ))}
          </div>

          {/* EULA Detection Quick Action Banner */}
          {eulaDetected && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 14px",
                background: eulaAcceptedNotice ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)",
                border: `1px solid ${eulaAcceptedNotice ? "rgba(16, 185, 129, 0.35)" : "rgba(245, 158, 11, 0.35)"}`,
                borderRadius: "6px",
                margin: "6px 0",
                fontSize: "12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span
                  className={`codicon ${eulaAcceptedNotice ? "codicon-check" : "codicon-warning"}`}
                  style={{ color: eulaAcceptedNotice ? "#10b981" : "#f59e0b", fontSize: "16px" }}
                />
                <span style={{ color: eulaAcceptedNotice ? "#10b981" : "#f59e0b", fontWeight: 500 }}>
                  {eulaAcceptedNotice
                    ? "ยอมรับ Minecraft EULA สำเร็จแล้ว! สามารถกด Start เซิร์ฟเวอร์ได้เลย"
                    : "ตรวจพบข้อความใน Console: เซิร์ฟเวอร์ต้องการการยอมรับ Minecraft EULA (eula.txt)"}
                </span>
              </div>
              {!eulaAcceptedNotice && (
                <button
                  type="button"
                  className="primary"
                  disabled={eulaBusy}
                  style={{ padding: "4px 12px", fontSize: "11px", whiteSpace: "nowrap" }}
                  onClick={handleAcceptEulaFromConsole}
                >
                  {eulaBusy ? "กำลังบันทึก..." : "ยอมรับ EULA ทันที"}
                </button>
              )}
            </div>
          )}

          {/* Command Composer */}
          <form className="cx-composer" onSubmit={send}>
            <span className="cx-prompt-symbol">❯</span>
            <input
              placeholder="Enter Minecraft command (e.g. list, op player, save-all)... [↑/↓ History]"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button type="submit" disabled={!connected || !command.trim()}>
              Send
            </button>
          </form>
        </div>

        {/* --- Right Monitor Rail --- */}
        <aside className="cx-rail">
          {/* Performance Card */}
          <div className="cx-card">
            <div className="cx-card-head">
              <span className="codicon codicon-pulse" aria-hidden="true" />
              <span>Performance</span>
              <span className="spacer" />
              <span className="muted" style={{ fontSize: "11px" }}>
                {metrics?.source ?? "waiting"}
              </span>
            </div>

            <div className="cx-metric">
              <div className="cx-metric-row">
                <span className="muted">CPU Usage</span>
                <strong>{cpuPct === null ? "n/a" : `${Math.round(cpuPct)}%`}</strong>
              </div>
              <UsageBar
                label={
                  cpuPct === null
                    ? `${server.cpuCores} cores`
                    : `${Math.round(cpuPct)}% of ${server.cpuCores} cores`
                }
                percent={cpuPct ?? 0}
                tone={cpuPct === null ? "muted" : metricTone(cpuPct, "cpu")}
              />
            </div>

            <div className="cx-metric">
              <div className="cx-metric-row">
                <span className="muted">RAM Usage</span>
                <strong>{metrics?.memoryMb != null ? `${metrics.memoryMb} MB` : "n/a"}</strong>
              </div>
              <UsageBar
                label={
                  ramPct === null
                    ? `limit ${metrics?.memoryLimitMb ?? server.memoryMb} MB`
                    : `${Math.round(ramPct)}% of ${metrics?.memoryLimitMb} MB`
                }
                percent={ramPct ?? 0}
                tone={ramPct === null ? "muted" : metricTone(ramPct, "ram")}
              />
            </div>

            <div className="cx-metric">
              <div className="cx-metric-row">
                <span className="muted">Storage</span>
                <strong
                  className={storage.text === UNAVAILABLE_TEXT ? "metric-unavail" : undefined}
                  title={storage.title || undefined}
                >
                  {storage.text}
                </strong>
              </div>
            </div>
          </div>

          {/* Server Process Details */}
          <div className="cx-card">
            <div className="cx-card-head">
              <span className="codicon codicon-server-process" aria-hidden="true" />
              <span>Server Info</span>
            </div>

            <div className="cx-info-list">
              <span className="cx-info-key">State</span>
              <span className="cx-info-val">{server.state}</span>

              <span className="cx-info-key">PID</span>
              <span className="cx-info-val">{server.pid ?? "-"}</span>

              <span className="cx-info-key">Game Port</span>
              <span className="cx-info-val">{gamePort}</span>

              <span className="cx-info-key">{isBedrock ? "Executable" : "Launch Jar"}</span>
              <span className="cx-info-val">{server.jarFile ?? (isBedrock ? "bedrock_server" : "none")}</span>

              <span className="cx-info-key">Host</span>
              <span className="cx-info-val">{provision?.state ?? "..."}</span>
            </div>

            {provision && provision.state !== "distro_ready" && (
              <p className="cx-note" style={{ color: "var(--warn)" }}>
                {provision.reason}
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* --- Settings Modal --- */}
      {showSettings && (
        <div
          className="modal-scrim"
          role="dialog"
          aria-modal="true"
          aria-label="Console settings"
          onClick={() => setShowSettings(false)}
        >
          <div className="modal cx-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Console Display Settings</h2>
            <label className="field">
              Font size: {prefs.fontSize}px
              <input
                type="range"
                min={11}
                max={18}
                value={prefs.fontSize}
                onChange={(e) => setPrefs((p) => ({ ...p, fontSize: Number(e.target.value) }))}
              />
            </label>
            <label className="opt-toggle">
              <input
                type="checkbox"
                checked={prefs.showTime}
                onChange={(e) => setPrefs((p) => ({ ...p, showTime: e.target.checked }))}
              />
              Show timestamps
            </label>
            <label className="opt-toggle">
              <input
                type="checkbox"
                checked={prefs.wrap}
                onChange={(e) => setPrefs((p) => ({ ...p, wrap: e.target.checked }))}
              />
              Wrap long lines
            </label>
            <label className="opt-toggle">
              <input
                type="checkbox"
                checked={prefs.follow}
                onChange={(e) => setPrefs((p) => ({ ...p, follow: e.target.checked }))}
              />
              Follow output (auto-scroll)
            </label>
            <div className="row end">
              <button className="ghost" onClick={() => setShowSettings(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
