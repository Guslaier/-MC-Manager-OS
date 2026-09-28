import type { ReactNode } from "react";

/**
 * Inline error line. Receives the verbatim message produced by
 * `describeError()` so a backend failure is never masked or softened.
 */
export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="error" role="alert">
      {message}
    </p>
  );
}

/** Positive / informational feedback line (e.g. an upload or adopt confirmation). */
export function Notice({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="notice">{message}</p>;
}

/** Warning strip for engine / host refusals and other non-fatal notices. */
export function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="banner" role="status">
      {children}
    </div>
  );
}
