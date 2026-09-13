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
        name: "தபலவார் ரேணுகா தேவி லிங்கம்மா சின்னம்மாள் கோவில் | Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple",
        short_name: "Dhabbalavaar Temple",
        description:
          "Official temple app — poojas, sevas, events, donations & more.",
        theme_color: "#3d0707",
        background_color: "#fffbf5",
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
        // Web Push handlers (push, notificationclick) live in public/push-sw.js
        // as a plain script, loaded into the generated worker. See SPEC §7.4.
        importScripts: ["push-sw.js"],
        // Workbox answers every navigation from the cached index.html. Without
        // this list that includes /admin/ and /admin/login.php, so once the
        // service worker is installed the committee would get the React app
        // instead of the PHP panel — on a correctly configured server, with no
        // way to tell from the outside. Keep in step with the dev-server proxy
        // and with deploy/htaccess_public_html.
        navigateFallbackDenylist: [/^\/api(\/|$)/, /^\/admin(\/|$)/, /^\/uploads(\/|$)/],
        runtimeCaching: [
          {
            // API calls — network-first with 5s timeout, then cache.
            // Same-origin /api on Hostinger, and via the Vite proxy in dev.
            urlPattern: ({ url }) => url.pathname.startsWith("/api"),
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
    // These three paths belong to PHP, not to the React app. In production
    // public_html/.htaccess passes ^(api|admin|uploads) straight through before
    // the SPA fallback rewrite; the dev server has to do the same, or /admin/
    // falls through to the router and renders the React 404 page.
    // Keep this list and deploy/htaccess_public_html in step.
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
      "/admin": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
      "/uploads": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
