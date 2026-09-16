#!/usr/bin/env node
/**
 * tests/support/youtube_mock.mjs — a stand-in for the two YouTube endpoints the
 * live-darshan module may call, so later phases can be driven without the real
 * service (docs/live/SPEC-PHASE1.md §6; the Phase 3 poller is its first user —
 * Phase 1 only starts it to prove it works).
 *
 *   const mock = await startYoutubeMock({ port: 8091 });
 *     GET /oembed?url=<video url>&format=json   → the oEmbed document for the id in the URL
 *     GET /youtube/v3/videos?part=…&id=a,b&key= → videos.list: items with snippet,
 *                                                 liveStreamingDetails and status
 *     POST /token                               → an access token for a refresh_token grant
 *     GET /__health                             → "ok", for the port check
 *   mock.requests[]                             every request, newest last
 *   mock.setVideo(id, { title, liveBroadcastContent, scheduledStartTime, … })
 *   await mock.close()
 *
 * Scenarios are chosen by the LAST FOUR characters of the video id, so a suite
 * never has to configure the mock before a call:
 *   …0404  the video does not exist   videos: 200 with no items · oEmbed: 400
 *   …0429  too many requests           429 with Retry-After: 30
 *   …0500  YouTube is broken           500
 *   …0403  quota exhausted             videos: 403 quotaExceeded · oEmbed: 401 (private / not embeddable)
 * Anything else is a public, embeddable video.
 *
 * With apiKey given, videos.list refuses any other key (400 badRequest) and
 * /token any other client secret (401 invalid_client), so a suite can prove the
 * server sends the right credential — and only in the place it belongs.
 * Nothing here is a secret: keys a suite passes in are invented for the run.
 */

import http from "node:http";
import net from "node:net";

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_URL = /^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|(?:embed|live|shorts|v|e)\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i;

/** The 11-character id in a pasted YouTube link or a bare id, else null (same rules as the PHP parser). */
export function youtubeIdFrom(input) {
  const s = String(input ?? "").trim();
  if (YT_ID.test(s)) return s === "live_stream" ? null : s;
  const m = YT_URL.exec(s);
  if (!m || m[1] === "live_stream") return null;
  return m[1];
}

/** True when something is already listening on a port. */
export function portInUse(port, host = "127.0.0.1") {
  return new Promise((done) => {
    const socket = net.connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

const scenarioOf = (id) => {
  const tail = String(id ?? "").slice(-4);
  return ["0404", "0429", "0500", "0403"].includes(tail) ? tail : "ok";
};

export async function startYoutubeMock({ port, host = "127.0.0.1", apiKey = null, clientSecret = null } = {}) {
  const mock = {
    port,
    host,
    base: `http://${host}:${port}`,
    oembedUrl: `http://${host}:${port}/oembed`,
    apiBaseUrl: `http://${host}:${port}/youtube/v3`,
    tokenUrl: `http://${host}:${port}/token`,
    apiKey,
    clientSecret,
    /** Every request that reached the mock, newest last: { method, path, query, headers }. */
    requests: [],
    /** id → overrides for what videos.list and oEmbed say about it. */
    videos: new Map(),
    tokensIssued: 0,
  };
  mock.setVideo = (id, fields = {}) => {
    mock.videos.set(id, { ...(mock.videos.get(id) ?? {}), ...fields });
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  };
  const text = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
    res.end(body);
  };
  const apiError = (res, code, reason, message, headers = {}) =>
    json(res, code, { error: { code, message, errors: [{ message, domain: reason === "quotaExceeded" ? "youtube.quota" : "global", reason }] } }, headers);

  /** The document videos.list returns for one id (a public, embeddable video unless overridden). */
  const videoItem = (id) => {
    const v = mock.videos.get(id) ?? {};
    const live = v.liveBroadcastContent ?? "none";
    const details = {};
    if (v.scheduledStartTime) details.scheduledStartTime = v.scheduledStartTime;
    if (v.actualStartTime) details.actualStartTime = v.actualStartTime;
    if (v.actualEndTime) details.actualEndTime = v.actualEndTime;
    if (live === "live") details.concurrentViewers = String(v.concurrentViewers ?? 42);
    return {
      kind: "youtube#video",
      etag: `mock-${id}`,
      id,
      snippet: {
        publishedAt: v.publishedAt ?? "2026-01-01T00:00:00Z",
        channelId: v.channelId ?? "UCmockmockmockmockmockmo",
        title: v.title ?? `Mock video ${id}`,
        description: v.description ?? "",
        thumbnails: {
          default: { url: `https://i.ytimg.com/vi/${id}/default.jpg`, width: 120, height: 90 },
          medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, width: 320, height: 180 },
          high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 },
        },
        channelTitle: v.channelTitle ?? "Temple Mahendra",
        liveBroadcastContent: live,
      },
      status: {
        uploadStatus: "processed",
        privacyStatus: v.privacyStatus ?? "public",
        embeddable: v.embeddable ?? true,
        madeForKids: false,
      },
      ...(live === "none" && Object.keys(details).length === 0 ? {} : { liveStreamingDetails: details }),
    };
  };

  function handleOembed(req, res, query) {
    const id = youtubeIdFrom(query.get("url") ?? "");
    if (!id) return text(res, 400, "Bad Request");
    const scenario = scenarioOf(id);
    if (scenario === "0404") return text(res, 400, "Bad Request");
    if (scenario === "0429") return text(res, 429, "Too Many Requests", { "Retry-After": "30" });
    if (scenario === "0500") return text(res, 500, "Internal Server Error");
    if (scenario === "0403") return text(res, 401, "Unauthorized");
    if ((query.get("format") ?? "json") !== "json") return text(res, 501, "Not Implemented");
    const v = mock.videos.get(id) ?? {};
    return json(res, 200, {
      title: v.title ?? `Mock video ${id}`,
      author_name: v.channelTitle ?? "Temple Mahendra",
      author_url: "https://www.youtube.com/@TempleMahendra",
      type: "video",
      height: 113,
      width: 200,
      version: "1.0",
      provider_name: "YouTube",
      provider_url: "https://www.youtube.com/",
      thumbnail_height: 360,
      thumbnail_width: 480,
      thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      html: `<iframe width="200" height="113" src="https://www.youtube.com/embed/${id}?feature=oembed" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen title="${(v.title ?? `Mock video ${id}`).replace(/"/g, "&quot;")}"></iframe>`,
    });
  }

  function handleVideos(req, res, query) {
    if (mock.apiKey !== null && query.get("key") !== mock.apiKey) {
      return apiError(res, 400, "badRequest", "API key not valid. Please pass a valid API key.");
    }
    const ids = (query.get("id") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return apiError(res, 400, "missingRequiredParameter", "No filter selected. Expected one of: id, chart, myRating");
    const scenario = scenarioOf(ids[0]);
    if (scenario === "0429") return apiError(res, 429, "rateLimitExceeded", "Too many requests", { "Retry-After": "30" });
    if (scenario === "0500") return text(res, 500, "Internal Server Error");
    if (scenario === "0403") return apiError(res, 403, "quotaExceeded", "The request cannot be completed because you have exceeded your quota.");
    const items = ids.filter((id) => YT_ID.test(id) && scenarioOf(id) !== "0404").map(videoItem);
    return json(res, 200, {
      kind: "youtube#videoListResponse",
      etag: "mock",
      items,
      pageInfo: { totalResults: items.length, resultsPerPage: items.length },
    });
  }

  function handleToken(req, res, body) {
    const form = Object.fromEntries(new URLSearchParams(body.toString("utf8")));
    if (form.grant_type !== "refresh_token" || !form.refresh_token) {
      return json(res, 400, { error: "unsupported_grant_type", error_description: "Only refresh_token is supported here" });
    }
    if (mock.clientSecret !== null && form.client_secret !== mock.clientSecret) {
      return json(res, 401, { error: "invalid_client", error_description: "The OAuth client was not found." });
    }
    mock.tokensIssued += 1;
    return json(res, 200, { access_token: `mock-access-${mock.tokensIssued}`, expires_in: 3599, scope: "https://www.googleapis.com/auth/youtube.readonly", token_type: "Bearer" });
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", mock.base);
    const query = url.searchParams;
    const record = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(query.entries()),
      headers: { authorization: req.headers.authorization ?? null, "user-agent": req.headers["user-agent"] ?? null },
      body: body.length ? body.toString("utf8").slice(0, 2000) : "",
    };
    mock.requests.push(record);
    try {
      if (req.method === "GET" && url.pathname === "/__health") return text(res, 200, "ok");
      if (url.pathname === "/oembed") return req.method === "GET" ? handleOembed(req, res, query) : text(res, 405, "Method not allowed", { Allow: "GET" });
      if (url.pathname === "/youtube/v3/videos") return req.method === "GET" ? handleVideos(req, res, query) : text(res, 405, "Method not allowed", { Allow: "GET" });
      if (url.pathname === "/token") return req.method === "POST" ? handleToken(req, res, body) : text(res, 405, "Method not allowed", { Allow: "POST" });
      return json(res, 404, { error: { code: 404, message: `Unknown mock route ${url.pathname}`, errors: [{ reason: "notFound" }] } });
    } catch (e) {
      if (!res.headersSent) text(res, 500, `mock error: ${e}`);
      else res.end();
    }
  });
  server.keepAliveTimeout = 1;

  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, ok);
  });

  mock.close = async () => {
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
  };
  return mock;
}
