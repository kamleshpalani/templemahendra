/*
 * push-sw.js — Web Push for the temple site's service worker.
 *
 * vite-plugin-pwa generates the service worker (sw.js) with Workbox. This file
 * is pulled into it by `workbox.importScripts: ["push-sw.js"]` in
 * vite.config.js, so it runs in the worker's global scope. It is a plain
 * script: no imports, no build step, nothing that could fail to load and take
 * the offline cache down with it.
 *
 * What it does (docs/notifications/SPEC.md §7.4):
 *   push               show the notification the server sent, then tell every
 *                      open tab so the bell refreshes at once instead of on its
 *                      next 30-second poll
 *   notificationclick  focus an open tab of this site and take it to the
 *                      message's page; with no tab open, open one
 *
 * The payload comes from backend/includes/notify/providers/NotifyWebPushProvider:
 *   { title, body, url, trackUrl, notificationId, category, priority, tag, image, icon }
 * It is encrypted to this browser, but it is still data from outside the worker:
 * every field is checked before use, and a URL is only ever navigated to in an
 * existing tab when it belongs to this site.
 */

/* global self, clients */

var PUSH_ICON = "/icons/icon-192x192.png";
var PUSH_DEFAULT_TITLE = "Dhabbalavaar Temple";

/** A string, trimmed and capped, or the fallback. */
function pushText(value, max, fallback) {
  if (typeof value !== "string") return fallback;
  var s = value.trim();
  if (!s) return fallback;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * An absolute URL for a site path or an https link, or null. Anything else
 * (javascript:, data:, protocol-relative "//host", plain http to another host)
 * is dropped.
 */
function pushUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  var raw = value.trim();
  if (raw.indexOf("//") === 0) return null;
  try {
    var u = new URL(raw, self.location.origin);
    if (u.origin === self.location.origin) return u.href;
    return u.protocol === "https:" ? u.href : null;
  } catch (e) {
    return null;
  }
}

function sameOrigin(href) {
  try {
    return new URL(href).origin === self.location.origin;
  } catch (e) {
    return false;
  }
}

/** The push payload as an object. Invalid JSON still shows a notification: a push must never be silent. */
function readPayload(event) {
  if (!event || !event.data) return {};
  try {
    var parsed = event.data.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    try {
      return { body: event.data.text() };
    } catch (e2) {
      return {};
    }
  }
}

self.addEventListener("push", function (event) {
  var p = readPayload(event);
  var title = pushText(p.title, 120, PUSH_DEFAULT_TITLE);
  var url = pushUrl(p.url) || self.location.origin + "/notifications";
  var trackUrl = pushUrl(p.trackUrl);
  var notificationId = typeof p.notificationId === "number" && isFinite(p.notificationId) ? p.notificationId : null;
  var priority = typeof p.priority === "string" ? p.priority : "normal";
  var tag = pushText(p.tag, 64, "");

  var options = {
    body: pushText(p.body, 500, ""),
    icon: pushUrl(p.icon) || PUSH_ICON,
    badge: PUSH_ICON,
    // Urgent and emergency messages stay on screen until the devotee acts.
    requireInteraction: priority === "urgent" || priority === "emergency",
    data: { url: url, trackUrl: trackUrl, notificationId: notificationId },
  };
  var image = pushUrl(p.image);
  if (image) options.image = image;
  // renotify without a tag is a TypeError in Chromium, which would lose the message.
  if (tag) {
    options.tag = tag;
    options.renotify = true;
  }

  event.waitUntil(
    self.registration
      .showNotification(title, options)
      .catch(function () {
        // An option this browser rejects (an image it cannot load, say) must not
        // cost the devotee the message itself.
        return self.registration.showNotification(title, { body: options.body, icon: PUSH_ICON, data: options.data });
      })
      .then(function () {
        return clients.matchAll({ type: "window", includeUncontrolled: true });
      })
      .then(function (list) {
        list.forEach(function (client) {
          try {
            client.postMessage({ type: "notification-received", notificationId: notificationId });
          } catch (e) {
            /* a closing tab */
          }
        });
      })
      .catch(function () {})
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var url = pushUrl(data.url) || self.location.origin + "/notifications";
  var trackUrl = pushUrl(data.trackUrl);

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (list) {
        var client = null;
        for (var i = 0; i < list.length; i += 1) {
          if (sameOrigin(list[i].url)) {
            client = list[i];
            if (client.focused) break;
          }
        }

        // An open tab of this site, and a link that belongs to it: reuse the tab.
        if (client && sameOrigin(url)) {
          // The tracked link would have recorded the click on its way through; a
          // tab we navigate directly skips it, so record it alongside. Only our
          // own tracking link, never a third party's.
          if (trackUrl && sameOrigin(trackUrl)) {
            fetch(trackUrl, { method: "GET", credentials: "omit", redirect: "manual", cache: "no-store" }).catch(function () {});
          }
          return client.focus().then(function (focused) {
            var target = focused || client;
            if (typeof target.navigate === "function") {
              return target.navigate(url).catch(function () {
                return clients.openWindow(url);
              });
            }
            return clients.openWindow(url);
          });
        }

        // No tab, or a link to another site: a new window, through the tracked
        // link when there is one so the click is counted.
        return clients.openWindow(trackUrl || url);
      })
      .catch(function () {})
  );
});
