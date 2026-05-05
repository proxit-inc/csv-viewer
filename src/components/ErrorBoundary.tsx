import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="flex flex-col items-center justify-center flex-1 gap-3 p-8"
          style={{ color: "var(--col-text2)" }}
        >
          <p className="text-sm font-medium" style={{ color: "var(--col-text)" }}>
            An error occurred
          </p>
          <pre
            className="text-xs p-3 rounded max-w-lg overflow-auto"
            style={{ background: "var(--col-surface2)", color: "var(--col-text2)" }}
          >
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-3 py-1.5 text-xs rounded"
            style={{ background: "var(--col-accent)", color: "#fff" }}
          >
            Dismiss
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
