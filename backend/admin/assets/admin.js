/* Temple Admin — progressive enhancements (no framework).
   1. Mobile sidebar drawer
   2. Flash alerts -> glass toasts
   3. Native confirm() -> accessible glass dialog
   4. Responsive tables (data-label from <th>) + client-side search
   5. Password visibility toggle, drop-zone feedback, loading buttons
*/
(function () {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* 1. Sidebar drawer -------------------------------------------- */
  const toggle = $(".sidebar-toggle");
  const backdrop = $(".sidebar-backdrop");
  const setSidebar = (open) => {
    document.body.classList.toggle("sidebar-open", open);
    if (toggle) toggle.setAttribute("aria-expanded", String(open));
  };
  toggle?.addEventListener("click", () => setSidebar(!document.body.classList.contains("sidebar-open")));
  backdrop?.addEventListener("click", () => setSidebar(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("sidebar-open")) setSidebar(false);
  });

  /* 2. Toasts ------------------------------------------------------ */
  let region = $(".toast-region");
  if (!region) {
    region = document.createElement("div");
    region.className = "toast-region";
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  function toast(message, type = "info", timeout = 5000) {
    const el = document.createElement("div");
    el.className = `toast toast--${type}`;
    el.setAttribute("role", type === "error" ? "alert" : "status");
    const icon = { success: "🙏", error: "⚠️", info: "ℹ️", warning: "⚠️" }[type] || "ℹ️";
    el.innerHTML = `<span aria-hidden="true">${icon}</span><div>${message}</div>` +
      `<button type="button" class="toast__close" aria-label="Dismiss">✕</button>`;
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
    while (node && node.classList.contains("alert")) {
      const next = node.nextElementSibling;
      const type = node.classList.contains("alert--success") ? "success"
        : node.classList.contains("alert--error") ? "error"
        : node.classList.contains("alert--warning") ? "warning" : "info";
      toast(node.innerHTML, type, type === "error" ? 8000 : 5000);
      node.remove();
      node = next;
    }
  }

  /* 3. Confirm dialog --------------------------------------------- */
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";
  overlay.innerHTML =
    '<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-desc">' +
    '<div class="dialog__icon" aria-hidden="true">🗑️</div>' +
    '<h3 id="dlg-title">Confirm action</h3>' +
    '<p id="dlg-desc"></p>' +
    '<div class="dialog__actions">' +
    '<button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>' +
    '<button type="button" class="btn btn-danger" data-act="ok">Delete</button>' +
    "</div></div>";
  document.body.appendChild(overlay);
  const dlgDesc = $("#dlg-desc", overlay);
  const dlgOk = $('[data-act="ok"]', overlay);
  const dlgCancel = $('[data-act="cancel"]', overlay);
  let dlgResolve = null;
  let dlgOpener = null;

  function confirmDialog(message, okLabel = "Delete") {
    return new Promise((resolve) => {
      dlgResolve = resolve;
      dlgOpener = document.activeElement;
      dlgDesc.textContent = message;
      dlgOk.textContent = okLabel;
      overlay.dataset.open = "true";
      dlgCancel.focus();
    });
  }
  function closeDialog(result) {
    overlay.dataset.open = "false";
    dlgResolve?.(result);
    dlgResolve = null;
    dlgOpener?.focus?.();
  }
  dlgOk.addEventListener("click", () => closeDialog(true));
  dlgCancel.addEventListener("click", () => closeDialog(false));
  overlay.addEventListener("mousedown", (e) => e.target === overlay && closeDialog(false));
  document.addEventListener("keydown", (e) => {
    if (overlay.dataset.open !== "true") return;
    if (e.key === "Escape") closeDialog(false);
    if (e.key === "Tab") {
      // two-button focus trap
      e.preventDefault();
      (document.activeElement === dlgOk ? dlgCancel : dlgOk).focus();
    }
  });
  window.adminConfirm = confirmDialog;

  // Intercept legacy onclick="return confirm('…')" buttons
  $$('button[onclick^="return confirm"], a[onclick^="return confirm"]').forEach((btn) => {
    const match = /confirm\((['"])(.*?)\1\)/.exec(btn.getAttribute("onclick") || "");
    const message = match ? match[2] : "Are you sure?";
    btn.removeAttribute("onclick");
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const ok = await confirmDialog(message, btn.textContent.trim().replace(/^Del$/, "Delete") || "Confirm");
      if (!ok) return;
      const form = btn.closest("form");
      if (form) {
        btn.classList.add("btn--loading");
        form.submit();
      } else if (btn.href) {
        window.location.href = btn.href;
      }
    });
  });

  /* 4. Responsive tables + search --------------------------------- */
  $$(".admin-table").forEach((table) => {
    const headers = $$("thead th", table).map((th) => th.textContent.trim());
    if (headers.length) {
      table.classList.add("is-responsive");
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
    const rows = $$("tbody tr:not(.table-empty)", table);
    if (rows.length >= 6 && !table.hasAttribute("data-no-search")) {
      const bar = document.createElement("div");
      bar.className = "table-toolbar";
      const id = `tsearch-${Math.random().toString(36).slice(2, 7)}`;
      bar.innerHTML =
        `<div class="table-toolbar__search"><label class="sr-only" for="${id}">Search table</label>` +
        `<input id="${id}" type="search" placeholder="Search ${rows.length} rows…" autocomplete="off"></div>` +
        `<span class="table-toolbar__count">${rows.length} record(s)</span>`;
      const host = table.closest(".table-wrap") || table;
      host.parentNode.insertBefore(bar, host);
      const input = $("input", bar);
      const count = $(".table-toolbar__count", bar);
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        let shown = 0;
        rows.forEach((tr) => {
          const hit = !q || tr.textContent.toLowerCase().includes(q);
          tr.hidden = !hit;
          if (hit) shown++;
        });
        count.textContent = q ? `${shown} of ${rows.length}` : `${rows.length} record(s)`;
      });
    }
  });

  /* 5. Small interactions ----------------------------------------- */
  $$("[data-toggle-password]").forEach((btn) => {
    const input = document.getElementById(btn.dataset.togglePassword);
    if (!input) return;
    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.setAttribute("aria-pressed", String(show));
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      btn.textContent = show ? "🙈" : "👁";
    });
  });

  $$(".dropzone").forEach((zone) => {
    const input = $('input[type="file"]', zone);
    const label = $(".dropzone__file", zone);
    if (!input) return;
    const show = () => {
      const f = input.files?.[0];
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
  });

  // Loading state on submit (skip forms with confirm buttons already handled)
  $$("form").forEach((form) => {
    form.addEventListener("submit", () => {
      const btn = $('button[type="submit"], button:not([type])', form);
      if (btn && !btn.classList.contains("btn-danger")) {
        btn.classList.add("btn--loading");
        btn.setAttribute("aria-busy", "true");
      }
    });
  });
})();
