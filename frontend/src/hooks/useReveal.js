import { useEffect } from "react";

/**
 * useReveal — toggles `.is-visible` on every `.reveal` element as it scrolls
 * into view. One shared IntersectionObserver; elements are unobserved once
 * revealed so there is no ongoing work. A MutationObserver picks up `.reveal`
 * blocks that mount later (after an API response, a tab switch, …) so nothing
 * can stay hidden. Under prefers-reduced-motion the CSS shows everything
 * immediately and this becomes a no-op.
 *
 *   useReveal([dependency that changes the DOM]);
 */
export default function useReveal(deps = []) {
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;

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

    const observeAll = (root = document) => {
      root.querySelectorAll?.(".reveal:not(.is-visible)").forEach((el) => io.observe(el));
      if (root !== document && root.matches?.(".reveal:not(.is-visible)")) io.observe(root);
    };
    observeAll();

    // Late-mounted sections (data-driven) must still be observed.
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === 1) observeAll(node);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
