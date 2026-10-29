/* Sales tools: helpers every tool page shares.

     SalesUI.esc(text)            HTML-escape
     SalesUI.pretty(odooName)     "[30003] SALPIC CASA ROJA 150 ML HABANERO"
                                   -> "Casa Roja 150 ML Habanero"
     SalesUI.thumb(row)           product photo tile (row.images, else the
                                   published catalogue's photo for row.sku)
     SalesUI.go(view, hash)       open another tool (inside the sales-tools
                                   page, or as its own page)
     SalesUI.loading(el, text)    spinner + placeholder rows while Odoo answers */
window.SalesUI = (function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Same tidying as the Catalogue builder: drop Odoo's [code] and the internal
  // category code at the start, and fix the capitals. XPROD stays visible;
  // the sales team cares whether something is an XPROD.
  var CODES = {
    CANDY: 1, CHOCO: 1, COOKI: 1, PASTR: 1, POSTR: 1, BEVER: 1, SNACK: 1, TOTOP: 1,
    CHILE: 1, SALSA: 1, SALPIC: 1, SAUCE: 1, CONDI: 1, SAZON: 1, ESPEC: 1, CPOWD: 1,
    MOLEP: 1, MOLEL: 1, VEGET: 1, FRUTA: 1, FRIJO: 1, TORTI: 1, TOSTA: 1, HARIN: 1,
    ARROZ: 1, BFCER: 1, UTENS: 1, PDISH: 1, CARDS: 1, ACCESS: 1, DPROD: 1, PWDDK: 1,
    SPREA: 1, PLAYS: 1, QUESO: 1, MOSTA: 1
  };
  function nice(t) {
    return String(t).replace(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'&.]*/g, function (w) {
      // Short words are sizes or codes (UN, CS), except Spanish/French
      // articles: "De La Rosa", not "DE LA Rosa".
      if (/^(de|la|el|y|en|al|lo|le|du|da)$/i.test(w)) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      if (w.length <= 2) return w.toUpperCase();
      if (w.indexOf("&") > -1) return w.toUpperCase();
      if (/^(GR|ML|LT|KG|UN|OZ|EU|DE|NL|FR|BBQ|XL|XPROD)$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  }
  function pretty(name) {
    var t = String(name || "").replace(/^\s*\[[^\]]*\]\s*/, "");
    var parts = t.split(/\s+/);
    if (parts.length > 1 && CODES[parts[0].toUpperCase()]) parts.shift();
    return nice(parts.join(" "));
  }

  // Photos: the API sends them on a Mac; online they come from the
  // catalogue published next to these pages.
  var catalogImages = {};
  var catalogReady = fetch("data/catalog.json").then(function (r) { return r.json(); }).then(function (cat) {
    var pub = cat.photos_published || {};
    (cat.products || []).forEach(function (p) {
      if (!p.sku) return;
      var list = [];
      if (pub[p.sku]) list.push("photos/" + encodeURIComponent(p.sku) + ".jpg");
      if (p.image) list.push(p.image);
      if (list.length) catalogImages[p.sku] = list;
    });
  }).catch(function () {});

  function thumb(r, size) {
    var box = document.createElement("div");
    box.className = "thumb";
    if (size) { box.style.width = box.style.height = size + "px"; }
    function fill() {
      var list = (r.images && r.images.length ? r.images : (catalogImages[r.sku] || [])).slice();
      if (!list.length) { box.classList.add("none"); return; }
      box.classList.remove("none");
      var img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      img.onerror = function () { if (list.length) img.src = list.shift(); else { img.remove(); box.classList.add("none"); } };
      img.src = list.shift();
      box.appendChild(img);
    }
    if ((r.images && r.images.length) || catalogImages[r.sku]) fill();
    else { box.classList.add("none"); catalogReady.then(function () { if (!box.firstChild && catalogImages[r.sku]) fill(); }); }
    return box;
  }

  // Inside the sales-tools page each tool is a frame: ask the page to switch.
  // Opened on its own, just go to the other page.
  var PAGES = { stock: "stock-check.html", customer: "customer.html", reco: "reco.html", restock: "restock.html" };
  function go(view, hash) {
    if (window.parent !== window) window.parent.postMessage({ app: "open-view", view: view, hash: hash || "" }, "*");
    else location.href = PAGES[view] + (hash ? "#" + hash : "");
  }

  function loading(el, text, rows) {
    el.innerHTML = '<div class="loading"><div class="msg"><span class="spin"></span>' + esc(text) + "</div>" +
      new Array(rows || 6).join('<div class="sk sk-row"></div>') + "</div>";
  }

  return { esc: esc, pretty: pretty, thumb: thumb, go: go, loading: loading, catalogReady: catalogReady };
})();
