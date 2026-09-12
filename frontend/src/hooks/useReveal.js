import { useEffect } from "react";

/**
 * useReveal — fades `.reveal` blocks in as they scroll into view.
 *
 * Fail-safe by design: the hiding rule in utilities.css is scoped to
 * `html.has-reveal`, and this hook is what adds that class. If the bundle
 * never runs, the class is never added and every section renders at full
 * opacity — content can never be trapped behind a broken animation. A
 * belt-and-braces timer also reveals anything still hidden after 4s, in case
 * IntersectionObserver misbehaves (some in-app browsers throttle it).
 *
 * One shared observer; elements are unobserved once revealed, so there is no
 * ongoing work. A MutationObserver picks up blocks that mount later (after an
 * API response or a tab switch). Under prefers-reduced-motion the CSS shows
 * everything immediately and the observer simply has nothing to do.
 *
 *   useReveal([dependency that changes the DOM]);
 */
export default function useReveal(deps = []) {
  useEffect(() => {
    const root = document.documentElement;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // No observer support, or the visitor asked for less motion → show everything.
    if (typeof IntersectionObserver === "undefined" || reduced) {
      root.classList.remove("has-reveal");
      document.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-visible"));
      return undefined;
    }
    root.classList.add("has-reveal");

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );

    const observeAll = (node = document) => {
      node.querySelectorAll?.(".reveal:not(.is-visible)").forEach((el) => io.observe(el));
      if (node !== document && node.matches?.(".reveal:not(.is-visible)")) io.observe(node);
    };
    observeAll();

    // Blocks that mount after data arrives must still be observed.
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === 1) observeAll(node);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // Safety net: never leave content invisible.
    const failsafe = setTimeout(() => {
      document.querySelectorAll(".reveal:not(.is-visible)").forEach((el) => {
        const top = el.getBoundingClientRect().top;
        if (top < window.innerHeight * 1.2) el.classList.add("is-visible");
      });
    }, 4000);

    return () => {
      io.disconnect();
      mo.disconnect();
      clearTimeout(failsafe);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
