/* backend/admin/assets/notify-content.js — behaviour for Message Templates.
   Progressive enhancement only: without JavaScript the editor saves normally,
   the preview shows the saved wording, and the variables are a readable list.

   1. Variable chips: each {{name}} in the list becomes a button that inserts it
      at the cursor of the field last used (title, message or button label).
   2. Live preview: edits are posted (debounced, CSRF token included) to the same
      page with action=preview; the server renders exactly as it will send, and
      this script only places the returned text. Every value goes in through
      textContent — the email preview is the one HTML string, and it lands in a
      sandboxed iframe's srcdoc, where it cannot run script or reach this page.
   3. An unsaved-changes guard, so a long edit is not lost to a stray click.
*/
(function () {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const form = $("[data-ntpl-editor]");
  if (!form) return;

  const icons = (() => {
    try { return JSON.parse($("#icon-sprite")?.textContent || "{}"); } catch (e) { return {}; }
  })();

  /* 1. Variable chips --------------------------------------------------- */
  const targets = $$("[data-var-target]", form).filter((el) => !el.readOnly);
  let lastField = $("#t-body", form) || targets[0] || null;
  targets.forEach((el) => el.addEventListener("focus", () => { lastField = el; }));

  $$("[data-ntpl-vars]", form).forEach((list) => {
    list.closest(".ntpl-vars")?.classList.add("ntpl-vars--enhanced");
    $$("code[data-var]", list).forEach((code) => {
      const name = code.dataset.var;
      const sample = code.parentElement.querySelector(".ntpl-vars__sample")?.textContent.trim() || "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ntpl-var-btn";
      btn.setAttribute("aria-label", `Insert {{${name}}}` + (sample ? `, for example ${sample}` : ""));
      if (sample) btn.title = sample;
      code.replaceWith(btn);
      btn.appendChild(code);
      btn.addEventListener("click", () => insertVariable(name));
    });
  });

  function insertVariable(name) {
    const field = lastField;
    if (!field) return;
    const token = `{{${name}}}`;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    field.focus({ preventScroll: true });
    field.setRangeText(token, start, end, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* 2. Live preview ----------------------------------------------------- */
  const panel = $("[data-ntpl-preview]");
  const status = $("[data-pv-status]");
  const warnings = $("[data-ntpl-warnings]", form);
  const pv = (name) => (panel ? $(`[data-pv="${name}"]`, panel) : null);
  let timer = 0;
  let inflight = null;

  const setText = (el, text) => { if (el) el.textContent = text ?? ""; };
  const setStatus = (text) => setText(status, text);

  // WhatsApp *bold* as <strong>, built from text nodes so nothing is parsed as HTML.
  function renderWhatsApp(el, text) {
    if (!el) return;
    el.replaceChildren();
    const re = /\*([^*\n]+)\*/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.append(text.slice(last, m.index));
      const strong = document.createElement("strong");
      strong.textContent = m[1];
      el.append(strong);
      last = m.index + m[0].length;
    }
    if (last < text.length) el.append(text.slice(last));
  }

  function renderWarnings(list) {
    if (!warnings) return;
    warnings.replaceChildren();
    if (!list || !list.length) return;
    const box = document.createElement("div");
    box.className = "callout ntpl-callout--warn";
    box.innerHTML = icons.alert || ""; // the icon sprite is the page's own static SVG
    const body = document.createElement("div");
    const head = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = "Please check the variables";
    head.append(strong);
    const ul = document.createElement("ul");
    ul.className = "ntpl-warn-list";
    list.forEach((w) => { const li = document.createElement("li"); li.textContent = w; ul.append(li); });
    body.append(head, ul);
    box.append(body);
    warnings.append(box);
  }

  function apply(data) {
    if (data.email_html != null && pv("email")) pv("email").srcdoc = data.email_html;
    if (data.sms) {
      setText(pv("sms-text"), data.sms.text);
      const s = data.sms;
      setText(pv("sms-info"), `${s.chars} characters · ${s.segments} segment${s.segments === 1 ? "" : "s"} · ${s.encoding}`);
    }
    if (data.whatsapp) {
      const wa = data.whatsapp;
      renderWhatsApp(pv("wa-text"), wa.text || "");
      if (pv("wa-cta")) pv("wa-cta").hidden = !wa.cta_label;
      setText(pv("wa-cta-label"), wa.cta_label);
      if (pv("wa-template")) pv("wa-template").hidden = !wa.provider_template;
      setText(pv("wa-template-name"), wa.provider_template || "");
      const ol = pv("wa-params");
      if (ol) {
        ol.replaceChildren();
        (wa.params || []).forEach((p) => {
          const li = document.createElement("li");
          const code = document.createElement("code");
          code.textContent = p.name;
          li.append(code, " ", p.value);
          ol.append(li);
        });
      }
    }
    if (data.push) {
      setText(pv("push-title"), data.push.title);
      setText(pv("push-body"), data.push.body);
    }
    if (data.inapp) {
      setText(pv("inapp-title"), data.inapp.title);
      setText(pv("inapp-body"), data.inapp.body);
      if (pv("inapp-cta")) pv("inapp-cta").hidden = !data.inapp.cta_label;
      setText(pv("inapp-cta"), data.inapp.cta_label);
    }
    renderWarnings(data.warnings);
  }

  async function refresh() {
    if (inflight) inflight.abort();
    const controller = new AbortController();
    inflight = controller;
    const body = new FormData(form);
    body.set("action", "preview");
    setStatus("Updating preview…");
    try {
      const res = await fetch(form.getAttribute("action") || location.pathname, {
        method: "POST",
        body,
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        setStatus((data && data.error) || "The preview could not be updated. Your text is safe; saving still works.");
        return;
      }
      apply(data);
      setStatus("With sample values · updated");
    } catch (err) {
      if (err.name === "AbortError") return;
      setStatus("The preview could not be updated (offline?). Your text is safe; saving still works.");
    } finally {
      if (inflight === controller) inflight = null;
    }
  }

  /* 3. Unsaved-changes guard -------------------------------------------- */
  let dirty = false;
  let submitting = false;
  form.addEventListener("input", () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(refresh, 450);
  });
  form.addEventListener("submit", () => { submitting = true; });
  window.addEventListener("beforeunload", (e) => {
    if (!dirty || submitting) return;
    e.preventDefault();
    e.returnValue = "";
  });
})();
