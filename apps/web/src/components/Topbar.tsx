export type TopbarSection = "overview" | "status" | "server";

/**
 * Global top bar: brand, primary navigation (Servers / Status), a contextual
 * back button + crumb when a server is open, and the session controls. The
 * active section drives the navigation state highlight.
 */
export function Topbar({
  username,
  section,
  serverName,
  onNavigate,
  onLogout,
}: {
  username: string;
  section: TopbarSection;
  serverName?: string | null;
  onNavigate: (section: "overview" | "status") => void;
  onLogout: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          MC
        </span>
        <strong className="brand-name">MC Manager OS</strong>
      </div>

      <nav className="topbar-nav">
        <button
          className={section === "overview" ? "nav-item active" : "nav-item"}
          aria-current={section === "overview" ? "page" : undefined}
          onClick={() => onNavigate("overview")}
        >
          Servers
        </button>
        <button
          className={section === "status" ? "nav-item active" : "nav-item"}
          aria-current={section === "status" ? "page" : undefined}
          onClick={() => onNavigate("status")}
        >
          Status
        </button>
      </nav>

      {section === "server" && (
        <button className="ghost" onClick={() => onNavigate("overview")}>
          &larr; Servers
        </button>
      )}
      {section === "server" && serverName && <span className="crumb">{serverName}</span>}

      <span className="spacer" />
      <span className="user-chip">{username}</span>
      <button className="ghost" onClick={onLogout}>
        Sign out
      </button>
    </header>
  );
}
