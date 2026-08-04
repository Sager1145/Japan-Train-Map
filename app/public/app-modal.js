/*
 * app-modal.js — railprint-styled, theme-aware, NON-BLOCKING dialogs.
 *
 * Replaces window.confirm()/prompt(). The native dialogs (a) block the main
 * thread synchronously — the "载入全部示例资料 / load all data" freeze the user
 * hit was the native confirm() pausing the whole tab — and (b) can't be themed.
 * These are built from the same design tokens as railprint's station hover
 * popup (.rp-popup / CSS variables), so they match its style AND inherit
 * light/dark automatically through html[data-theme].
 *
 * Publishes:
 *   uiConfirm(message, { danger, okText, cancelText }) -> Promise<boolean>
 *   uiPrompt(message, defaultValue, { placeholder, okText, cancelText })
 *                                              -> Promise<string|null>
 *   uiChoose(message, items, { cancelText })   -> Promise<number|null>
 *     items: [{ label, sublabel, color }] — a tappable list (touch-first
 *     disambiguation, e.g. overlapping route lines under one map tap).
 * Dialogs are serialized (a second call queues behind the first) so two never
 * stack, and each resolves its promise instead of blocking — no freeze.
 */
(function (global) {
  "use strict";

  const doc = () => global.document;
  // Serializes dialogs: each waits for the previous to close.
  let tail = Promise.resolve();
  let dialogSequence = 0;

  // Translated label with a hard-coded fallback (I18N may not have the key on
  // an old cached bundle, and the sandboxed precompute replay has no I18N).
  function label(key, fallback) {
    try {
      const i18n = global.I18N;
      if (i18n && typeof i18n.t === "function") {
        const v = i18n.t(key);
        if (v && v !== key) return v;
      }
    } catch (_) {
      /* fall through to fallback */
    }
    return fallback;
  }

  // Build + mount one dialog. `render(dialog, finish)` fills the dialog body and
  // wires controls; it must call finish(value) to resolve. Returns a Promise.
  function present(render) {
    const result = tail.then(
      () =>
        new Promise((resolve) => {
          const d = doc();
          if (!d || !d.body) {
            resolve(undefined);
            return;
          }
          const previouslyFocused = d.activeElement;
          const overlay = d.createElement("div");
          overlay.className = "rp-modal-overlay";
          const dialog = d.createElement("div");
          dialog.className = "rp-modal";
          dialog.setAttribute("role", "dialog");
          dialog.setAttribute("aria-modal", "true");
          overlay.appendChild(dialog);

          // The overlay is a sibling of #app. Make the application tree
          // genuinely unavailable while aria-modal is active, then restore
          // its exact prior state when the dialog closes.
          const background = d.getElementById("app");
          const backgroundWasInert = background ? Boolean(background.inert) : false;
          const backgroundHadAriaHidden = background
            ? background.hasAttribute("aria-hidden")
            : false;
          const backgroundAriaHidden = background
            ? background.getAttribute("aria-hidden")
            : null;
          if (background) {
            background.inert = true;
            background.setAttribute("aria-hidden", "true");
          }

          let settled = false;
          let cleaned = false;
          let settledValue;
          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            if (overlay.parentNode) overlay.remove();
            if (background) {
              background.inert = backgroundWasInert;
              if (backgroundHadAriaHidden)
                background.setAttribute("aria-hidden", backgroundAriaHidden);
              else background.removeAttribute("aria-hidden");
            }
            if (
              previouslyFocused &&
              previouslyFocused.focus &&
              previouslyFocused.isConnected !== false
            ) {
              try {
                previouslyFocused.focus();
              } catch (_) {
                /* element gone */
              }
            }
            // Resolve only after teardown so a queued dialog cannot overlap
            // this one's inert/focus state during the closing transition.
            resolve(settledValue);
          };
          const finish = (value) => {
            if (settled) return;
            settled = true;
            settledValue = value;
            d.removeEventListener("keydown", onKey, true);
            overlay.classList.remove("is-open");
            // Remove after the fade-out; also guard with a fallback timer.
            overlay.addEventListener("transitionend", cleanup, { once: true });
            global.setTimeout(cleanup, 220);
          };

          const onKey = (e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              finish(render.cancelValue);
            } else if (e.key === "Enter" && !e.shiftKey) {
              // A focused button keeps its NATIVE Enter activation: Enter on
              // 取消 must cancel, not fire the accept shortcut (which made
              // Enter confirm even danger dialogs with Cancel focused).
              const active = d.activeElement;
              if (active && dialog.contains(active) && active.tagName === "BUTTON")
                return;
              // Let the render decide the accept value (confirm=true, prompt=text).
              const accept = render.getAcceptValue && render.getAcceptValue();
              if (accept !== undefined) {
                e.preventDefault();
                finish(accept);
              }
            } else if (e.key === "Tab") {
              // Minimal focus trap: aria-modal promises modality, so Tab must
              // cycle within the dialog instead of escaping into the page.
              const focusables = dialog.querySelectorAll("button, input");
              if (!focusables.length) return;
              const first = focusables[0];
              const last = focusables[focusables.length - 1];
              const active = d.activeElement;
              if (!active || !dialog.contains(active)) {
                e.preventDefault();
                first.focus();
              } else if (e.shiftKey && active === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
              }
            }
          };

          overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) finish(render.cancelValue);
          });
          d.addEventListener("keydown", onKey, true);

          render(dialog, finish);

          const heading = dialog.querySelector(".rp-modal-title");
          const message = dialog.querySelector(".rp-modal-message");
          const labelEl =
            heading && heading.textContent
              ? heading
              : message && message.textContent
                ? message
                : null;
          if (labelEl) {
            labelEl.id = `rp-modal-label-${++dialogSequence}`;
            dialog.setAttribute("aria-labelledby", labelEl.id);
            const input = dialog.querySelector(".rp-modal-input");
            // The input is described by the message body when there is one.
            if (input && message && message.textContent) {
              if (!message.id) message.id = `rp-modal-message-${dialogSequence}`;
              input.setAttribute("aria-labelledby", message.id);
            } else if (input) {
              input.setAttribute("aria-labelledby", labelEl.id);
            }
          } else {
            dialog.setAttribute("aria-label", label("modal.dialog", "Dialog"));
          }

          d.body.appendChild(overlay);
          // Force a reflow so the .is-open transition actually plays.
          void overlay.offsetWidth;
          overlay.classList.add("is-open");
          if (render.initialFocus) render.initialFocus();
        }),
    );
    // Keep the queue alive even if a dialog rejects (it never should).
    tail = result.catch(() => {});
    return result;
  }

  function actionsRow(finish, opts, acceptValue) {
    const d = doc();
    const actions = d.createElement("div");
    actions.className = "rp-modal-actions";
    const cancel = d.createElement("button");
    cancel.type = "button";
    cancel.className = "rp-modal-btn";
    cancel.textContent = opts.cancelText || label("modal.cancel", "取消");
    cancel.addEventListener("click", () => finish(null));
    const ok = d.createElement("button");
    ok.type = "button";
    ok.className =
      "rp-modal-btn rp-modal-btn--primary" +
      (opts.danger ? " rp-modal-btn--danger" : "");
    ok.textContent = opts.okText || label("modal.ok", "確定");
    ok.addEventListener("click", () => finish(acceptValue()));
    actions.appendChild(cancel);
    actions.appendChild(ok);
    return { actions, ok };
  }

  function messageNode(message) {
    const p = doc().createElement("p");
    p.className = "rp-modal-message";
    p.textContent = message == null ? "" : String(message);
    return p;
  }

  // Optional opts.title heading shared by confirm/prompt/choose.
  function titleNode(title) {
    if (title == null || title === "") return null;
    const h = doc().createElement("h2");
    h.className = "rp-modal-title";
    h.textContent = String(title);
    return h;
  }

  function appendHeader(dialog, message, opts) {
    const heading = titleNode(opts && opts.title);
    if (heading) dialog.appendChild(heading);
    dialog.appendChild(messageNode(message));
  }

  function uiConfirm(message, opts = {}) {
    const render = (dialog, finish) => {
      const acceptValue = () => true;
      const { actions, ok } = actionsRow(finish, opts, acceptValue);
      appendHeader(dialog, message, opts);
      dialog.appendChild(actions);
      render.getAcceptValue = () => true;
      render.initialFocus = () => ok.focus();
    };
    render.cancelValue = false;
    return present(render).then((v) => v === true);
  }

  function uiPrompt(message, defaultValue = "", opts = {}) {
    const render = (dialog, finish) => {
      const d = doc();
      const input = d.createElement("input");
      input.type = "text";
      input.className = "rp-modal-input";
      input.value = defaultValue == null ? "" : String(defaultValue);
      if (opts.placeholder) input.placeholder = opts.placeholder;
      const acceptValue = () => input.value;
      const { actions } = actionsRow(finish, opts, acceptValue);
      appendHeader(dialog, message, opts);
      dialog.appendChild(input);
      dialog.appendChild(actions);
      render.getAcceptValue = () => input.value;
      render.initialFocus = () => {
        input.focus();
        input.select();
      };
    };
    render.cancelValue = null;
    return present(render).then((v) => (v == null ? null : v));
  }

  function uiChoose(message, items, opts = {}) {
    const render = (dialog, finish) => {
      const d = doc();
      appendHeader(dialog, message, opts);
      const list = d.createElement("div");
      list.className = "rp-modal-choices";
      (items || []).forEach((item, index) => {
        const btn = d.createElement("button");
        btn.type = "button";
        btn.className = "rp-modal-choice";
        if (item.color) {
          const swatch = d.createElement("span");
          swatch.className = "rp-modal-choice-swatch";
          swatch.style.background = item.color;
          btn.appendChild(swatch);
        }
        const text = d.createElement("span");
        text.className = "rp-modal-choice-text";
        const title = d.createElement("span");
        title.className = "rp-modal-choice-title";
        title.textContent = item.label == null ? "" : String(item.label);
        text.appendChild(title);
        if (item.sublabel) {
          const sub = d.createElement("span");
          sub.className = "rp-modal-choice-sub";
          sub.textContent = String(item.sublabel);
          text.appendChild(sub);
        }
        btn.appendChild(text);
        btn.addEventListener("click", () => finish(index));
        list.appendChild(btn);
      });
      dialog.appendChild(list);
      const actions = d.createElement("div");
      actions.className = "rp-modal-actions";
      const cancel = d.createElement("button");
      cancel.type = "button";
      cancel.className = "rp-modal-btn";
      cancel.textContent = opts.cancelText || label("modal.cancel", "取消");
      cancel.addEventListener("click", () => finish(null));
      actions.appendChild(cancel);
      dialog.appendChild(actions);
      // No getAcceptValue: Enter only activates the focused list button.
      render.initialFocus = () => {
        const first = list.querySelector("button");
        if (first) first.focus();
      };
    };
    render.cancelValue = null;
    return present(render).then((v) => (typeof v === "number" ? v : null));
  }

  global.uiConfirm = uiConfirm;
  global.uiPrompt = uiPrompt;
  global.uiChoose = uiChoose;
})(typeof window !== "undefined" ? window : this);
