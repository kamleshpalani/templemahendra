/* Temple Admin — progressive enhancements (no framework, no build step).
   1. Sidebar: mobile drawer + desktop collapse (persisted)
   2. Flash alerts → glass toasts
   3. Confirm dialog (replaces confirm(); honours data-confirm on submit buttons)
   4. Dropdown / context menus (data-menu-toggle) with keyboard support
   5. Command palette (Ctrl/⌘+K) over pages + quick actions
   6. Tables: responsive data-labels, client search, row selection + bulk bar
   7. Forms: loading buttons, password toggle, caps-lock hint, drop-zones,
      collapsible form panel on mobile, live character counters
   8. Bulk import: chunked progress runner (bulk_upload.php)
*/
(function () {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const icons = (() => {
    try { return JSON.parse($("#icon-sprite")?.textContent || "{}"); } catch (e) { return {}; }
  })();
  const icon = (name) => icons[name] || "";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* 1. Sidebar ------------------------------------------------------ */
  const toggle = $(".sidebar-toggle");
  const backdrop = $(".sidebar-backdrop");
  const setSidebar = (open) => {
    document.body.classList.toggle("sidebar-open", open);
    toggle?.setAttribute("aria-expanded", String(open));
    if (open) $(".sidebar__link.is-active, .sidebar__link")?.focus({ preventScroll: true });
    else toggle?.focus({ preventScroll: true });
  };
  toggle?.addEventListener("click", () => setSidebar(!document.body.classList.contains("sidebar-open")));
  backdrop?.addEventListener("click", () => setSidebar(false));
  $("[data-sidebar-collapse]")?.addEventListener("click", () => {
    const collapsed = document.documentElement.classList.toggle("sidebar-collapsed");
    try { localStorage.setItem("admin.sidebar", collapsed ? "collapsed" : "open"); } catch (e) {}
    $("[data-sidebar-collapse]").setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    $("[data-sidebar-collapse]").setAttribute("data-tip", collapsed ? "Expand" : "Collapse");
  });

  /* 2. Toasts --------------------------------------------------------- */
  let region = $(".toast-region");
  if (!region) {
    region = document.createElement("div");
    region.className = "toast-region";
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  function toast(message, type = "info", timeout = 5000, isHtml = false) {
    const el = document.createElement("div");
    el.className = `toast toast--${type}`;
    el.setAttribute("role", type === "error" ? "alert" : "status");
    const ic = { success: "check-circle", error: "alert-circle", warning: "alert", info: "info" }[type] || "info";
    el.innerHTML =
      `<span class="toast__icon">${icon(ic)}</span><div class="toast__body"></div>` +
      `<button type="button" class="toast__close" aria-label="Dismiss">${icon("x")}</button>`;
    if (isHtml) $(".toast__body", el).innerHTML = message;
    else $(".toast__body", el).textContent = message;
    const remove = () => {
      el.classList.add("toast--leaving");
      setTimeout(() => el.remove(), 240);
    };
    $(".toast__close", el).addEventListener("click", remove);
    region.appendChild(el);
    if (timeout > 0) setTimeout(remove, timeout);
    return el;
  }
  window.adminToast = toast;

  // Convert server-rendered flash alerts at the top of the page into toasts
  const content = $(".admin-content");
  if (content) {
    let node = content.firstElementChild;
    while (node && node.classList.contains("alert") && !node.hasAttribute("data-keep")) {
      const next = node.nextElementSibling;
      const type = node.classList.contains("alert--success") ? "success"
        : node.classList.contains("alert--error") ? "error"
        : node.classList.contains("alert--warning") ? "warning" : "info";
      toast(node.innerHTML, type, type === "error" ? 8000 : 5000, true);
      node.remove();
      node = next;
    }
  }

  /* 3. Confirm dialog ------------------------------------------------- */
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";
  overlay.hidden = true;
  overlay.innerHTML =
    '<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-desc">' +
    `<div class="dialog__icon">${icon("trash")}</div>` +
    '<h2 id="dlg-title">Please confirm</h2>' +
    '<p id="dlg-desc"></p>' +
    '<div class="dialog__actions">' +
    '<button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>' +
    '<button type="button" class="btn btn-danger" data-act="ok">Delete</button>' +
    "</div></div>";
  document.body.appendChild(overlay);
  const dlgDesc = $("#dlg-desc", overlay);
  const dlgTitle = $("#dlg-title", overlay);
  const dlgOk = $('[data-act="ok"]', overlay);
  const dlgCancel = $('[data-act="cancel"]', overlay);
  const dlgIcon = $(".dialog__icon", overlay);
  let dlgResolve = null;
  let dlgOpener = null;

  function confirmDialog(message, okLabel = "Delete", opts = {}) {
    return new Promise((resolve) => {
      dlgResolve = resolve;
      dlgOpener = document.activeElement;
      dlgTitle.textContent = opts.title || "Please confirm";
      dlgDesc.textContent = message;
      dlgOk.textContent = okLabel;
      dlgOk.className = "btn " + (opts.danger === false ? "btn-primary" : "btn-danger");
      dlgIcon.className = "dialog__icon" + (opts.danger === false ? " dialog__icon--warning" : "");
      dlgIcon.innerHTML = icon(opts.danger === false ? "alert" : "trash");
      overlay.hidden = false;
      overlay.dataset.open = "true";
      dlgCancel.focus();
    });
  }
  function closeDialog(result) {
    overlay.dataset.open = "false";
    overlay.hidden = true;
    dlgResolve?.(result);
    dlgResolve = null;
    dlgOpener?.focus?.();
  }
  dlgOk.addEventListener("click", () => closeDialog(true));
  dlgCancel.addEventListener("click", () => closeDialog(false));
  overlay.addEventListener("mousedown", (e) => e.target === overlay && closeDialog(false));
  document.addEventListener("keydown", (e) => {
    if (overlay.hidden) return;
    if (e.key === "Escape") closeDialog(false);
    if (e.key === "Tab") {
      e.preventDefault();
      (document.activeElement === dlgOk ? dlgCancel : dlgOk).focus();
    }
  });
  window.adminConfirm = confirmDialog;

  // Buttons/links that need confirmation: data-confirm="message" [data-confirm-label]
  // plus legacy onclick="return confirm('…')".
  const hookConfirm = (btn, message, label) => {
    btn.addEventListener("click", async (e) => {
      if (btn.dataset.confirmed === "1") return; // second pass after confirmation
      e.preventDefault();
      const ok = await confirmDialog(message, label || btn.textContent.trim().replace(/^Del$/, "Delete") || "Confirm", {
        danger: !/^(approve|confirm|mark|save|import|activate)/i.test(label || ""),
      });
      if (!ok) return;
      const form = btn.closest("form");
      if (form) {
        btn.classList.add("btn--loading");
        btn.dataset.confirmed = "1";
        form.requestSubmit ? form.requestSubmit(btn) : form.submit();
      } else if (btn.href) {
        window.location.href = btn.href;
      }
    });
  };
  $$('button[onclick^="return confirm"], a[onclick^="return confirm"]').forEach((btn) => {
    const match = /confirm\((['"])(.*?)\1\)/.exec(btn.getAttribute("onclick") || "");
    btn.removeAttribute("onclick");
    hookConfirm(btn, match ? match[2] : "Are you sure?");
  });
  $$("[data-confirm]").forEach((btn) => hookConfirm(btn, btn.dataset.confirm, btn.dataset.confirmLabel));

  /* 4. Dropdown menus --------------------------------------------------- */
  let openMenu = null;
  const closeMenus = () => {
    if (!openMenu) return;
    openMenu.menu.hidden = true;
    openMenu.btn.setAttribute("aria-expanded", "false");
    openMenu = null;
  };
  $$("[data-menu-toggle]").forEach((btn) => {
    const menu = document.getElementById(btn.getAttribute("aria-controls"));
    if (!menu) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      closeMenus();
      if (willOpen) {
        // Flip upwards if there is no room below
        const rect = btn.getBoundingClientRect();
        menu.classList.toggle("menu--up", window.innerHeight - rect.bottom < 260 && rect.top > 260);
        menu.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        openMenu = { btn, menu };
        $('[role="menuitem"]', menu)?.focus();
      }
    });
    menu.addEventListener("keydown", (e) => {
      const items = $$('[role="menuitem"]', menu);
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
      if (e.key === "Escape") { closeMenus(); btn.focus(); }
    });
  });
  document.addEventListener("click", (e) => { if (openMenu && !openMenu.menu.contains(e.target)) closeMenus(); });
  document.addEventListener("keydown", (e) => e.key === "Escape" && openMenu && closeMenus());

  /* 5. Command palette --------------------------------------------------- */
  const palette = $("#palette");
  const pInput = $("#palette-input");
  const pList = $("#palette-list");
  let pData = [];
  try { pData = JSON.parse($("#palette-data")?.textContent || "[]"); } catch (e) {}
  let pItems = [];
  let pIndex = 0;
  let pOpener = null;

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const highlight = (text, q) => {
    if (!q) return escapeHtml(text);
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return escapeHtml(text);
    return escapeHtml(text.slice(0, i)) + "<mark>" + escapeHtml(text.slice(i, i + q.length)) + "</mark>" + escapeHtml(text.slice(i + q.length));
  };
  function renderPalette(q) {
    const query = q.trim().toLowerCase();
    pItems = pData.filter((it) => !query || (it.label + " " + it.desc + " " + it.group).toLowerCase().includes(query));
    pIndex = 0;
    if (!pItems.length) {
      pList.innerHTML = '<li class="palette__empty">No matches. Try "events", "donations" or "export".</li>';
      return;
    }
    let html = "";
    let lastGroup = null;
    pItems.forEach((it, idx) => {
      if (it.group !== lastGroup) {
        html += `<li class="palette__group" role="presentation">${escapeHtml(it.group)}</li>`;
        lastGroup = it.group;
      }
      html += `<li class="palette__item" role="option" id="pal-${idx}" data-idx="${idx}" aria-selected="${idx === 0}">${icon(it.icon)}` +
        `<span><span class="palette__item-label">${highlight(it.label, query)}</span>` +
        (it.desc ? `<span class="palette__item-desc">${escapeHtml(it.desc)}</span>` : "") + `</span></li>`;
    });
    pList.innerHTML = html;
    pInput.setAttribute("aria-activedescendant", "pal-0");
  }
  function selectPalette(idx) {
    $$(".palette__item", pList).forEach((li) => li.setAttribute("aria-selected", String(Number(li.dataset.idx) === idx)));
    pIndex = idx;
    pInput.setAttribute("aria-activedescendant", `pal-${idx}`);
    document.getElementById(`pal-${idx}`)?.scrollIntoView({ block: "nearest" });
  }
  function openPalette() {
    if (!palette) return;
    pOpener = document.activeElement;
    palette.hidden = false;
    pInput.value = "";
    renderPalette("");
    pInput.focus();
  }
  function closePalette() {
    if (!palette || palette.hidden) return;
    palette.hidden = true;
    pOpener?.focus?.();
  }
  function runPalette() {
    const it = pItems[pIndex];
    if (!it) return;
    if (it.external) window.open(it.href, "_blank", "noopener");
    else window.location.href = it.href;
    closePalette();
  }
  if (palette) {
    $$("[data-palette-open]").forEach((b) => b.addEventListener("click", openPalette));
    pInput.addEventListener("input", () => renderPalette(pInput.value));
    pInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); selectPalette(Math.min(pIndex + 1, pItems.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selectPalette(Math.max(pIndex - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); runPalette(); }
      else if (e.key === "Escape") { closePalette(); }
    });
    pList.addEventListener("click", (e) => {
      const li = e.target.closest(".palette__item");
      if (!li) return;
      selectPalette(Number(li.dataset.idx));
      runPalette();
    });
    palette.addEventListener("mousedown", (e) => e.target === palette && closePalette());
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette.hidden ? openPalette() : closePalette(); }
      if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement?.tagName || "") && palette.hidden) { e.preventDefault(); openPalette(); }
    });
  }

  /* 6. Tables ------------------------------------------------------------- */
  $$("table.table, table.admin-table").forEach((table) => {
    // Responsive card mode: label each cell from its header
    const headers = $$("thead th", table).map((th) => th.textContent.trim());
    if (headers.length && !table.hasAttribute("data-no-responsive")) {
      table.classList.add("table--responsive");
      $$("tbody tr", table).forEach((tr) => {
        if (tr.classList.contains("table-empty") || tr.querySelector("td[colspan]")) {
          tr.classList.add("table-empty");
          return;
        }
        $$("td", tr).forEach((td, i) => {
          if (!td.hasAttribute("data-label")) td.setAttribute("data-label", headers[i] || "");
        });
      });
    }
    // Client-side filter for medium lists without server search
    const rows = $$("tbody tr:not(.table-empty)", table);
    if (rows.length >= 6 && !table.hasAttribute("data-no-search") && !$(".toolbar__search", table.closest(".admin-list, .card, .admin-content") || document.body)) {
      const bar = document.createElement("div");
      bar.className = "toolbar";
      const id = `tsearch-${Math.random().toString(36).slice(2, 7)}`;
      bar.innerHTML =
        `<div class="toolbar__search">${icon("search") || ""}<label class="sr-only" for="${id}">Search table</label>` +
        `<input id="${id}" type="search" placeholder="Filter ${rows.length} rows…" autocomplete="off"></div>` +
        `<span class="toolbar__count">${rows.length} record${rows.length === 1 ? "" : "s"}</span>`;
      const host = table.closest(".table-wrap") || table;
      host.parentNode.insertBefore(bar, host);
      const input = $("input", bar);
      const count = $(".toolbar__count", bar);
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        let shown = 0;
        rows.forEach((tr) => {
          const hit = !q || tr.textContent.toLowerCase().includes(q);
          tr.hidden = !hit;
          if (hit) shown++;
        });
        count.textContent = q ? `${shown} of ${rows.length}` : `${rows.length} record${rows.length === 1 ? "" : "s"}`;
      });
    }
    // Row selection + bulk bar (table needs data-bulk="<form id>")
    const bulkFormId = table.dataset.bulk;
    if (bulkFormId) {
      const bulkForm = document.getElementById(bulkFormId);
      const bar = bulkForm ? $(".bulk-bar", bulkForm) || bulkForm : null;
      const all = $("thead input[type=checkbox][data-select-all]", table);
      const boxes = () => $$("tbody input[type=checkbox][name='ids[]']", table);
      const sync = () => {
        const checked = boxes().filter((b) => b.checked);
        boxes().forEach((b) => b.closest("tr")?.classList.toggle("is-selected", b.checked));
        if (all) {
          all.checked = checked.length > 0 && checked.length === boxes().length;
          all.indeterminate = checked.length > 0 && checked.length < boxes().length;
        }
        if (bar) {
          bar.hidden = checked.length === 0;
          const c = $(".bulk-bar__count", bar);
          if (c) c.textContent = `${checked.length} selected`;
          // Mirror selected ids into the bulk form
          $$("input[name='ids[]']", bulkForm).forEach((h) => h.remove());
          checked.forEach((b) => {
            const h = document.createElement("input");
            h.type = "hidden"; h.name = "ids[]"; h.value = b.value;
            bulkForm.appendChild(h);
          });
        }
      };
      all?.addEventListener("change", () => { boxes().forEach((b) => (b.checked = all.checked)); sync(); });
      table.addEventListener("change", (e) => e.target.matches("input[name='ids[]']") && sync());
      $$("[data-bulk-clear]", bulkForm || document).forEach((b) => b.addEventListener("click", () => { boxes().forEach((x) => (x.checked = false)); sync(); }));
      sync();
    }
  });

  /* 7. Forms ------------------------------------------------------------- */
  // Password visibility
  $$("[data-toggle-password]").forEach((btn) => {
    const input = document.getElementById(btn.dataset.togglePassword);
    if (!input) return;
    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.setAttribute("aria-pressed", String(show));
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      btn.innerHTML = icon(show ? "eye-off" : "eye") || (show ? "Hide" : "Show");
      input.focus();
    });
  });
  // Caps-lock hint next to password fields
  $$("input[type=password]").forEach((input) => {
    const hint = $("[data-capslock]", input.closest("form") || document);
    if (!hint) return;
    const check = (e) => hint.classList.toggle("is-on", Boolean(e.getModifierState && e.getModifierState("CapsLock")));
    input.addEventListener("keydown", check);
    input.addEventListener("keyup", check);
    input.addEventListener("blur", () => hint.classList.remove("is-on"));
  });
  // Drop zones
  $$(".dropzone").forEach((zone) => {
    const input = $('input[type="file"]', zone);
    const label = $(".dropzone__file", zone);
    if (!input) return;
    const show = () => {
      const f = input.files?.[0];
      zone.classList.toggle("dropzone--has-file", Boolean(f));
      if (label) label.textContent = f ? `${f.name} · ${(f.size / 1024).toFixed(1)} KB` : "";
    };
    input.addEventListener("change", show);
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("dropzone--over"); }));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove("dropzone--over")));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) {
        input.files = e.dataTransfer.files;
        show();
      }
    });
    zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  });
  // Loading state on submit
  $$("form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      const btn = e.submitter || $('button[type="submit"], button:not([type])', form);
      if (btn && !btn.classList.contains("btn--loading") && !btn.hasAttribute("data-no-loading")) {
        btn.classList.add("btn--loading");
        btn.setAttribute("aria-busy", "true");
      }
    });
  });
  // Character counters: <textarea data-counter maxlength=…>
  $$("[data-counter]").forEach((el) => {
    const max = Number(el.getAttribute("maxlength")) || 0;
    const out = document.createElement("span");
    out.className = "field__hint tabular";
    out.setAttribute("aria-live", "polite");
    el.insertAdjacentElement("afterend", out);
    const update = () => { out.textContent = max ? `${el.value.length} / ${max}` : `${el.value.length} characters`; };
    el.addEventListener("input", update);
    update();
  });
  // Collapsible form panel on mobile (+ auto-open when editing or #new)
  $$(".admin-two-col--collapsible").forEach((wrap) => {
    const btn = (wrap.id && $(`.form-drawer-toggle[aria-controls="${wrap.id}"]`)) || $(".form-drawer-toggle", wrap);
    const panel = $(".admin-form-box", wrap);
    if (!btn || !panel) return;
    const setOpen = (open) => {
      wrap.classList.toggle("is-form-open", open);
      btn.setAttribute("aria-expanded", String(open));
      if (open) $("input, select, textarea", panel)?.focus({ preventScroll: true });
    };
    btn.addEventListener("click", () => setOpen(!wrap.classList.contains("is-form-open")));
    if (location.hash === "#new" || wrap.dataset.editing === "1") setOpen(true);
    window.addEventListener("hashchange", () => location.hash === "#new" && setOpen(true));
  });
  // Auto-submit selects marked data-autosubmit (status quick-change) with a toast
  $$("select[data-autosubmit]").forEach((sel) => {
    sel.addEventListener("change", () => {
      sel.disabled = true;
      sel.form?.requestSubmit ? sel.form.requestSubmit() : sel.form?.submit();
    });
  });

  /* 8. Bulk import runner -------------------------------------------------- */
  const runner = $("[data-import-runner]");
  if (runner) {
    const bar = $(".progress__bar", runner);
    const countEl = $("[data-import-count]", runner);
    const liveEl = $("[data-import-live]", runner);
    const total = Number(runner.dataset.total) || 0;
    const chunk = Number(runner.dataset.chunk) || 100;
    const entity = runner.dataset.entity;
    const token = runner.dataset.csrf;
    const skipDup = runner.dataset.skipDuplicates === "1";
    const done = { ok: 0, fail: 0, skipped: 0, dup: 0 };
    let offset = 0;
    const tally = (r) => { for (const k of Object.keys(done)) done[k] += Number(r[k] || 0); };
    const paint = () => {
      const processed = Math.min(offset, total);
      if (bar) bar.style.width = total ? `${Math.round((processed / total) * 100)}%` : "100%";
      runner.setAttribute("aria-valuenow", String(processed));
      if (countEl) countEl.textContent = `${processed} / ${total}`;
      if (liveEl) liveEl.innerHTML =
        `<span class="badge badge--success">${done.ok} imported</span>` +
        `<span class="badge badge--warning">${done.dup} duplicates</span>` +
        `<span class="badge badge--danger">${done.skipped} invalid</span>` +
        (done.fail ? `<span class="badge badge--danger">${done.fail} failed</span>` : "");
    };
    const step = async () => {
      if (offset >= total) {
        const params = new URLSearchParams({ entity, done: "1" });
        window.location.href = `bulk_upload.php?${params}`;
        return;
      }
      try {
        const body = new URLSearchParams({ _csrf: token, entity, action: "import_chunk", offset: String(offset), limit: String(chunk), skip_duplicates: skipDup ? "1" : "0" });
        const res = await fetch("bulk_upload.php", { method: "POST", headers: { Accept: "application/json" }, body });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        tally(data);
        offset += Number(data.processed || chunk);
        paint();
        setTimeout(step, reduceMotion ? 0 : 120);
      } catch (err) {
        runner.classList.add("is-error");
        if (liveEl) liveEl.innerHTML = `<span class="badge badge--danger">Import stopped: ${escapeHtml(String(err.message || err))}</span>`;
        toast("Import stopped. Rows already imported were kept; reload to see the summary.", "error", 0);
      }
    };
    paint();
    step();
  }
})();
