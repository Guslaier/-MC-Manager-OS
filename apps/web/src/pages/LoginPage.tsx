import { useState } from "react";
import type { SessionInfo } from "@mcm/contracts";
import { api, describeError, setToken } from "../api";
import { ErrorText } from "../components/Feedback";

export function LoginPage({ onLogin }: { onLogin: (s: SessionInfo) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(password);
      setToken(res.token);
      onLogin(await api.session());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card login" onSubmit={submit}>
        <h1>MC Manager OS</h1>
        <p className="muted">Sign in with the master password.</p>
        <input
          type="password"
          autoFocus
          placeholder="Master password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorText message={error} />
        <button type="submit" disabled={busy || !password}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
