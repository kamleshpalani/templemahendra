import { Component } from "react";
import { LuHouse, LuRefreshCw, LuTriangleAlert } from "react-icons/lu";
import Button from "./ui/Button";
import "./ErrorBoundary.css";

/**
 * Top-level crash screen. Mounted OUTSIDE the router and language provider
 * (see main.jsx), so it renders plain anchors and English copy only.
 */
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
        <main className="section errorboundary" role="alert">
          <div className="container container--narrow">
            <div className="empty-state empty-state--error errorboundary__panel">
              <span className="empty-state__icon" aria-hidden="true">
                <LuTriangleAlert />
              </span>
              <h1 className="empty-state__title errorboundary__title">Something went wrong</h1>
              <p>The page could not load. Please refresh; if the problem continues, contact the temple office.</p>
              <div className="empty-state__actions">
                <Button variant="primary" icon={<LuRefreshCw aria-hidden="true" />} onClick={() => window.location.reload()}>
                  Reload page
                </Button>
                <Button href="/" variant="outline" icon={<LuHouse aria-hidden="true" />}>
                  Go home
                </Button>
              </div>

              {showDetails && (
                <details className="errorboundary__details">
                  <summary className="errorboundary__summary">Error details (development only)</summary>
                  <pre className="errorboundary__stack">
                    {this.state.error.toString()}
                    {"\n\n"}
                    {this.state.error.stack}
                    {"\n\nComponent Stack:"}
                    {this.state.info?.componentStack}
                  </pre>
                </details>
              )}
            </div>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
