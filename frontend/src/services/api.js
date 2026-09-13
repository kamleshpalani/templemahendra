import axios from "axios";

// On Hostinger the API is same-origin (public_html/api/), so "/api" is correct
// in production as well as dev, where Vite proxies it to localhost:8000
// (see vite.config.js). VITE_API_URL only needs setting to point at a backend
// on a different host. `||` rather than `??` so an empty value still falls back.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "/api",
  timeout: 10000,
  headers: { Accept: "application/json" },
  // No credentials. Devotee sign-in, and the session cookie that came with it,
  // were removed (docs/registration/SPEC.md §1): every public endpoint answers
  // anyone, so a request to a VITE_API_URL on another host has no cookie to
  // carry and needs no credentialed CORS. The committee's /admin panel keeps
  // its own PHP session and never goes through this client.
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    console.error("API error:", err?.response?.status, err?.config?.url);
    return Promise.reject(err);
  },
);

export default api;
