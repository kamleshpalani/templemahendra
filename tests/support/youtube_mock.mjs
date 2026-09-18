#!/usr/bin/env node
/**
 * tests/support/youtube_mock.mjs — a stand-in for the YouTube endpoints the
 * live-darshan module may call, so every phase can be driven without the real
 * service, a Google account or a key (docs/live/SPEC-PHASE1.md §6; the Phase 3
 * poller is its main user, docs/live/SPEC-PHASE3.md §10.2 and §10.4).
 *
 *   const mock = await startYoutubeMock({ port: 8092, apiKey, clientSecret, tokenTtl: 3599, rotateRefreshToken: false });
 *     GET  /oembed?url=<video url>&format=json        → the oEmbed document for the id in the URL
 *     GET  /youtube/v3/videos?part=…&id=a,b&key=       → videos.list: snippet, status, liveStreamingDetails.
 *                                                        Credential: ?key= OR Authorization: Bearer <token>
 *     GET  /youtube/v3/liveBroadcasts?part=…&id=a,b    → liveBroadcasts.list (Tier 2): id, status
 *                                                        (lifeCycleStatus, recordingStatus), contentDetails
 *                                                        (boundStreamId). Bearer only.
 *     POST /token                                      → an access token for a refresh_token grant
 *     GET  /__health                                   → "ok", for the port check
 *   mock.requests[]      every request, newest last: { method, path, query, headers (all of them), body }
 *   mock.quotaUnits      units spent: 1 per videos.list or liveBroadcasts.list request, refused ones included
 *   mock.tokensIssued    access tokens /token has issued
 *   mock.setVideo(id, { … })          field-by-field overrides (below); a later call merges into an earlier one
 *   mock.failNext(id, times, scenario) the id's next `times` videos.list requests answer as `scenario`, then normally
 *   mock.beforeAnswer = async (record) => {}  awaited with each request's record before the mock answers it (null: none)
 *   await mock.close()
 *
 * Scenarios are chosen by the LAST FOUR characters of the video id (SPEC-PHASE3
 * §10.2), so a suite never has to configure the mock before a call. Instants are
 * relative to the mock's clock at the moment of the request.
 *   …0404  200 with the id omitted from items[] (missing)      oEmbed: 400
 *   …0429  429 rateLimitExceeded + Retry-After: 30             oEmbed: 429
 *   …0500  500, plain text                                     oEmbed: 500
 *   …0403  403 quotaExceeded, domain youtube.quota             oEmbed: 401
 *   …0401  401 authError on every request (key= or bearer)
 *   …UPCM  upcoming; scheduledStartTime now + 5 min            Tier 2: ready
 *   …STRT  upcoming; scheduledStartTime now + 5 min            Tier 2: testing
 *   …LIVE  live, concurrentViewers; scheduled/actual start now − 5 min   Tier 2: live, recording
 *   …HIDE  as LIVE, concurrentViewers omitted
 *   …DONE  none; scheduled/actual start now − 15 min, actualEndTime now − 5 min   Tier 2: complete, recorded
 *   …PRIV  as LIVE but privacyStatus private: omitted from items[] for a key= request, returned to a valid bearer
 *   …NOEM  as LIVE but embeddable false
 *   …NOLS  a plain upload: no liveStreamingDetails
 *   …RVOK  as UPCM                                            Tier 2: revoked
 *   anything else: a public, embeddable video with liveBroadcastContent "none" and no
 *   liveStreamingDetails — which the poller reads as not_broadcast.
 * Each id in a batch contributes its own item or omission. A whole-response error
 * (429 / 500 / 403 / 401) is returned only when EVERY requested id carries that
 * scenario, as the real API fails a whole request; an error-scenario id in a mixed
 * batch is simply omitted. More than 50 ids → 400 badRequest.
 *
 * setVideo fields (each wins over the scenario default for that field only; null
 * removes a defaulted instant): title, description, channelTitle, channelId,
 * publishedAt, thumbnails, liveBroadcastContent, scheduledStartTime,
 * scheduledEndTime, actualStartTime, actualEndTime, concurrentViewers,
 * concurrentViewersSeq (one value per response, the last one repeating),
 * hideViewers, privacyStatus, embeddable, lifeCycleStatus, recordingStatus,
 * boundStreamId.
 *
 * With apiKey given, a key= request with any other key gets 400 badRequest "API
 * key not valid. Please pass a valid API key."; a bearer the mock did not issue,
 * or one past its tokenTtl, gets 401 authError. With clientSecret given, /token
 * refuses any other client secret (401 invalid_client). /token answers 400
 * invalid_grant for the refresh token mock-refresh-invalid-grant and a plain-text
 * 500 for mock-refresh-unavailable; with rotateRefreshToken it returns a new
 * refresh_token on every grant. Nothing here is a secret: every credential a
 * suite passes in is an obviously fake literal invented for the run.
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

/** Every tail of SPEC-PHASE3 §10.2's table. */
const SCENARIOS = ["0404", "0429", "0500", "0403", "0401", "UPCM", "STRT", "LIVE", "HIDE", "DONE", "PRIV", "NOEM", "NOLS", "RVOK"];
/** The tails that fail a whole request (when every id in it carries the same one). */
const ERROR_SCENARIOS = new Set(["0429", "0500", "0403", "0401"]);

const scenarioOf = (id) => {
  const tail = String(id ?? "").slice(-4);
  return SCENARIOS.includes(tail) ? tail : "ok";
};

/*
 * The defaults each broadcast scenario gives a field the test has not overridden.
 * Instants are minutes from the moment of the request. docs/live/SPEC-PHASE3.md
 * §10.2: liveYoutubeSimulate() answers from the same table.
 */
const UPCOMING = { liveBroadcastContent: "upcoming", scheduledStartTime: 5, lifeCycleStatus: "ready", recordingStatus: "notRecording" };
const LIVE_NOW = { liveBroadcastContent: "live", scheduledStartTime: -5, actualStartTime: -5, lifeCycleStatus: "live", recordingStatus: "recording" };
const SCENARIO_DEFAULTS = {
  UPCM: UPCOMING,
  STRT: { ...UPCOMING, lifeCycleStatus: "testing" },
  LIVE: LIVE_NOW,
  HIDE: { ...LIVE_NOW, hideViewers: true },
  DONE: { liveBroadcastContent: "none", scheduledStartTime: -15, actualStartTime: -15, actualEndTime: -5, lifeCycleStatus: "complete", recordingStatus: "recorded" },
  PRIV: { ...LIVE_NOW, privacyStatus: "private" },
  NOEM: { ...LIVE_NOW, embeddable: false },
  NOLS: {},
  RVOK: { ...UPCOMING, lifeCycleStatus: "revoked" },
};
const INSTANTS = ["scheduledStartTime", "scheduledEndTime", "actualStartTime", "actualEndTime"];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** RFC 3339 in UTC to the second, as the Data API writes it. */
const rfc3339 = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export async function startYoutubeMock({ port, host = "127.0.0.1", apiKey = null, clientSecret = null, tokenTtl = 3599, rotateRefreshToken = false } = {}) {
  const ttl = Number.isInteger(tokenTtl) && tokenTtl > 0 ? tokenTtl : 3599;
  const mock = {
    port,
    host,
    base: `http://${host}:${port}`,
    oembedUrl: `http://${host}:${port}/oembed`,
    apiBaseUrl: `http://${host}:${port}/youtube/v3`,
    tokenUrl: `http://${host}:${port}/token`,
    apiKey,
    clientSecret,
    /** Seconds an issued access token lives (expires_in); a bearer past it is refused. */
    tokenTtl: ttl,
    /** When true, every successful refresh also returns a new refresh_token. */
    rotateRefreshToken: Boolean(rotateRefreshToken),
    /** Every request that reached the mock, newest last: { method, path, query, headers, body }. */
    requests: [],
    /** Units spent: 1 per videos.list or liveBroadcasts.list request, refused ones included. */
    quotaUnits: 0,
    /** id → overrides for what videos.list, liveBroadcasts.list and oEmbed say about it. */
    videos: new Map(),
    /** id → { times, scenario } armed by failNext(). */
    failures: new Map(),
    tokensIssued: 0,
    beforeAnswer: null,
  };
  /** Access tokens this mock issued → the instant (ms) each stops being accepted. */
  const tokens = new Map();
  /** id → how many viewer figures of its concurrentViewersSeq have been served. */
  const viewerSeqPos = new Map();

  mock.setVideo = (id, fields = {}) => {
    if (has(fields, "concurrentViewersSeq")) viewerSeqPos.delete(id);
    mock.videos.set(id, { ...(mock.videos.get(id) ?? {}), ...fields });
  };
  mock.failNext = (id, times, scenario) => {
    if (!SCENARIOS.includes(scenario)) throw new Error(`failNext: "${scenario}" is not a scenario of SPEC-PHASE3 §10.2`);
    const n = Math.floor(Number(times));
    if (!Number.isFinite(n) || n < 0) throw new Error(`failNext: times must be a whole number, got ${times}`);
    if (n === 0) mock.failures.delete(id);
    else mock.failures.set(id, { times: n, scenario });
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
  const authError = (res) => apiError(res, 401, "authError", "Invalid Credentials");
  /** The answer a whole request gets when every id in it carries this error scenario. */
  const wholeError = (res, scenario) => {
    if (scenario === "0429") return apiError(res, 429, "rateLimitExceeded", "Too many requests", { "Retry-After": "30" });
    if (scenario === "0500") return text(res, 500, "Internal Server Error");
    if (scenario === "0403") return apiError(res, 403, "quotaExceeded", "The request cannot be completed because you have exceeded your quota.");
    return authError(res);
  };

  const bearerOf = (req) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization ?? ""));
    return m ? m[1] : null;
  };
  const bearerValid = (token) => tokens.has(token) && tokens.get(token) > Date.now();

  /** The requested ids (duplicates kept, so the 50-id guard counts what was sent). */
  const idsOf = (query) => (query.get("id") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  /** One of the whole-request answers, or null when the ids are fine to answer one by one. */
  const batchRefusal = (res, ids, scenarios, missingMessage) => {
    if (!ids.length) return apiError(res, 400, "missingRequiredParameter", missingMessage);
    if (ids.length > 50) return apiError(res, 400, "badRequest", `Too many ids: at most 50 may be requested at once, got ${ids.length}.`);
    const first = scenarios[0];
    if (ERROR_SCENARIOS.has(first) && scenarios.every((s) => s === first)) return wholeError(res, first);
    return null;
  };

  /** Everything the mock says about one id under one scenario, before it is shaped into an item. */
  const describe = (id, scenario, now) => {
    const v = mock.videos.get(id) ?? {};
    const d = SCENARIO_DEFAULTS[scenario] ?? {};
    const pick = (k) => (has(v, k) ? v[k] : d[k]);
    const live = pick("liveBroadcastContent") ?? "none";
    const instants = {};
    for (const k of INSTANTS) {
      if (has(v, k)) {
        if (v[k] !== null && v[k] !== undefined && v[k] !== "") instants[k] = String(v[k]);
      } else if (typeof d[k] === "number") {
        instants[k] = rfc3339(now + d[k] * 60 * 1000);
      }
    }
    return {
      v,
      live,
      instants,
      privacy: pick("privacyStatus") ?? "public",
      embeddable: pick("embeddable") ?? true,
      hidden: Boolean(pick("hideViewers")),
      lifeCycleStatus: pick("lifeCycleStatus") ?? null,
      recordingStatus: pick("recordingStatus") ?? null,
      broadcast: has(SCENARIO_DEFAULTS, scenario) && scenario !== "NOLS",
    };
  };
  const viewersOf = (id, v) => {
    if (Array.isArray(v.concurrentViewersSeq) && v.concurrentViewersSeq.length) {
      const pos = viewerSeqPos.get(id) ?? 0;
      viewerSeqPos.set(id, pos + 1);
      return v.concurrentViewersSeq[Math.min(pos, v.concurrentViewersSeq.length - 1)];
    }
    return v.concurrentViewers ?? 42;
  };

  /** The document videos.list returns for one id (a public, embeddable video unless the scenario or an override says otherwise). */
  const videoItem = (id, s) => {
    const { v, live } = s;
    const details = { ...s.instants };
    if (live === "live" && !s.hidden) details.concurrentViewers = String(viewersOf(id, v));
    return {
      kind: "youtube#video",
      etag: `mock-${id}`,
      id,
      snippet: {
        publishedAt: v.publishedAt ?? "2026-01-01T00:00:00Z",
        channelId: v.channelId ?? "UCmockmockmockmockmockmo",
        title: v.title ?? `Mock video ${id}`,
        description: v.description ?? "",
        thumbnails: v.thumbnails ?? {
          default: { url: `https://i.ytimg.com/vi/${id}/default.jpg`, width: 120, height: 90 },
          medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, width: 320, height: 180 },
          high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 },
        },
        channelTitle: v.channelTitle ?? "Temple Mahendra",
        liveBroadcastContent: live,
      },
      status: {
        uploadStatus: "processed",
        privacyStatus: s.privacy,
        embeddable: s.embeddable,
        madeForKids: false,
      },
      ...(live === "none" && Object.keys(details).length === 0 ? {} : { liveStreamingDetails: details }),
    };
  };

  /** The document liveBroadcasts.list returns for one id, or null when the id is not a broadcast. */
  const broadcastItem = (id, s) => {
    const { v } = s;
    const tier2Override = ["lifeCycleStatus", "recordingStatus", "boundStreamId"].some((k) => has(v, k));
    const isBroadcast = s.broadcast || tier2Override || s.live !== "none" || Object.keys(s.instants).length > 0;
    if (!isBroadcast) return null;
    const lifeCycleStatus = s.lifeCycleStatus ?? (s.instants.actualEndTime ? "complete" : s.live === "live" ? "live" : "ready");
    const recordingStatus = s.recordingStatus ?? (lifeCycleStatus === "complete" ? "recorded" : lifeCycleStatus === "live" ? "recording" : "notRecording");
    const boundStreamId = has(v, "boundStreamId") ? v.boundStreamId : `mock-stream-${id}`;
    return {
      kind: "youtube#liveBroadcast",
      etag: `mock-bc-${id}`,
      id,
      status: { lifeCycleStatus, privacyStatus: s.privacy, recordingStatus, madeForKids: false, selfDeclaredMadeForKids: false },
      contentDetails: {
        ...(boundStreamId ? { boundStreamId } : {}),
        enableAutoStart: true,
        enableAutoStop: true,
        enableDvr: true,
        recordFromStart: true,
        startWithSlate: false,
        latencyPreference: "normal",
      },
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
    const bearer = bearerOf(req);
    if (bearer !== null) {
      if (!bearerValid(bearer)) return authError(res);
    } else if (mock.apiKey !== null && query.get("key") !== mock.apiKey) {
      return apiError(res, 400, "badRequest", "API key not valid. Please pass a valid API key.");
    }
    const ids = idsOf(query);
    // Each id's scenario for this request: an armed failNext() first (spent once
    // by this request, however often the id repeats in it), else its tail.
    const effective = new Map();
    const scenarios = ids.map((id) => {
      if (effective.has(id)) return effective.get(id);
      let scenario = scenarioOf(id);
      const armed = ids.length <= 50 ? mock.failures.get(id) : null;
      if (armed) {
        armed.times -= 1;
        if (armed.times <= 0) mock.failures.delete(id);
        scenario = armed.scenario;
      }
      effective.set(id, scenario);
      return scenario;
    });
    const refused = batchRefusal(res, ids, scenarios, "No filter selected. Expected one of: id, chart, myRating");
    if (refused !== null) return refused;
    const now = Date.now();
    const seen = new Set();
    const items = [];
    ids.forEach((id, i) => {
      const scenario = scenarios[i];
      if (seen.has(id)) return;
      seen.add(id);
      if (!YT_ID.test(id) || scenario === "0404" || ERROR_SCENARIOS.has(scenario)) return;
      const s = describe(id, scenario, now);
      // As Google does it: a private video is invisible to a key= request and
      // is returned only to the owner's bearer.
      if (s.privacy === "private" && bearer === null) return;
      items.push(videoItem(id, s));
    });
    return json(res, 200, {
      kind: "youtube#videoListResponse",
      etag: "mock",
      items,
      pageInfo: { totalResults: items.length, resultsPerPage: items.length },
    });
  }

  function handleBroadcasts(req, res, query) {
    const bearer = bearerOf(req);
    if (bearer === null || !bearerValid(bearer)) return authError(res);
    const ids = idsOf(query);
    const scenarios = ids.map(scenarioOf);
    const refused = batchRefusal(res, ids, scenarios, "No filter selected. Expected one of: id, mine, broadcastStatus");
    if (refused !== null) return refused;
    const now = Date.now();
    const seen = new Set();
    const items = [];
    ids.forEach((id, i) => {
      const scenario = scenarios[i];
      if (seen.has(id)) return;
      seen.add(id);
      if (!YT_ID.test(id) || scenario === "0404" || ERROR_SCENARIOS.has(scenario)) return;
      const item = broadcastItem(id, describe(id, scenario, now));
      if (item) items.push(item);
    });
    return json(res, 200, {
      kind: "youtube#liveBroadcastListResponse",
      etag: "mock",
      items,
      pageInfo: { totalResults: items.length, resultsPerPage: 50 },
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
    if (form.refresh_token === "mock-refresh-invalid-grant") {
      return json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    }
    if (form.refresh_token === "mock-refresh-unavailable") return text(res, 500, "Internal Server Error");
    mock.tokensIssued += 1;
    const accessToken = `mock-access-${mock.tokensIssued}`;
    tokens.set(accessToken, Date.now() + mock.tokenTtl * 1000);
    const out = { access_token: accessToken, expires_in: mock.tokenTtl, scope: "https://www.googleapis.com/auth/youtube.readonly", token_type: "Bearer" };
    if (mock.rotateRefreshToken) out.refresh_token = `mock-refresh-rotated-${mock.tokensIssued}-not-secret`;
    return json(res, 200, out);
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
      // Every header, so a check can prove the API key never travels in one.
      headers: { authorization: null, "user-agent": null, ...req.headers },
      body: body.length ? body.toString("utf8").slice(0, 2000) : "",
    };
    mock.requests.push(record);
    try {
      if (typeof mock.beforeAnswer === "function") await mock.beforeAnswer(record);
      if (req.method === "GET" && url.pathname === "/__health") return text(res, 200, "ok");
      if (url.pathname === "/oembed") return req.method === "GET" ? handleOembed(req, res, query) : text(res, 405, "Method not allowed", { Allow: "GET" });
      if (url.pathname === "/youtube/v3/videos" || url.pathname === "/youtube/v3/liveBroadcasts") {
        if (req.method !== "GET") return text(res, 405, "Method not allowed", { Allow: "GET" });
        mock.quotaUnits += 1;
        return url.pathname === "/youtube/v3/videos" ? handleVideos(req, res, query) : handleBroadcasts(req, res, query);
      }
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
