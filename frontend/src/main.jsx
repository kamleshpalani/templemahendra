import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
// Design system first so component stylesheets can override primitives
import "./index.css";
import { LangProvider } from "./context/LangContext";
import { ToastProvider } from "./context/ToastContext";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HelmetProvider>
        <BrowserRouter>
          <LangProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </LangProvider>
        </BrowserRouter>
      </HelmetProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
