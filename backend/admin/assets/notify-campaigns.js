/* backend/admin/assets/notify-campaigns.js — the notification composer, saved
   audiences and the campaign page (notifications.php,
   notification_segments.php). Loaded after the page; admin.js supplies the
   toasts, confirm dialogs, menus and character counters.

   Everything here is an enhancement. The pages work without it: every shape
   change (a rule, a language, a devotee) is also a submit button the server
   answers by re-rendering the form. This script hides those buttons and does
   the same thing in place:
     1. Tabs         languages and previews, with arrow-key navigation
     2. Languages    add or remove a translation
     3. Audience     source panels, the rules builder, the devotee picker
     4. Estimate     how many devotees match, debounced (POST action=estimate)
     5. Preview      the message per channel and language (POST action=preview)
     6. Counters     SMS length and parts while typing
     7. Schedule     show only what the chosen mode needs
     8. Errors       reveal and focus the field an error summary points at

   The rule value controls mirror adminAudienceValueWidget() in
   includes/notify_audience_form.php; change both together. */
(function () {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const toast = (message, type = "info") => (window.adminToast ? window.adminToast(message, type) : null);
  const debounce = (fn, ms) => {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  let sprite = null;
  const iconSvg = (name) => {
    if (sprite === null) {
      try { sprite = JSON.parse($("#icon-sprite")?.textContent || "{}"); } catch (e) { sprite = {}; }
    }
    return sprite[name] || "";
  };

  /** createElement with attributes; null/false attributes are left out, text is never parsed as HTML. */
  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === false || value === undefined) continue;
      if (key === "className") node.className = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** Text with its line breaks kept, without innerHTML. */
  function appendLines(parent, text) {
    String(text || "").split("\n").forEach((line, i) => {
      if (i) parent.appendChild(document.createElement("br"));
      parent.appendChild(document.createTextNode(line));
    });
  }

  /* 1. Tabs ----------------------------------------------------------------
     WAI-ARIA tabs with automatic activation: arrows, Home and End move and
     select; only the selected tab is in the tab order. Each item names its
     own panel, or all items share one panel (the composer's preview). */
  function createTabs(list, { idPrefix, onSelect }) {
    let items = [];
    let active = null;

    function select(key, focus) {
      if (!items.length) {
        active = null;
        return;
      }
      if (!items.some((it) => it.key === key)) key = items[0].key;
      active = key;
      items.forEach((it) => {
        const tab = document.getElementById(`${idPrefix}-tab-${it.key}`);
        const on = it.key === key;
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
        if (it.panel) it.panel.hidden = !on;
        if (on && focus) tab.focus();
      });
      const current = items.find((it) => it.key === key);
      const panel = current.panel || document.getElementById(current.panelId);
      panel?.setAttribute("aria-labelledby", `${idPrefix}-tab-${key}`);
      onSelect?.(key);
    }

    function render(next, activeKey) {
      items = next;
      list.textContent = "";
      items.forEach((it) => {
        const tab = el("button", {
          type: "button", className: "tab", role: "tab", id: `${idPrefix}-tab-${it.key}`,
          "aria-controls": it.panelId, lang: it.lang || null,
        }, it.label);
        tab.addEventListener("click", () => select(it.key, false));
        list.appendChild(tab);
      });
      list.hidden = items.length === 0;
      select(activeKey, false);
    }

    list.addEventListener("keydown", (e) => {
      const keys = items.map((it) => it.key);
      const i = keys.indexOf(active);
      let next = null;
      if (e.key === "ArrowRight") next = keys[(i + 1) % keys.length];
      else if (e.key === "ArrowLeft") next = keys[(i - 1 + keys.length) % keys.length];
      else if (e.key === "Home") next = keys[0];
      else if (e.key === "End") next = keys[keys.length - 1];
      if (next !== null && next !== undefined) {
        e.preventDefault();
        select(next, true);
      }
    });

    return { render, select, get active() { return active; } };
  }

  // Server-rendered tab groups (the campaign page's previews).
  $$("[data-nc-tabs]").forEach((wrap, n) => {
    const list = $("[data-nc-tablist]", wrap);
    const panels = $$("[data-nc-tabpanel]", wrap).filter((p) => p.parentElement === wrap);
    if (!list || panels.length < 2) return;
    wrap.classList.add("is-enhanced");
    panels.forEach((p) => {
      p.setAttribute("role", "tabpanel");
      p.tabIndex = 0;
    });
    const tabs = createTabs(list, { idPrefix: `nc-tabs${n}` });
    tabs.render(panels.map((p) => ({ key: p.id, label: p.dataset.label, panelId: p.id, panel: p })), panels[0].id);
  });

  const form = $("[data-nc-composer]") || $("[data-nc-segment-form]");
  if (!form) return;
  const isComposer = form.hasAttribute("data-nc-composer");
  const endpoint = form.getAttribute("action") || window.location.pathname;
  form.classList.add("is-enhanced");
  $$("[data-nc-nojs]", form).forEach((node) => { node.hidden = true; });

  /** POST the whole form plus overrides; resolves to JSON, rejects with a sentence to show. */
  async function post(fields) {
    const body = new FormData(form);
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    let res;
    try {
      res = await fetch(endpoint, { method: "POST", body, credentials: "same-origin", headers: { Accept: "application/json" } });
    } catch (e) {
      throw Object.assign(new Error("The connection dropped. Check the network and try again."), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!data) {
      throw Object.assign(new Error("The page did not answer as expected. Your session may have ended; reload the page."), { status: res.status });
    }
    if (!res.ok) throw Object.assign(new Error(data.error || "That could not be done."), { status: res.status, data });
    return data;
  }

  // Leaving with unsaved typing asks first; saving clears the flag.
  let dirty = false;
  form.addEventListener("input", () => { dirty = true; });
  form.addEventListener("change", () => { dirty = true; });
  form.addEventListener("submit", () => { dirty = false; });
  window.addEventListener("beforeunload", (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  const channelBoxes = $$("[data-nc-channel]", form);

  /* 2. Languages ---------------------------------------------------------- */
  const langWrap = $("[data-nc-langs]", form);
  let langTabs = null;
  const langPanels = () => (langWrap ? $$("[data-nc-lang-panel]", langWrap) : []);
  const renderLangTabs = (activeKey) => langTabs?.render(langPanels().map((p) => ({
    key: p.dataset.ncLangPanel, label: p.dataset.label, lang: p.dataset.ncLangPanel, panelId: p.id, panel: p,
  })), activeKey);

  function attachCounter(field) {
    const max = Number(field.getAttribute("maxlength")) || 0;
    const out = el("span", { className: "field__hint tabular", "aria-live": "polite" });
    field.insertAdjacentElement("afterend", out);
    const update = () => { out.textContent = max ? `${field.value.length} / ${max}` : `${field.value.length} characters`; };
    field.addEventListener("input", update);
    update();
  }

  if (langWrap) {
    langWrap.classList.add("is-enhanced");
    langPanels().forEach((p) => p.setAttribute("role", "tabpanel"));
    langTabs = createTabs($("[data-nc-lang-tablist]", langWrap), { idPrefix: "nc-lang" });
    const invalid = langPanels().find((p) => p.querySelector('[aria-invalid="true"]'));
    renderLangTabs(invalid ? invalid.dataset.ncLangPanel : "ta");

    const addRow = $("[data-nc-add-lang-row]", langWrap);
    const addSelect = $("[data-nc-add-lang-select]", langWrap);
    const template = $("template[data-nc-lang-template]", langWrap);

    $("[data-nc-add-lang]", langWrap)?.addEventListener("click", (e) => {
      e.preventDefault();
      const option = addSelect?.selectedOptions[0];
      if (!option || !template) return;
      const code = option.value;
      if (!/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(code) || langWrap.querySelector(`[data-nc-lang-panel="${code}"]`)) return;
      const label = option.textContent.replace(/\s*\([^)]*\)\s*$/, "");
      const holder = document.createElement("div");
      // The code is checked against the pattern above, so it is safe inside the markup.
      holder.innerHTML = template.innerHTML.split("__LANG__").join(code);
      const panel = holder.firstElementChild;
      panel.dataset.label = label;
      panel.setAttribute("role", "tabpanel");
      $("[data-nc-lang-name]", panel).textContent = label;
      $("[data-nc-remove-label]", panel).textContent = `Remove ${label}`;
      addRow.before(panel);
      $$("[data-nc-counter]", panel).forEach(attachCounter);
      option.remove();
      addRow.hidden = addSelect.options.length === 0;
      renderLangTabs(code);
      document.getElementById(`nc-lang-${code}-title`)?.focus();
      dirty = true;
      refreshPreviewLangs();
    });

    langWrap.addEventListener("click", (e) => {
      const button = e.target.closest("[data-nc-remove-lang]");
      if (!button) return;
      e.preventDefault();
      const panel = button.closest("[data-nc-lang-panel]");
      const code = panel.dataset.ncLangPanel;
      const label = panel.dataset.label;
      panel.remove();
      if (addSelect) {
        addSelect.appendChild(new Option(`${label} (${code})`, code));
        addRow.hidden = false;
      }
      renderLangTabs("ta");
      document.getElementById("nc-lang-tab-ta")?.focus();
      dirty = true;
      toast(`${label} removed. Save to keep the change.`, "info");
      refreshPreviewLangs();
      schedulePreview();
    });
  }

  /* 3. Audience ------------------------------------------------------------ */
  const audience = $("[data-nc-audience]", form);
  let meta = { fields: {}, groups: {}, opLabels: {} };
  try { meta = JSON.parse($("#nc-audience-fields")?.textContent || "{}"); } catch (e) { /* the builder falls back to text inputs */ }

  const sourceRadios = $$("[data-nc-source]", form);
  function syncSource() {
    const current = sourceRadios.find((r) => r.checked)?.value || "rules";
    $$("[data-nc-source-panel]", form).forEach((p) => { p.hidden = p.dataset.ncSourcePanel !== current; });
  }
  if (audience) {
    audience.classList.add("is-enhanced");
    sourceRadios.forEach((r) => r.addEventListener("change", () => { syncSource(); scheduleEstimate(); }));
    syncSource();
    // Enter in a rule or the picker must not submit the whole form.
    audience.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches("input:not([type=checkbox]):not([type=radio])")) e.preventDefault();
    });
  }

  const rulesList = $("[data-nc-rules]", form);
  const ruleTemplate = $("template[data-nc-rule-template]", form);
  let nextRule = rulesList ? $$("[data-nc-rule]", rulesList).reduce((max, r) => Math.max(max, Number(r.dataset.ncRuleIndex) || 0), -1) + 1 : 0;

  function renumberRules() {
    if (!rulesList) return;
    $$("[data-nc-rule]", rulesList).forEach((row, i) => {
      const n = String(i + 1);
      $(".nc-rule__num", row).textContent = n;
      $$(".nc-rule__label .sr-only", row).forEach((s) => { s.textContent = ` for rule ${n}`; });
      $("[data-nc-remove-rule]", row)?.setAttribute("aria-label", `Remove rule ${n}`);
    });
    const empty = $("[data-nc-rules-empty]", form);
    if (empty) empty.hidden = rulesList.children.length > 0;
  }

  function buildOps(row, def) {
    const select = $("[data-nc-rule-op]", row);
    const previous = select.value;
    const ops = def ? def.ops : Object.keys(meta.opLabels || {});
    select.textContent = "";
    ops.forEach((op) => select.add(new Option((meta.opLabels || {})[op] || op, op)));
    select.value = ops.includes(previous) ? previous : ops[0];
  }

  /** The value control for a rule row. Mirrors adminAudienceValueWidget(). */
  function buildValue(row) {
    const idx = row.dataset.ncRuleIndex;
    const num = $(".nc-rule__num", row).textContent;
    const field = $("[data-nc-rule-field]", row).value;
    const op = $("[data-nc-rule-op]", row).value;
    const def = (meta.fields || {})[field] || null;
    const holder = $("[data-nc-rule-value]", row);
    holder.textContent = "";
    const id = `nc-rule-${idx}-value`;
    const name = `rules[${idx}][value]`;
    const labelled = (control) => {
      const label = el("label", { className: "nc-rule__part", for: id });
      const caption = el("span", { className: "nc-rule__label" }, "Value");
      caption.appendChild(el("span", { className: "sr-only" }, ` for rule ${num}`));
      label.append(caption, control);
      holder.appendChild(label);
    };

    if (!def) {
      labelled(el("input", { id, type: "text", name, maxlength: "2000", placeholder: "Choose what to check first" }));
      return;
    }
    const options = Array.isArray(def.options) ? def.options : [];
    switch (def.type) {
      case "bool": {
        const select = el("select", { id, name });
        select.add(new Option("Yes", "yes"));
        select.add(new Option("No", "no"));
        labelled(select);
        return;
      }
      case "int":
        labelled(el("input", { id, type: "number", inputmode: "numeric", min: "0", max: "36500", step: "1", name, placeholder: "30" }));
        return;
      case "number":
        labelled(el("input", { id, type: "number", inputmode: "decimal", min: "0", step: "0.01", name, placeholder: "1000" }));
        return;
      case "string":
        labelled(el("input", { id, type: "text", maxlength: "120", name, placeholder: "Madurai" }));
        return;
      case "iso2list":
        labelled(el("input", { id, type: "text", maxlength: "1500", autocapitalize: "characters", spellcheck: "false", name, placeholder: "IN, SG" }));
        return;
      case "strlist":
        labelled(el("input", {
          id, type: "text", maxlength: "2000", spellcheck: "false", name,
          placeholder: field === "tag" ? "volunteer, member" : "TN, KL", list: options.length ? `nc-dl-${field}` : null,
        }));
        return;
      default:
        break;
    }
    if (!options.length) {
      labelled(el("input", { id, type: "text", maxlength: "2000", name, placeholder: "Separate values with commas" }));
      return;
    }
    if (op === "is" || (def.ops.length === 1 && def.ops[0] === "is")) {
      const select = el("select", { id, name });
      select.add(new Option("Choose…", ""));
      options.forEach((o) => select.add(new Option(o.label, String(o.value))));
      labelled(select);
      return;
    }
    const group = el("fieldset", { className: "nc-rule__part nc-checks" });
    const legend = el("legend", { className: "nc-rule__label" }, "Values");
    legend.appendChild(el("span", { className: "sr-only" }, ` for rule ${num}`));
    const list = el("div", { className: "nc-checks__list" });
    options.forEach((o, i) => {
      const cid = `${id}-${i}`;
      const label = el("label", { className: "checkbox-label nc-checks__item", for: cid });
      label.append(el("input", { id: cid, type: "checkbox", name: `${name}[]`, value: String(o.value) }), el("span", {}, o.label));
      list.appendChild(label);
    });
    group.append(legend, list);
    holder.appendChild(group);
  }

  if (rulesList) {
    rulesList.addEventListener("change", (e) => {
      const row = e.target.closest("[data-nc-rule]");
      if (!row) return;
      if (e.target.matches("[data-nc-rule-field]")) {
        buildOps(row, (meta.fields || {})[e.target.value]);
        buildValue(row);
      }
      scheduleEstimate();
    });
    rulesList.addEventListener("click", (e) => {
      const button = e.target.closest("[data-nc-remove-rule]");
      if (!button) return;
      e.preventDefault();
      const row = button.closest("[data-nc-rule]");
      const neighbour = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      renumberRules();
      (neighbour ? $("[data-nc-rule-field]", neighbour) : $("[data-nc-add-rule]", form))?.focus();
      dirty = true;
      scheduleEstimate();
    });
    $("[data-nc-add-rule]", form)?.addEventListener("click", (e) => {
      e.preventDefault();
      if (!ruleTemplate) return;
      const holder = document.createElement("ol");
      holder.innerHTML = ruleTemplate.innerHTML.split("__I__").join(String(nextRule++)).split("__N__").join(String(rulesList.children.length + 1));
      const row = holder.firstElementChild;
      rulesList.appendChild(row);
      renumberRules();
      $("[data-nc-rule-field]", row).focus();
    });
  }

  // Devotee picker: an ARIA combobox over GET ?devotee_search=.
  const picker = $("[data-nc-picker]", form);
  if (picker) {
    const input = $("[data-nc-picker-input]", picker);
    const results = $("[data-nc-picker-results]", picker);
    const status = $("[data-nc-picker-status]", picker);
    const selected = $("[data-nc-selected]", form);
    const countEl = $("[data-nc-selected-count]", form);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", results.id);
    input.setAttribute("aria-expanded", "false");

    let items = [];
    let activeIdx = -1;
    let seq = 0;
    const chosen = () => new Set($$('input[name="devotee_ids[]"]', selected).map((i) => i.value));
    const updateCount = () => { countEl.textContent = `${$$('input[name="devotee_ids[]"]', selected).length} chosen`; };
    const close = () => {
      results.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      activeIdx = -1;
    };
    const setActive = (i) => {
      activeIdx = i;
      $$("[role=option]", results).forEach((li, n) => li.setAttribute("aria-selected", String(n === i)));
      const li = results.children[i];
      if (li) {
        input.setAttribute("aria-activedescendant", li.id);
        li.scrollIntoView({ block: "nearest" });
      }
    };
    const describe = (d) => [d.email, d.city].filter(Boolean).join(" · ");

    function choose(i) {
      const d = items[i];
      if (!d || chosen().has(String(d.id))) return;
      const li = el("li", { className: "nc-selected__item", "data-nc-selected-id": String(d.id) });
      li.appendChild(el("input", { type: "hidden", name: "devotee_ids[]", value: String(d.id) }));
      const text = el("span", { className: "nc-selected__text" });
      text.append(el("strong", {}, d.name), el("small", {}, describe(d)));
      const remove = el("button", { type: "button", className: "btn btn-ghost btn--icon btn--sm", "aria-label": `Remove ${d.name}`, "data-nc-remove-devotee": true });
      remove.innerHTML = iconSvg("x");
      li.append(text, remove);
      selected.appendChild(li);
      updateCount();
      close();
      input.value = "";
      status.textContent = `${d.name} added.`;
      input.focus();
      dirty = true;
      scheduleEstimate();
    }

    function render() {
      results.textContent = "";
      const have = chosen();
      items.forEach((d, i) => {
        const already = have.has(String(d.id));
        const li = el("li", {
          id: `nc-devotee-opt-${d.id}`, role: "option", className: "nc-picker__option",
          "aria-selected": "false", "aria-disabled": already ? "true" : null,
        });
        li.append(el("strong", {}, d.name), el("small", {}, describe(d) + (already ? " · already chosen" : "")));
        li.addEventListener("mousedown", (e) => e.preventDefault());
        li.addEventListener("click", () => choose(i));
        results.appendChild(li);
      });
      results.hidden = items.length === 0;
      input.setAttribute("aria-expanded", String(items.length > 0));
      activeIdx = -1;
    }

    const search = debounce(async () => {
      const q = input.value.trim();
      const mine = ++seq;
      if (q.length < 2) {
        items = [];
        render();
        status.textContent = "";
        return;
      }
      status.textContent = "Searching…";
      try {
        const res = await fetch(`${endpoint}?devotee_search=${encodeURIComponent(q)}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
        const data = await res.json().catch(() => null);
        if (mine !== seq) return;
        if (!res.ok || !data) throw new Error((data && data.error) || "The search did not work. Reload the page and try again.");
        items = Array.isArray(data.items) ? data.items : [];
        render();
        status.textContent = items.length
          ? `${items.length} match${items.length === 1 ? "" : "es"}. Use the arrow keys, then Enter to choose.`
          : `No active devotee matches “${q}”.`;
      } catch (err) {
        if (mine !== seq) return;
        items = [];
        render();
        status.textContent = err.message;
      }
    }, 250);

    input.addEventListener("input", search);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && items.length) {
        e.preventDefault();
        if (results.hidden) render();
        setActive(Math.min(activeIdx + 1, items.length - 1));
      } else if (e.key === "ArrowUp" && items.length) {
        e.preventDefault();
        setActive(Math.max(activeIdx - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0) choose(activeIdx);
      } else if (e.key === "Escape" && !results.hidden) {
        e.preventDefault();
        close();
      }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));

    selected.addEventListener("click", (e) => {
      const button = e.target.closest("[data-nc-remove-devotee]");
      if (!button) return;
      e.preventDefault();
      const li = button.closest("li");
      const name = $("strong", li)?.textContent || "Devotee";
      const neighbour = li.nextElementSibling || li.previousElementSibling;
      li.remove();
      updateCount();
      status.textContent = `${name} removed.`;
      ((neighbour && $("button", neighbour)) || input).focus();
      dirty = true;
      scheduleEstimate();
    });
  }

  /* 4. Estimate ------------------------------------------------------------ */
  const estimate = $("[data-nc-estimate]", form);
  let estimateSeq = 0;
  async function runEstimate() {
    if (!estimate) return;
    const mine = ++estimateSeq;
    const countEl = $("[data-nc-estimate-count]", estimate);
    const textEl = $("[data-nc-estimate-text]", estimate);
    const hint = $("[data-nc-approval-hint]", estimate);
    estimate.classList.add("is-loading");
    try {
      const data = await post({ action: "estimate" });
      if (mine !== estimateSeq) return;
      countEl.textContent = Number(data.count).toLocaleString("en-IN");
      textEl.textContent = data.count === 1 ? "devotee matches right now" : "devotees match right now";
      if (hint) {
        hint.textContent = !isComposer ? ""
          : data.approvalReason ? `Needs an owner's approval when submitted: ${data.approvalReason}.`
          : "Small enough to be approved automatically when it is submitted.";
      }
    } catch (err) {
      if (mine !== estimateSeq) return;
      countEl.textContent = "—";
      textEl.textContent = err.message;
      if (hint) hint.textContent = "";
      if (err.status === 401 || err.status === 419) toast(err.message, "error");
    } finally {
      if (mine === estimateSeq) estimate.classList.remove("is-loading");
    }
  }
  const scheduleEstimate = debounce(runEstimate, 500);
  if (audience) {
    const onAudience = (e) => { if (!e.target.matches("[data-nc-picker-input]")) scheduleEstimate(); };
    audience.addEventListener("input", onAudience);
    audience.addEventListener("change", onAudience);
    runEstimate();
  }
  // Priority, category and paid channels decide whether approval is needed.
  $$("#nc-priority, #nc-category", form).forEach((s) => s.addEventListener("change", scheduleEstimate));

  /* 5. Preview ------------------------------------------------------------- */
  const preview = isComposer ? $("[data-nc-preview]", form) : null;
  let previewTabs = null;
  let previewSeq = 0;
  const previewPanel = preview ? $("[data-nc-preview-panel]", preview) : null;
  const previewLang = preview ? $("[data-nc-preview-lang]", preview) : null;

  function renderPreview(channel, lang, p) {
    const cell = el("div", { className: "nc-pv-cell" });
    if (channel === "inapp") {
      const card = el("article", { className: "nc-pv-inapp", lang });
      const iconBox = el("span", { className: "nc-pv-inapp__icon" });
      iconBox.innerHTML = iconSvg("bell");
      const text = el("div", { className: "nc-pv-inapp__text" });
      text.appendChild(el("strong", { className: "nc-pv-inapp__title" }, p.title));
      const body = el("p", { className: "nc-pv-inapp__body" });
      appendLines(body, p.body);
      text.appendChild(body);
      if (p.cta_url) text.appendChild(el("span", { className: "nc-pv-inapp__cta" }, `${p.cta_label || "Open"} →`));
      card.append(iconBox, text);
      cell.appendChild(card);
    } else if (channel === "email") {
      const wrap = el("div", { className: "nc-pv-email" });
      const subject = el("p", { className: "nc-pv-email__subject" });
      subject.append(el("span", { className: "nc-muted" }, "Subject"), el("span", { lang }, p.title));
      // sandbox="" : the email is shown, never run, and cannot reach this page.
      const frame = el("iframe", { className: "nc-pv-email__frame", sandbox: "", referrerpolicy: "no-referrer", title: "Email preview" });
      frame.srcdoc = p.html || "";
      wrap.append(subject, frame);
      cell.appendChild(wrap);
    } else if (channel === "whatsapp") {
      const wrap = el("div", { className: "nc-pv-wa" });
      const bubble = el("div", { className: "nc-pv-wa__bubble", lang });
      if (p.title) {
        bubble.appendChild(el("strong", {}, p.title));
        bubble.appendChild(document.createElement("br"));
      }
      appendLines(bubble, p.body);
      if (p.cta_url) bubble.appendChild(el("span", { className: "nc-pv-wa__link" }, p.cta_url));
      const params = Array.isArray(p.params) ? p.params : [];
      const meta = p.provider_template
        ? `Approved template ${p.provider_template}${params.length ? " with " + params.map((v, i) => `${i + 1}: ${v}`).join(" · ") : ""}`
        : "No approved template name is set, so it is sent as free text.";
      wrap.append(bubble, el("p", { className: "nc-pv-meta" }, meta));
      cell.appendChild(wrap);
    } else if (channel === "sms") {
      const wrap = el("div", { className: "nc-pv-sms" });
      const text = el("p", { className: "nc-pv-sms__text", lang });
      appendLines(text, p.body);
      const sms = p.sms || { chars: 0, segments: 0, encoding: "GSM-7" };
      const meta = `${Number(sms.chars).toLocaleString("en-IN")} characters · ${sms.segments} SMS part${sms.segments === 1 ? "" : "s"} · ${sms.encoding}`
        + (p.provider_template ? ` · DLT template ${p.provider_template}` : "");
      wrap.append(text, el("p", { className: "nc-pv-meta" }, meta));
      cell.appendChild(wrap);
    } else {
      const card = el("div", { className: "nc-pv-push", lang });
      const iconBox = el("span", { className: "nc-pv-push__icon" });
      iconBox.innerHTML = iconSvg("bell");
      const text = el("div");
      text.append(el("strong", { className: "nc-pv-push__title" }, p.title), el("p", { className: "nc-pv-push__body" }, p.body));
      card.append(iconBox, text);
      cell.appendChild(card);
    }
    if (Array.isArray(p.missing) && p.missing.length) {
      cell.appendChild(el("p", { className: "nc-pv-missing" }, `No value for: ${p.missing.join(", ")}`));
    }
    return cell;
  }

  async function runPreview() {
    if (!previewTabs || !previewTabs.active) return;
    const channel = previewTabs.active;
    const lang = previewLang.value || "ta";
    const mine = ++previewSeq;
    previewPanel.setAttribute("aria-busy", "true");
    try {
      const data = await post({ action: "preview", preview_channel: channel, preview_lang: lang });
      if (mine !== previewSeq) return;
      previewPanel.textContent = "";
      previewPanel.appendChild(renderPreview(channel, lang, data));
    } catch (err) {
      if (mine !== previewSeq) return;
      previewPanel.textContent = "";
      previewPanel.appendChild(el("p", { className: "field__error" }, err.message));
    } finally {
      if (mine === previewSeq) previewPanel.setAttribute("aria-busy", "false");
    }
  }
  const previewLater = debounce(runPreview, 700);
  function schedulePreview(now) {
    if (!previewTabs) return;
    if (now) runPreview();
    else previewLater();
  }

  function refreshPreviewTabs() {
    if (!previewTabs) return;
    const channels = channelBoxes.filter((b) => b.checked).map((b) => ({ key: b.value, label: b.dataset.label, panelId: previewPanel.id }));
    previewTabs.render(channels, previewTabs.active);
    if (!channels.length) {
      previewPanel.textContent = "";
      previewPanel.appendChild(el("p", { className: "field__hint" }, "Choose a channel to see a preview."));
    }
  }

  function refreshPreviewLangs() {
    if (!previewLang) return;
    const current = previewLang.value;
    const written = langPanels().filter((p) => {
      const title = $("input[name$='[title]']", p);
      const body = $("textarea", p);
      return (title && title.value.trim()) || (body && body.value.trim());
    });
    const list = written.length ? written : langPanels().slice(0, 1);
    const codes = list.map((p) => p.dataset.ncLangPanel);
    if (codes.join() === $$("option", previewLang).map((o) => o.value).join()) return;
    previewLang.textContent = "";
    list.forEach((p) => previewLang.add(new Option(p.dataset.label, p.dataset.ncLangPanel)));
    previewLang.value = codes.includes(current) ? current : codes[0] || "ta";
  }

  if (preview) {
    $("[data-nc-preview-toolbar]", preview).hidden = false;
    previewTabs = createTabs($("[data-nc-preview-tabs]", preview), { idPrefix: "nc-pv", onSelect: () => schedulePreview(true) });
    refreshPreviewLangs();
    refreshPreviewTabs();
    previewLang.addEventListener("change", () => schedulePreview(true));
    form.addEventListener("input", (e) => {
      if (!e.target.closest("[data-nc-refresh]") && !e.target.matches("[data-nc-refresh]")) return;
      refreshPreviewLangs();
      schedulePreview();
    });
    form.addEventListener("change", (e) => {
      if (e.target.matches("select[data-nc-refresh]")) schedulePreview();
    });
  }

  /* 6. Counters ------------------------------------------------------------ */
  // GSM 03.38: one unit per basic character, two per extension character;
  // anything else makes the whole message UCS-2, counted in UTF-16 units.
  const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const GSM_EXTENDED = "^{}\\[~]|€\f";
  function smsInfo(text) {
    let units = 0;
    for (const ch of text) {
      if (GSM_BASIC.includes(ch)) units += 1;
      else if (GSM_EXTENDED.includes(ch)) units += 2;
      else {
        const ucs = text.length;
        return { chars: ucs, segments: ucs <= 70 ? 1 : Math.ceil(ucs / 67), encoding: "UCS-2" };
      }
    }
    return { chars: units, segments: units <= 160 ? 1 : Math.ceil(units / 153), encoding: "GSM-7" };
  }
  function updateSmsCounters() {
    const smsOn = channelBoxes.some((b) => b.value === "sms" && b.checked);
    $$("[data-nc-body]", form).forEach((area) => {
      const out = area.closest("label")?.querySelector("[data-nc-sms-count]");
      if (!out) return;
      const text = area.value.trim();
      if (!smsOn || !text) {
        out.textContent = "";
        return;
      }
      const s = smsInfo(text);
      out.textContent = `As an SMS: about ${s.chars} characters in ${s.segments} part${s.segments === 1 ? "" : "s"} (${s.encoding}). Each part is charged.`;
    });
  }
  const smsLater = debounce(updateSmsCounters, 200);
  form.addEventListener("input", (e) => { if (e.target.matches("[data-nc-body]")) smsLater(); });
  updateSmsCounters();

  channelBoxes.forEach((box) => box.addEventListener("change", () => {
    box.closest(".nc-channel")?.classList.toggle("is-checked", box.checked);
    updateSmsCounters();
    refreshPreviewTabs();
    scheduleEstimate();
  }));

  /* 7. Schedule ------------------------------------------------------------ */
  const modeRadios = $$("[data-nc-schedule-mode]", form);
  const atBox = $("[data-nc-schedule-at]", form);
  const recurrence = $("[data-nc-recurrence]", form);
  const until = $("[data-nc-until]", form);
  function syncSchedule() {
    if (atBox) atBox.hidden = (modeRadios.find((r) => r.checked)?.value || "manual") !== "at";
    if (until && recurrence) until.hidden = recurrence.value === "none";
  }
  if (atBox) {
    modeRadios.forEach((r) => r.addEventListener("change", syncSchedule));
    recurrence?.addEventListener("change", syncSchedule);
    // A field with an error is never hidden, whatever the mode says.
    if (!atBox.querySelector('[aria-invalid="true"]')) syncSchedule();
  }

  /* 8. Errors -------------------------------------------------------------- */
  function reveal(node) {
    const langPanel = node.closest("[data-nc-lang-panel]");
    if (langPanel && langTabs) langTabs.select(langPanel.dataset.ncLangPanel, false);
    const sourcePanel = node.closest("[data-nc-source-panel]");
    if (sourcePanel) {
      const radio = $(`[data-nc-source][value="${sourcePanel.dataset.ncSourcePanel}"]`, form);
      if (radio) {
        radio.checked = true;
        syncSource();
      }
    }
    if (node.closest("[data-nc-schedule-at]") && atBox) atBox.hidden = false;
  }
  const summary = $("#nc-error-summary");
  if (summary) {
    summary.focus();
    summary.addEventListener("click", (e) => {
      const link = e.target.closest("a[href^='#']");
      if (!link) return;
      const target = document.getElementById(link.getAttribute("href").slice(1));
      if (!target) return;
      e.preventDefault();
      reveal(target);
      const focusable = target.matches("input, select, textarea, button") ? target : $("input:not([type=hidden]), select, textarea", target);
      (focusable || target).focus();
      (focusable || target).scrollIntoView({ block: "center" });
    });
  }
})();
