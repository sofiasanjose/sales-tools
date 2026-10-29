/* "How it works" card, the same idea as the Catalogue builder's: a short
   step-by-step in the bottom-right corner, shown the first time someone
   opens a tool and again whenever they ask for it.

     SalesHelp.setup({
       key: "stock",                       // remembers "seen" per tool
       title: "Checking stock",
       steps: [["Pick a price list", "on the left…"], …],
       tips: ["…"]                          // optional, in a blue box
     });

   Inside the sales-tools page the top bar's "How it works" button toggles
   it (by message); opened on its own, the page gets its own button. */
window.SalesHelp = (function () {
  var card = null;
  var seenKey = "";

  var CSS =
    ".hiw{position:fixed;right:18px;bottom:18px;width:350px;max-width:calc(100vw - 36px);z-index:70;display:none;" +
    "background:#fff;color:#1d1d1d;border:1px solid #e3e6ea;border-radius:12px;padding:15px 17px;" +
    "box-shadow:0 10px 34px rgba(0,0,0,.16);font:12.5px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
    "max-height:calc(100vh - 36px);overflow-y:auto}" +
    ".hiw.on{display:block;animation:hiw-in .2s ease}" +
    "@keyframes hiw-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}" +
    ".hiw b{color:#17457d}" +
    ".hiw>.hiw-title{display:block;font-size:13.5px;margin-bottom:8px;color:#17457d;font-weight:700}" +
    ".hiw .hiw-step{color:#4b5563;margin-bottom:9px}" +
    ".hiw .hiw-tips{background:#e2efff;border-radius:9px;padding:10px 12px;margin:2px 0 11px;color:#38414c}" +
    ".hiw .hiw-tips>b{display:block;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#205ba6;margin-bottom:5px}" +
    ".hiw .hiw-tips div{margin-bottom:6px}.hiw .hiw-tips div:last-child{margin-bottom:0}" +
    ".hiw button.hiw-ok{width:100%;border:1px solid #e3e6ea;background:#fff;border-radius:7px;padding:6px 10px;" +
    "font:inherit;font-weight:600;color:#1d1d1d;cursor:pointer}" +
    ".hiw button.hiw-ok:hover{background:#f3f4f6}" +
    ".hiw-open{position:fixed;right:18px;bottom:18px;z-index:69;border:1px solid #e3e6ea;background:#fff;color:#205ba6;" +
    "border-radius:20px;padding:7px 14px;font:600 12.5px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
    "box-shadow:0 4px 14px rgba(0,0,0,.12);cursor:pointer}" +
    ".hiw-open:hover{background:#e2efff}" +
    "@media (prefers-color-scheme: dark){.hiw{background:#1b1f2b;color:#e7e9ee;border-color:#2c3345}" +
    ".hiw b,.hiw>.hiw-title{color:#9cc2f2}.hiw .hiw-step{color:#c3c8d2}.hiw .hiw-tips{background:#1c2a3f;color:#c3c8d2}" +
    ".hiw .hiw-tips>b{color:#9cc2f2}.hiw button.hiw-ok,.hiw-open{background:#1b1f2b;color:#e7e9ee;border-color:#2c3345}}";

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function toggle(on) {
    if (!card) return;
    var show = on == null ? !card.classList.contains("on") : on;
    card.classList.toggle("on", show);
    if (!show) { try { localStorage.setItem(seenKey, "1"); } catch (e) {} }
  }

  function setup(opts) {
    seenKey = "st-help-seen-" + opts.key;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    card = document.createElement("div");
    card.className = "hiw";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "How it works");
    card.innerHTML = '<span class="hiw-title">' + esc(opts.title) + '</span>' +
      opts.steps.map(function (s, i) {
        return '<div class="hiw-step"><b>' + (i + 1) + ". " + esc(s[0]) + "</b> — " + s[1] + "</div>";
      }).join("") +
      (opts.tips && opts.tips.length
        ? '<div class="hiw-tips"><b>Good to know</b>' + opts.tips.map(function (t) { return "<div>" + t + "</div>"; }).join("") + "</div>"
        : "") +
      '<button type="button" class="hiw-ok">Got it</button>';
    document.body.appendChild(card);
    card.querySelector(".hiw-ok").addEventListener("click", function () { toggle(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") toggle(false); });

    var embedded = window.parent !== window;
    if (embedded) {
      // The sales-tools page's top bar has the button.
      window.addEventListener("message", function (e) {
        if (e.source === window.parent && e.data && e.data.app === "toggle-help") toggle();
      });
    } else {
      var open = document.createElement("button");
      open.type = "button";
      open.className = "hiw-open";
      open.textContent = "How it works";
      open.addEventListener("click", function () { toggle(); });
      document.body.appendChild(open);
    }

    var seen = false;
    try { seen = !!localStorage.getItem(seenKey); } catch (e) { seen = true; }
    if (!seen) toggle(true);
  }

  return { setup: setup, toggle: toggle };
})();
