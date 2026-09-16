#!/usr/bin/env node
/**
 * tests/support/ccavenue_mock.mjs — a stand-in for CCAvenue, so the whole
 * payment lifecycle can be driven in TEST mode without touching the real
 * gateway (docs/payments/SPEC.md §4.2–§4.5, §12).
 *
 *   startCcavenueMock({ port, workingKey, accessCode })
 *     POST /transaction/transaction.do   the checkout page: decrypts encRequest,
 *                                        records the order, renders one button
 *                                        per outcome (Success, Failure, Abort,
 *                                        Awaited, Tamper amount, Wrong currency)
 *     POST /transaction/response         a button press: records the outcome the
 *                                        status API will then report, and answers
 *                                        307 to the merchant's redirect_url (or
 *                                        cancel_url), so the browser re-posts the
 *                                        same encResp there — exactly as the
 *                                        local simulator does
 *     POST /apis/servlet/DoWebTrans      orderStatusTracker and refundOrder
 *     GET  /__health                     "ok", for the port check
 *
 * The server under test is pointed here with CCAVENUE_TRANSACTION_URL and
 * CCAVENUE_API_URL while its mode is `test`; the TEST credentials it is given
 * are the ones passed in here.
 *
 * A suite drives it either through the page (post the checkout fields, press a
 * button) or directly:
 *
 *   const enc = mock.response(orderId, "success");   // also records the outcome
 *   await post(`${BASE}/api/payments/ccavenue/response`, { encResp: enc.encResp });
 *
 * Scenarios for the server API are set per order and answered until changed:
 *
 *   mock.setApiScenario(orderId, "http500" | "http429" | "refused" | "no_record"
 *                              | "garbage" | "wrong_amount" | "ok");
 *   mock.setApiStatus(orderId, "Successful" | "Awaited" | "Aborted" | …);
 *
 * Nothing here is a secret: the working key and access code a suite passes in
 * are values it invents for the run.
 */

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { ccavEncrypt, ccavDecrypt, ccavBuild, ccavParse, ccavTransDate } from "./ccavenue_crypto.mjs";

/** The gateway status the API reports after each kind of browser outcome. */
const API_STATUS_FOR = {
  success: "Successful",
  failure: "Unsuccessful",
  aborted: "Aborted",
  awaited: "Awaited",
  tamper: "Successful",
  currency: "Successful",
};

const BUTTONS = [
  ["success", "Pay (UPI)"],
  ["card", "Pay (Credit Card)"],
  ["failure", "Decline"],
  ["aborted", "Cancel"],
  ["awaited", "Awaited"],
  ["tamper", "Tamper amount"],
  ["currency", "Wrong currency"],
];

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);

const twoDecimals = (value) => {
  const cents = Math.round(Number(value) * 100);
  return (cents / 100).toFixed(2);
};

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

export async function startCcavenueMock({
  port,
  workingKey,
  accessCode,
  apiWorkingKey = workingKey,
  apiAccessCode = accessCode,
  host = "127.0.0.1",
} = {}) {
  const mock = {
    port,
    host,
    base: `http://${host}:${port}`,
    transactionUrl: `http://${host}:${port}/transaction/transaction.do?command=initiateTransaction`,
    apiUrl: `http://${host}:${port}/apis/servlet/DoWebTrans`,
    workingKey,
    accessCode,
    apiWorkingKey,
    apiAccessCode,
    /** Every request that reached the mock, newest last. */
    requests: [],
    /** orderId → what the mock knows about it. */
    orders: new Map(),
    /** Set true to wrap API answers in Order_Status_Result / Refund_Order_Result. */
    wrapResponses: false,
  };

  /* ── Orders ──────────────────────────────────────────────────────────── */

  const order = (orderId, create = true) => {
    let row = mock.orders.get(orderId);
    if (!row && create) {
      row = {
        orderId,
        amount: null,
        currency: "INR",
        apiAmount: null,
        apiCurrency: null,
        apiStatus: null,
        apiScenario: "ok",
        trackingId: String(crypto.randomInt(1e11, 1e12)),
        bankRefNo: `BANK${crypto.randomInt(100000, 999999)}`,
        paymentMode: "UPI",
        redirectUrl: null,
        cancelUrl: null,
        request: null,
        refunds: [],
      };
      mock.orders.set(orderId, row);
    }
    return row;
  };

  mock.order = (orderId) => mock.orders.get(orderId) ?? null;
  mock.setApiScenario = (orderId, scenario) => {
    order(orderId).apiScenario = scenario;
  };
  mock.setApiStatus = (orderId, status, extra = {}) => {
    const row = order(orderId);
    row.apiStatus = status;
    if (extra.amount !== undefined) row.apiAmount = extra.amount === null ? null : twoDecimals(extra.amount);
    if (extra.currency !== undefined) row.apiCurrency = extra.currency;
    if (extra.trackingId !== undefined) row.trackingId = extra.trackingId;
  };
  /** The amount the API reports (the checkout amount unless a scenario changed it). */
  mock.paidAmount = (orderId) => {
    const row = mock.orders.get(orderId);
    return row ? (row.apiAmount ?? row.amount) : null;
  };

  /* ── Building a response ─────────────────────────────────────────────── */

  /**
   * The encResp for one outcome, and where a browser would post it. Also records
   * what the status API reports for that order from now on, so a callback and a
   * later status check agree — override with setApiStatus()/setApiScenario().
   *
   * kind: success | card | failure | aborted | awaited | tamper | currency
   * overrides: any response field, plus { record: false } to leave the API alone.
   */
  mock.response = (orderId, kind = "success", overrides = {}) => {
    const row = order(orderId);
    const { record = true, ...fieldOverrides } = overrides;
    const amount = row.amount ?? twoDecimals(fieldOverrides.amount ?? 0);
    const currency = row.currency ?? "INR";
    let reported = { amount, currency };
    if (kind === "tamper") {
      const cents = Math.round(Number(amount) * 100);
      reported.amount = twoDecimals((cents > 100 ? cents - 100 : cents + 100) / 100);
    }
    if (kind === "currency") reported.currency = currency === "INR" ? "USD" : "INR";

    const statusFor = {
      success: "Success",
      card: "Success",
      failure: "Failure",
      aborted: "Aborted",
      awaited: "Awaited",
      tamper: "Success",
      currency: "Success",
    };
    const fields = {
      order_id: orderId,
      tracking_id: row.trackingId,
      bank_ref_no: kind === "failure" || kind === "aborted" ? "" : row.bankRefNo,
      order_status: statusFor[kind] ?? "Success",
      failure_message: kind === "failure" ? "Simulated decline by the bank" : "",
      payment_mode: kind === "card" ? "Credit Card" : kind === "aborted" ? "" : "UPI",
      card_name: kind === "card" ? "Visa" : "",
      status_code: kind === "failure" ? "0" : "",
      status_message: kind === "failure" ? "Bank declined the transaction" : "Y",
      currency: reported.currency,
      amount: reported.amount,
      trans_date: ccavTransDate(),
      merchant_param1: row.request?.merchant_param1 ?? "",
      merchant_param2: row.request?.merchant_param2 ?? "",
      merchant_param3: row.request?.merchant_param3 ?? "",
      ...fieldOverrides,
    };
    if (record) {
      row.apiStatus = API_STATUS_FOR[kind === "card" ? "success" : kind] ?? "Successful";
      row.apiAmount = kind === "tamper" ? reported.amount : null;
      row.apiCurrency = kind === "currency" ? reported.currency : null;
      if (fields.payment_mode) row.paymentMode = fields.payment_mode;
    }
    return {
      encResp: ccavEncrypt(ccavBuild(fields), mock.workingKey),
      fields,
      url: kind === "aborted" ? row.cancelUrl : row.redirectUrl,
      kind,
    };
  };

  /** Encrypt any payload with the checkout working key (for hand-forged responses). */
  mock.encrypt = (fields) => ccavEncrypt(typeof fields === "string" ? fields : ccavBuild(fields), mock.workingKey);

  /* ── HTTP ────────────────────────────────────────────────────────────── */

  const text = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
    res.end(body);
  };

  function checkoutPage(row, orderId) {
    const forms = BUTTONS.map(([kind, label]) => {
      const built = mock.response(orderId, kind, { record: false });
      return `<form method="post" action="${escapeHtml(`${mock.base}/transaction/response`)}">
      <input type="hidden" name="encResp" value="${escapeHtml(built.encResp)}">
      <input type="hidden" name="mock_kind" value="${escapeHtml(kind)}">
      <input type="hidden" name="mock_order" value="${escapeHtml(orderId)}">
      <button type="submit" data-mock="${escapeHtml(kind)}">${escapeHtml(label)}</button>
    </form>`;
    }).join("\n    ");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CCAvenue mock — test payments only</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:40rem}button{min-height:44px;margin:.25rem}</style>
</head><body>
  <h1>CCAvenue mock — test payments only</h1>
  <dl>
    <dt>Merchant</dt><dd>${escapeHtml(row.request?.merchant_id ?? "")}</dd>
    <dt>Order</dt><dd>${escapeHtml(orderId)}</dd>
    <dt>Amount</dt><dd>${escapeHtml(row.amount)} ${escapeHtml(row.currency)}</dd>
    <dt>Name</dt><dd>${escapeHtml(row.request?.billing_name ?? "")}</dd>
  </dl>
  ${forms}
</body></html>`;
  }

  async function handleCheckout(req, res, body) {
    const form = Object.fromEntries(new URLSearchParams(body.toString("utf8")));
    mock.requests.push({ kind: "checkout", url: req.url, form });
    if (form.access_code !== mock.accessCode) return text(res, 403, "Access code not valid");
    const plain = ccavDecrypt(form.encRequest ?? "", mock.workingKey);
    if (plain === null) return text(res, 400, "encRequest could not be decrypted");
    const fields = ccavParse(plain);
    const orderId = String(fields.order_id ?? "");
    if (orderId === "") return text(res, 400, "no order_id");
    const row = order(orderId);
    row.amount = twoDecimals(fields.amount ?? 0);
    row.currency = String(fields.currency ?? "INR").toUpperCase();
    row.redirectUrl = fields.redirect_url ?? null;
    row.cancelUrl = fields.cancel_url ?? null;
    row.request = fields;
    mock.requests[mock.requests.length - 1].order_id = orderId;
    mock.requests[mock.requests.length - 1].fields = fields;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(checkoutPage(row, orderId));
  }

  /** A button press: record the outcome, then send the browser on to the merchant. */
  function handleButton(req, res, body) {
    const form = Object.fromEntries(new URLSearchParams(body.toString("utf8")));
    mock.requests.push({ kind: "button", url: req.url, form });
    const orderId = String(form.mock_order ?? "");
    const kind = String(form.mock_kind ?? "success");
    const row = mock.orders.get(orderId);
    if (!row) return text(res, 404, "unknown order");
    row.apiStatus = API_STATUS_FOR[kind === "card" ? "success" : kind] ?? "Successful";
    if (kind === "tamper" || kind === "currency") {
      const built = mock.response(orderId, kind, { record: true });
      row.apiAmount = kind === "tamper" ? built.fields.amount : null;
      row.apiCurrency = kind === "currency" ? built.fields.currency : null;
    } else {
      row.apiAmount = null;
      row.apiCurrency = null;
    }
    const target = kind === "aborted" ? row.cancelUrl : row.redirectUrl;
    res.writeHead(307, { Location: target, "Content-Type": "text/plain; charset=utf-8" });
    res.end("Temporary Redirect");
  }

  /** status=0 with the JSON payload encrypted, as CCAvenue answers DoWebTrans. */
  const apiOk = (res, payload, wrapper) => {
    const body = mock.wrapResponses && wrapper ? { [wrapper]: payload } : payload;
    const enc = ccavEncrypt(JSON.stringify(body), mock.apiWorkingKey);
    text(res, 200, `status=0&enc_response=${enc}`);
  };
  const apiRefused = (res, message, code) => text(res, 200, `status=1&enc_response=${encodeURIComponent(message)}&enc_error_code=${code}`);

  function handleApi(req, res, body) {
    const form = Object.fromEntries(new URLSearchParams(body.toString("utf8")));
    const record = { kind: "api", url: req.url, form, command: form.command, payload: null };
    mock.requests.push(record);
    if (form.access_code !== mock.apiAccessCode) return apiRefused(res, "Access denied", "51407");
    const plain = ccavDecrypt(form.enc_request ?? "", mock.apiWorkingKey);
    if (plain === null) return apiRefused(res, "Request could not be read", "-1");
    let payload = null;
    try {
      payload = JSON.parse(plain);
    } catch {
      return apiRefused(res, "Request is not JSON", "-1");
    }
    record.payload = payload;

    const orderId = String(payload.order_no ?? "");
    let row = orderId !== "" ? mock.orders.get(orderId) : null;
    if (!row && payload.reference_no) {
      for (const candidate of mock.orders.values()) {
        if (candidate.trackingId === String(payload.reference_no)) row = candidate;
      }
    }
    const scenario = row?.apiScenario ?? "ok";
    if (scenario === "http500") return text(res, 500, "Internal Server Error");
    if (scenario === "http429") return text(res, 429, "Too Many Requests", { "Retry-After": "30" });
    if (scenario === "refused") return apiRefused(res, "The access code is not allowed from this IP", "51407");
    if (scenario === "garbage") return text(res, 200, "status=0&enc_response=nothexatall");

    if (form.command === "orderStatusTracker") {
      if (!row || scenario === "no_record" || row.apiStatus === null) {
        return apiOk(res, { status: "1", error_code: "51419", error_desc: "No record found for this order" }, "Order_Status_Result");
      }
      const amount = scenario === "wrong_amount" ? twoDecimals(Number(row.apiAmount ?? row.amount) + 1) : (row.apiAmount ?? row.amount);
      return apiOk(res, {
        order_no: row.orderId,
        reference_no: row.trackingId,
        order_status: row.apiStatus,
        order_amt: Number(amount),
        order_currncy: row.apiCurrency ?? row.currency,
        order_bank_ref_no: row.bankRefNo,
        order_date_time: ccavTransDate(),
      }, "Order_Status_Result");
    }

    if (form.command === "refundOrder") {
      if (!row) return apiOk(res, { status: "1", error_code: "51419", error_desc: "No record found for this order" }, "Refund_Order_Result");
      const amount = twoDecimals(payload.refund_amount ?? 0);
      const already = row.refunds
        .filter((r) => r.reference !== payload.refund_ref_no)
        .reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0);
      const paid = Math.round(Number(row.apiAmount ?? row.amount ?? 0) * 100);
      if (amount.endsWith(".13")) {
        return apiOk(res, { refund_status: "1", reason: "Simulated refusal" }, "Refund_Order_Result");
      }
      if (Math.round(Number(amount) * 100) + already > paid) {
        return apiOk(res, { status: "1", error_code: "52020", error_desc: "Refund amount is more than the order amount" }, "Refund_Order_Result");
      }
      row.refunds.push({ reference: payload.refund_ref_no, amount });
      return apiOk(res, { refund_status: "0", reason: "", refund_ref_no: payload.refund_ref_no }, "Refund_Order_Result");
    }

    return apiOk(res, { status: "1", error_code: "51000", error_desc: `Unknown command ${form.command}` });
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const path = (req.url ?? "").split("?")[0];
    try {
      if (req.method === "GET" && path === "/__health") return text(res, 200, "ok");
      if (req.method !== "POST") return text(res, 405, "Method not allowed");
      if (path === "/transaction/transaction.do") return await handleCheckout(req, res, body);
      if (path === "/transaction/response") return handleButton(req, res, body);
      if (path === "/apis/servlet/DoWebTrans") return handleApi(req, res, body);
      return text(res, 404, "not found");
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
