import { Component, type ErrorInfo, type ReactNode } from "react";
import { showToast } from "../lib/toast";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback. If omitted, children continue to render after reset. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to console for devtools and to toast for the user.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info.componentStack);
    showToast("Component crashed", {
      variant: "error",
      detail: error.message || String(error),
    });
  }

  private reset = () => {
    this.setState({ error: null });
  };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex flex-col items-center justify-center h-screen w-screen bg-hx-bg text-hx-text gap-4 p-6">
        <div className="text-hx-danger font-mono text-sm font-bold uppercase tracking-widest">
          ◆ Atlas encountered an error
        </div>
        <pre className="max-w-2xl text-[11px] text-hx-muted whitespace-pre-wrap wrap-break-word font-mono border border-hx-border bg-hx-bg/50 p-3">
          {error.message || String(error)}
        </pre>
        <button
          onClick={this.reset}
          className="hx-clip-btn px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-hx-neon border border-hx-neon/40 hover:border-hx-neon/80 hover:bg-hx-neon/10 transition-all"
        >
          Try to recover
        </button>
      </div>
    );
  }
}
