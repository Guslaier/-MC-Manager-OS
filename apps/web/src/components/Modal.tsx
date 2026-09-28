import { useEffect, type ReactNode } from "react";

/**
 * Scrim + Escape-to-close modal shell. Clicking the scrim closes the dialog;
 * clicks inside the panel are stopped so form interaction never dismisses it.
 */
export function Modal({
  ariaLabel,
  className = "",
  onClose,
  children,
}: {
  ariaLabel: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={onClose}
    >
      <div className={`card modal ${className}`.trim()} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
