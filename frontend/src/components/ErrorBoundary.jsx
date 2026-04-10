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
          <pre
            style={{
              marginTop: "1rem",
              padding: "1rem",
              background: "#fee2e2",
              borderRadius: "8px",
              fontSize: "0.8rem",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              color: "#7f1d1d",
              wordBreak: "break-all",
            }}
          >
            {this.state.error.toString()}
            {"\n\n"}
            {this.state.error.stack}
            {"\n\nComponent Stack:"}
            {this.state.info?.componentStack}
          </pre>
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
