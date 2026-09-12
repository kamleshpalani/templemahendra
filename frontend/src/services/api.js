import axios from "axios";

// On Hostinger the API is same-origin (public_html/api/), so "/api" is correct
// in production as well as dev, where Vite proxies it to localhost:8000
// (see vite.config.js). VITE_API_URL only needs setting to point at a backend
// on a different host. `||` rather than `??` so an empty value still falls back.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "/api",
  timeout: 10000,
  headers: { Accept: "application/json" },
  // Devotee accounts use a session cookie. Same-origin requests send it either
  // way; this only matters when VITE_API_URL points at another host, and there
  // the backend must also name that origin in CORS_ORIGIN.
  withCredentials: true,
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    console.error("API error:", err?.response?.status, err?.config?.url);
    return Promise.reject(err);
  },
);

export default api;
