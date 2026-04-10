import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("App crashed:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: "2rem",
            fontFamily: "sans-serif",
            maxWidth: "600px",
            margin: "4rem auto",
            background: "#fff8f0",
            borderRadius: "12px",
            border: "1px solid #dc2626",
          }}
        >
          <h2 style={{ color: "#dc2626" }}>🙏 Something went wrong</h2>
          <p style={{ color: "#3d0707", marginTop: "1rem" }}>
            The page could not load. Please hard-refresh (Ctrl+Shift+R) to clear
            cache.
          </p>
          <details style={{ marginTop: "1rem" }}>
            <summary style={{ cursor: "pointer", color: "#991b1b" }}>
              Error details
            </summary>
            <pre
              style={{
                marginTop: "0.5rem",
                fontSize: "0.75rem",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                color: "#7a3535",
              }}
            >
              {this.state.error.toString()}
            </pre>
          </details>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: "1.5rem",
              padding: "0.6rem 1.4rem",
              background: "#991b1b",
              color: "white",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
              fontSize: "1rem",
            }}
          >
            Reload Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
