import axios from "axios";

// In dev: Vite proxies /api → localhost:8000 (see vite.config.js)
// In prod: set VITE_API_URL env var on Vercel → https://your-app.onrender.com/api
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "/api",
  timeout: 10000,
  headers: { Accept: "application/json" },
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    console.error("API error:", err?.response?.status, err?.config?.url);
    return Promise.reject(err);
  },
);

export default api;
