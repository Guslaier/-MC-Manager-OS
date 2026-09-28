import { useEffect, useState } from "react";
import type { ContainerMetrics, EngineProbe, ResourceStatus, ServerRecord } from "@mcm/contracts";
import { api } from "../api";

export type ServerFilterType = "all" | "running" | "stopped" | "java" | "bedrock";

interface ServerDashboardProps {
  servers: ServerRecord[];
  metrics: Record<string, ContainerMetrics>;
  engine: EngineProbe | null;
  activeFilter: ServerFilterType;
  searchQuery: string;
  onFilterChange: (filter: ServerFilterType) => void;
  onSearchChange: (query: string) => void;
  onRefresh: () => void;
  onCreate: () => void;
  isRefreshing?: boolean;
}

export function ServerDashboard({
  servers,
  metrics,
  engine,
  activeFilter,
  searchQuery,
  onFilterChange,
  onSearchChange,
  onRefresh,
  onCreate,
  isRefreshing = false,
}: ServerDashboardProps) {
  const [hostStatus, setHostStatus] = useState<ResourceStatus | null>(null);

  useEffect(() => {
    api
      .status()
      .then(setHostStatus)
      .catch(() => setHostStatus(null));
  }, []);

  // Compute cluster statistics
  const totalServers = servers.length;
  const runningServers = servers.filter((s) => s.state === "running");
  const stoppedServers = servers.filter((s) => s.state !== "running");
  const javaServers = servers.filter((s) => s.serverType !== "bedrock");
  const bedrockServers = servers.filter((s) => s.serverType === "bedrock");

  const runningCount = runningServers.length;
  const stoppedCount = stoppedServers.length;
  const javaCount = javaServers.length;
  const bedrockCount = bedrockServers.length;

  // RAM calculations
  const totalAllocatedRamMb = servers.reduce((sum, s) => sum + (s.memoryMb || 0), 0);
  const totalUsedRamMb = runningServers.reduce((sum, s) => {
    const m = metrics[s.id];
    return sum + (m?.memoryMb ? Math.round(m.memoryMb) : 0);
  }, 0);

  const ramUsagePercent =
    totalAllocatedRamMb > 0
      ? Math.min(100, Math.round((totalUsedRamMb / totalAllocatedRamMb) * 100))
      : 0;

  // CPU calculations
  const totalAssignedCores = servers.reduce((sum, s) => sum + (s.cpuCores || 1), 0);
  const runningCores = runningServers.reduce((sum, s) => sum + (s.cpuCores || 1), 0);

  const validCpuSamples = runningServers
    .map((s) => metrics[s.id]?.cpuPercent)
    .filter((p): p is number => p != null && !Number.isNaN(p));

  const avgCpuLoad =
    validCpuSamples.length > 0
      ? Math.round(validCpuSamples.reduce((a, b) => a + b, 0) / validCpuSamples.length)
      : 0;

  const isEngineOk = Boolean(engine?.available);

  return (
    <div className="mcm-dashboard">
      {/* --- Top Metrics Grid --- */}
      <div className="mcm-kpi-grid">
        {/* Card 1: Active Instances */}
        <div className="mcm-kpi-card">
          <div className="mcm-kpi-top">
            <span className="mcm-kpi-label">Active Instances</span>
            <div className="mcm-kpi-icon-wrap emerald">
              <span className="codicon codicon-server-process" aria-hidden="true" />
            </div>
          </div>
          <div className="mcm-kpi-body">
            <div className="mcm-kpi-val-row">
              <span className="mcm-kpi-val">{runningCount}</span>
              <span className="mcm-kpi-subval">/ {totalServers}</span>
              {runningCount > 0 && <span className="mcm-pulse-dot" title="Servers running" />}
            </div>
            <div className="mcm-kpi-pill-group">
              <span className="mcm-kpi-pill green">
                <span className="codicon codicon-pass-filled" /> {runningCount} Online
              </span>
              <span className="mcm-kpi-pill muted">
                <span className="codicon codicon-circle-slash" /> {stoppedCount} Stopped
              </span>
            </div>
          </div>
          <div className="mcm-kpi-footer">
            <span className="muted">
              {javaCount} Java &bull; {bedrockCount} Bedrock
            </span>
          </div>
        </div>

        {/* Card 2: Memory Allocated & In Use */}
        <div className="mcm-kpi-card">
          <div className="mcm-kpi-top">
            <span className="mcm-kpi-label">Memory Usage</span>
            <div className="mcm-kpi-icon-wrap purple">
              <span className="codicon codicon-chip" aria-hidden="true" />
            </div>
          </div>
          <div className="mcm-kpi-body">
            <div className="mcm-kpi-val-row">
              <span className="mcm-kpi-val">
                {totalUsedRamMb >= 1024
                  ? `${(totalUsedRamMb / 1024).toFixed(1)} GB`
                  : `${totalUsedRamMb} MB`}
              </span>
              <span className="mcm-kpi-subval">
                /{" "}
                {totalAllocatedRamMb >= 1024
                  ? `${(totalAllocatedRamMb / 1024).toFixed(1)} GB`
                  : `${totalAllocatedRamMb} MB`}
              </span>
            </div>
            <div className="mcm-mini-bar-wrap">
              <div className="mcm-mini-bar">
                <div
                  className="mcm-mini-bar-fill purple"
                  style={{ width: `${ramUsagePercent}%` }}
                />
              </div>
              <span className="mcm-mini-bar-text">{ramUsagePercent}% allocated</span>
            </div>
          </div>
          <div className="mcm-kpi-footer">
            <span className="muted">
              {hostStatus ? `Host: ${Math.round(hostStatus.totalMemoryMb / 1024)} GB System RAM` : "Container Memory Limit"}
            </span>
          </div>
        </div>

        {/* Card 3: Compute Load & Cores */}
        <div className="mcm-kpi-card">
          <div className="mcm-kpi-top">
            <span className="mcm-kpi-label">Compute Allocation</span>
            <div className="mcm-kpi-icon-wrap sky">
              <span className="codicon codicon-pulse" aria-hidden="true" />
            </div>
          </div>
          <div className="mcm-kpi-body">
            <div className="mcm-kpi-val-row">
              <span className="mcm-kpi-val">{totalAssignedCores}</span>
              <span className="mcm-kpi-subval">Cores Assigned</span>
            </div>
            <div className="mcm-mini-bar-wrap">
              <div className="mcm-mini-bar">
                <div
                  className="mcm-mini-bar-fill sky"
                  style={{ width: `${avgCpuLoad}%` }}
                />
              </div>
              <span className="mcm-mini-bar-text">
                {runningCount > 0 ? `${avgCpuLoad}% avg load` : "Idle"}
              </span>
            </div>
          </div>
          <div className="mcm-kpi-footer">
            <span className="muted">
              {hostStatus ? `Host CPU: ${hostStatus.cpuCount} Cores (Load: ${hostStatus.loadAvg1m.toFixed(2)})` : `${runningCores} cores active`}
            </span>
          </div>
        </div>

        {/* Card 4: Engine Runtime & Isolation */}
        <div className="mcm-kpi-card">
          <div className="mcm-kpi-top">
            <span className="mcm-kpi-label">Runtime Engine</span>
            <div className={`mcm-kpi-icon-wrap ${isEngineOk ? "blue" : "amber"}`}>
              <span className="codicon codicon-shield" aria-hidden="true" />
            </div>
          </div>
          <div className="mcm-kpi-body">
            <div className="mcm-kpi-val-row">
              <span className="mcm-kpi-val">{engine?.mode?.toUpperCase() ?? "NATIVE"}</span>
              <span className={`mcm-badge ${isEngineOk ? "badge-ok" : "badge-warn"}`}>
                {isEngineOk ? "Operational" : "Unavailable"}
              </span>
            </div>
            <div className="mcm-kpi-pill-group">
              <span className="mcm-kpi-pill muted">
                <span className="codicon codicon-terminal" /> {engine?.distro ? `WSL (${engine.distro})` : "Host Process"}
              </span>
            </div>
          </div>
          <div className="mcm-kpi-footer">
            <span className="muted">
              {engine?.runcVersion ? `runc ${engine.runcVersion}` : isEngineOk ? "Isolated Container Mode" : engine?.reason}
            </span>
          </div>
        </div>
      </div>

      {/* --- Filter & Action Bar --- */}
      <div className="mcm-toolbar">
        {/* Search Input */}
        <div className="mcm-search-wrap">
          <span className="codicon codicon-search mcm-search-icon" aria-hidden="true" />
          <input
            type="text"
            className="mcm-search-input"
            placeholder="Search servers by name, port, or version..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="mcm-search-clear"
              onClick={() => onSearchChange("")}
              title="Clear search"
            >
              <span className="codicon codicon-close" />
            </button>
          )}
        </div>

        {/* Filter Segmented Buttons */}
        <div className="mcm-filter-group">
          <button
            type="button"
            className={`mcm-filter-btn ${activeFilter === "all" ? "active" : ""}`}
            onClick={() => onFilterChange("all")}
          >
            All <span className="mcm-count-badge">{totalServers}</span>
          </button>
          <button
            type="button"
            className={`mcm-filter-btn ${activeFilter === "running" ? "active" : ""}`}
            onClick={() => onFilterChange("running")}
          >
            Running <span className="mcm-count-badge green">{runningCount}</span>
          </button>
          <button
            type="button"
            className={`mcm-filter-btn ${activeFilter === "stopped" ? "active" : ""}`}
            onClick={() => onFilterChange("stopped")}
          >
            Stopped <span className="mcm-count-badge muted">{stoppedCount}</span>
          </button>
          <button
            type="button"
            className={`mcm-filter-btn ${activeFilter === "java" ? "active" : ""}`}
            onClick={() => onFilterChange("java")}
          >
            Java <span className="mcm-count-badge amber">{javaCount}</span>
          </button>
          <button
            type="button"
            className={`mcm-filter-btn ${activeFilter === "bedrock" ? "active" : ""}`}
            onClick={() => onFilterChange("bedrock")}
          >
            Bedrock <span className="mcm-count-badge sky">{bedrockCount}</span>
          </button>
        </div>

        <span className="spacer" />

        {/* Actions */}
        <div className="mcm-action-group">
          <button
            type="button"
            className="ghost mcm-refresh-btn"
            onClick={onRefresh}
            disabled={isRefreshing}
            title="Refresh metrics & status"
          >
            <span
              className={`codicon codicon-sync ${isRefreshing ? "spin" : ""}`}
              aria-hidden="true"
            />
            <span>Refresh</span>
          </button>
          <button type="button" className="mcm-primary-btn" onClick={onCreate}>
            <span className="codicon codicon-plus" aria-hidden="true" />
            <span>New Server</span>
          </button>
        </div>
      </div>
    </div>
  );
}
