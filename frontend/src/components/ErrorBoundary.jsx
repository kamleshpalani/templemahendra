import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("App crashed:", error, info);
    this.setState({ info });
  }

  render() {
    if (this.state.error) {
      const showDetails = import.meta.env.DEV;
      return (
        <main className="section" role="alert">
          <div className="container container--narrow">
            <div className="empty-state card card--static" style={{ padding: "var(--space-12) var(--space-6)" }}>
              <span className="empty-state__icon" aria-hidden="true">🙏</span>
              <h1 className="empty-state__title" style={{ fontSize: "var(--text-xl)" }}>
                Something went wrong
              </h1>
              <p>The page could not load. Please refresh; if the problem continues, contact the temple office.</p>
              <div className="cluster" style={{ justifyContent: "center" }}>
                <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                  Reload page
                </button>
                <a href="/" className="btn btn-outline">Go home</a>
              </div>
              {showDetails && (
                <pre
                  style={{
                    marginTop: "var(--space-6)",
                    padding: "var(--space-4)",
                    textAlign: "left",
                    background: "var(--danger-bg)",
                    border: "1px solid var(--danger-border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "0.75rem",
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                    color: "var(--danger)",
                    wordBreak: "break-all",
                  }}
                >
                  {this.state.error.toString()}
                  {"\n\n"}
                  {this.state.error.stack}
                  {"\n\nComponent Stack:"}
                  {this.state.info?.componentStack}
                </pre>
              )}
            </div>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
