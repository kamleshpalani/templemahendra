import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "ஸ்ரீ மகேந்திர ஆலயம் | Sri Mahendra Temple",
        short_name: "Mahendra Temple",
        description:
          "Official temple app — poojas, sevas, events, donations & more.",
        theme_color: "#6b1e1e",
        background_color: "#6b1e1e",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        lang: "ta",
        icons: [
          {
            src: "/icons/icon-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/icons/icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        // Pre-cache all built assets
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        cacheId: "temple-v2",
        runtimeCaching: [
          {
            // API calls — network-first with 5s timeout, then cache
            // Matches both relative /api (dev) and absolute Render URL (prod)
            urlPattern: ({ url }) =>
              url.pathname.startsWith("/api") ||
              url.hostname.endsWith(".onrender.com"),
            handler: "NetworkFirst",
            options: {
              cacheName: "temple-api",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 30, maxAgeSeconds: 3600 },
            },
          },
          {
            // Google Fonts — cache-first
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "temple-fonts",
              expiration: { maxEntries: 10, maxAgeSeconds: 604800 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
