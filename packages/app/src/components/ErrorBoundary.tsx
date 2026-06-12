import React from "react";

interface State {
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

/**
 * App-root error boundary. Catches render-time errors in any descendant and
 * shows a recoverable "something went wrong" screen instead of unmounting
 * the whole React tree.
 *
 * Wraps the entire <App /> in main.tsx. Per the architecture review (F.82),
 * this prevents component crashes from killing the canvas and losing
 * unsaved work — autosave still runs every 30s, but in-progress edits
 * since the last save survive only if the canvas survives.
 *
 * When error reporting (Sentry) lands in v0.2, hook componentDidCatch
 * to capture exceptions.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, errorInfo: null };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ error, errorInfo });
    // eslint-disable-next-line no-console
    console.error("[designjs:boundary]", error, errorInfo);
    // TODO: Sentry.captureException(error, { contexts: { react: { componentStack: errorInfo.componentStack } } });
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            padding: "2rem",
            fontFamily: "system-ui, -apple-system, sans-serif",
            background: "#fff",
            color: "#111",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: "0.875rem", color: "#666", marginBottom: "1.5rem" }}>
            The DesignJS canvas hit an unexpected error. Your last save is intact.
          </p>
          <button
            type="button"
            onClick={() => location.reload()}
            style={{
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              borderRadius: "0.375rem",
              border: "1px solid #ccc",
              background: "#f5f5f5",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          <details style={{ marginTop: "2rem", maxWidth: "600px", fontSize: "0.75rem" }}>
            <summary style={{ cursor: "pointer", color: "#666" }}>
              Diagnostic info (for filing a bug report)
            </summary>
            <pre
              style={{
                background: "#f9f9f9",
                padding: "1rem",
                marginTop: "0.5rem",
                overflow: "auto",
                fontSize: "0.7rem",
                borderRadius: "0.375rem",
                border: "1px solid #eee",
              }}
            >
{this.state.error.stack ?? this.state.error.message}
{this.state.errorInfo?.componentStack ?? ""}
            </pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
