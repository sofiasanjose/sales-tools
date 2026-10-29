/* Catalog Builder
   Reads data/catalog.js (window.CATALOG_DATA) and lets a salesperson filter,
   select and export a branded PDF catalog for one customer.
   No build step, no server, no dependencies. */

(function () {
"use strict";

var DATA     = window.CATALOG_DATA || { products: [], generated_at: "" };
var PRODUCTS = DATA.products || [];
var LOGO     = window.CATALOG_LOGO || "";
var BRAND    = window.CATALOG_BRAND || {};
var LS_KEY   = "st-catalog-builder-v1";

/* ------------------------------------------------------------------ state */
var state = {
  q: "",
  sort: "title",
  f: { countries: [], categories: [], subcategories: [], brands: [] },
  inStock: false,
  xprod: "",                 // "", "hide" or "only" - see isXprod()
  selected: [],              // array of product ids, in catalogue order
  unavailable: [],           // ids in the catalogue that today's data lacks
  imported: [],              // products from a price list that are not on the website
  brandQuery: "",
  meta: {
    customer: "", title: "Product Catalog", rep: "", date: today(),
    contact: "", note: "", layout: "detailed", quality: "standard",
    pack: true, sku: true, group: true, prices: false,
    // Per-catalogue changes, see "per-catalogue edits" below.
    edits: {}, sections: {}, sectionOrder: [], sectionNotes: {}
  }
};

/* Ids shipped in data/catalog.js - the website plus the wholesale lists that
   refresh_data.py merged in. Anything else was imported in this browser. */
var byId = {}, BUILT_IN = {};
PRODUCTS.forEach(function (p) { byId[p.id] = p; BUILT_IN[p.id] = true; });

/* SKU -> absolute path in the marketing photo repository, indexed by
   refresh_data.py. Photos are referenced where they already live, never
   copied. How we reach them depends on how the page was opened:
     file://   - link straight to the file
     http://   - go through serve.py, which streams /photos/<sku> */
/* The photo index lives in data/photos.js, written by refresh_data.py and
   kept on the Mac that has the marketing folder synced - it is never
   deployed. The hosted site has no such file, so it falls back to the
   storefront images (catalog.json keeps "photos": {} - see HOSTING.md). */
var PHOTO_INDEX = window.CATALOG_PHOTOS || {};
var PHOTOS = PHOTO_INDEX.photos || DATA.photos || {};
var PHOTO_ROOT = PHOTO_INDEX.photo_root || DATA.photo_root || "";
var OVER_HTTP = location.protocol === "http:" || location.protocol === "https:";

/* The marketing photo repository is the source of truth for product imagery:
   its files are named by SKU and never move, whereas Shopify renames its CDN
   files and those links expire within hours. So the repository wins whenever
   it has the product, and the storefront image is only a fallback. */
function bestImage(p) {
  return photoFor(p.sku) || p.image || "";
}

/* SKUs whose marketing photo is published alongside the site as
   photos/<sku>.jpg (written by publish_photos.py). The hosted copy has no
   access to the SharePoint folder, so this is how those photos get there. */
var PUBLISHED = DATA.photos_published || {};

function photoFor(sku) {
  if (!sku) return "";
  if (!PHOTOS[sku]) {
    return (OVER_HTTP && PUBLISHED[sku]) ? "photos/" + encodeURIComponent(sku) + ".jpg" : "";
  }
  if (OVER_HTTP) return "photos/" + encodeURIComponent(sku) + ".jpg";
  // Opened as a file: the page's own path tells us the home folder, so a
  // "~/..." root resolves on whichever Mac this is.
  var root = PHOTO_ROOT;
  if (root.charAt(0) === "~") {
    var m = decodeURIComponent(location.pathname).match(/^(\/Users\/[^/]+)\//);
    if (!m) return "";
    root = m[1] + root.slice(1);
  }
  var full = root + "/" + PHOTOS[sku];
  return "file://" + full.split("/").map(encodeURIComponent).join("/");
}

/* SKU -> product, used to match price list rows against the website.
   A handful of SKUs are listed twice on Shopify; prefer the copy that has a
   photo, otherwise an import can match the emptier of the two. */
var bySku = {};
PRODUCTS.forEach(function (p) {
  if (!p.sku) return;
  var cur = bySku[p.sku];
  if (!cur || (!cur.image && p.image)) bySku[p.sku] = p;
});

/* Products that came from an imported price list but are not on the website.
   They are added to byId so every other part of the app (selection drawer,
   PDF, CSV) treats them like any other product. */
function adoptProduct(p, remember) {
  // bestImage() already prefers the repository; nothing to overwrite here.
  if (!byId[p.id]) {
    byId[p.id] = p;
    PRODUCTS.push(p);
    if (remember !== false &&
        !state.imported.some(function (x) { return x.id === p.id; })) {
      state.imported.push(p);
    }
  }
  return p.id;
}

/* ----------------------------------------------------------------- helpers */
/* Local date, not UTC: toISOString() is still "yesterday" in Spain until 2am. */
function today() { return dayOf(new Date()); }
function dayOf(d) {
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" +
         ("0" + d.getDate()).slice(-2);
}
function $(s) { return document.querySelector(s); }
function el(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
/* Shopify CDN can resize on the fly - ask for only what we render.
   Only the CDN understands ?width=; appending it to an embedded data: URI
   corrupts it, and local files under assets/ are already the right size. */
function img(url, w) {
  if (!url) return "";
  if (url.indexOf("data:") === 0 || url.indexOf("http") !== 0) return url;
  return url + (url.indexOf("?") > -1 ? "&" : "?") + "width=" + w;
}
/* Titles are ALL CAPS in Shopify; soften them for the customer-facing PDF. */
function nice(t) {
  return String(t).replace(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'&.]*/g, function (w) {
    if (w.length <= 2) return w.toUpperCase();
    if (w.indexOf("&") > -1) return w.toUpperCase();   // A&W, M&M
    if (/^(GR|ML|LT|KG|UN|OZ|EU|DE|NL|FR|BBQ|XL)$/i.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}
/* Titles start with an internal category code (SALPIC = salsa picante,
   BEVER = beverage, XPROD = other, ...). Useful to the sales team, noise to
   the customer - so it is stripped from the PDF but kept in the app grid. */
var TITLE_CODES = {
  CANDY:1, CHOCO:1, COOKI:1, PASTR:1, POSTR:1, BEVER:1, SNACK:1, TOTOP:1,
  CHILE:1, SALSA:1, SALPIC:1, SAUCE:1, CONDI:1, SAZON:1, ESPEC:1, CPOWD:1,
  MOLEP:1, MOLEL:1, VEGET:1, FRUTA:1, FRIJO:1, TORTI:1, TOSTA:1, HARIN:1,
  ARROZ:1, BFCER:1, UTENS:1, PDISH:1, CARDS:1, ACCESS:1, XPROD:1
};
function cleanTitle(t) {
  var parts = String(t).split(" ");
  if (parts.length > 1 && TITLE_CODES[parts[0].toUpperCase()]) parts.shift();
  return nice(parts.join(" "));
}
/* -------------------------------------------------- per-catalogue edits
   Whatever a salesperson changes for one customer - a product's name (a
   Spanish translation, say), SKU, brand, country, pack size, photo or
   section, plus section headings and their order - lives in state.meta:

     edits:        product id -> { title, sku, brand, country, units_per_case,
                                   units_per_display, section, photo }
     sections:     section -> heading to print instead
     sectionOrder: sections in the order the salesperson arranged them
     sheetUnits:   product id -> case size taken from an imported sheet (so
                   it isn't flagged as a hand edit, like an imported price)

   So it travels with the catalog (saved draft, Recent catalogs) and never
   touches the product data. Only the differences are stored. */
function freshEdits(m) {
  m.edits = {}; m.sections = {}; m.sectionOrder = []; m.sectionNotes = {}; m.sheetUnits = {};
}
function normalizeMeta(m) {
  if (!m.edits || typeof m.edits !== "object") m.edits = {};
  if (!m.sections || typeof m.sections !== "object") m.sections = {};
  if (!Array.isArray(m.sectionOrder)) m.sectionOrder = [];
  if (!m.sectionNotes || typeof m.sectionNotes !== "object") m.sectionNotes = {};
  if (!m.sheetUnits || typeof m.sheetUnits !== "object") m.sheetUnits = {};
  // Catalogues from before the editor kept renames on their own.
  if (m.names) {
    Object.keys(m.names).forEach(function (id) {
      var e = m.edits[id] || (m.edits[id] = {});
      if (!e.title) e.title = m.names[id];
    });
    delete m.names;
  }
}
function ed(p) { return state.meta.edits[p.id] || {}; }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
/* A price on its own is not an edit: it usually came straight from the
   imported sheet, and flagging every row as "edited" would say nothing. The
   same goes for a case size the sheet supplied. */
function isEdited(p) {
  var e = state.meta.edits[p.id];
  var fromSheet = (state.meta.sheetUnits || {})[p.id];
  return !!e && Object.keys(e).some(function (k) {
    if (k === "price") return false;
    if (k === "units_per_case" && fromSheet && e[k] === fromSheet) return false;
    return true;
  });
}
function setEdit(p, key, value) {
  var all = state.meta.edits, e = all[p.id] || {};
  if (value === undefined) delete e[key]; else e[key] = value;
  if (Object.keys(e).length) all[p.id] = e; else delete all[p.id];
  // Remembered for later catalogues. Undoing it here does not forget it -
  // that is done from the saved-edits list. Prices are the exception: they
  // go stale, so they live in this catalogue only and are never offered again.
  if (value !== undefined && key !== "price") {
    var L = libLoad(), saved = L.products[p.id] || (L.products[p.id] = {});
    saved[key] = value;
    libSave();
  }
}

/* ------------------------------------------------------------ saved edits
   Every change made to a product or a section heading, in any catalog, is
   also remembered here so it never has to be done twice. New catalogs
   still start from the original data; Arrange & edit offers the saved edits
   for the products in it, and they are applied only when the salesperson
   says so (a Spanish name should not land in an English catalog unasked).
   Kept in this browser: text and photo keys only, never image data. */
var LIB_KEY = "st-saved-edits-v1";
var lib = null;

function libLoad() {
  if (lib) return lib;
  try { lib = JSON.parse(localStorage.getItem(LIB_KEY)); } catch (e) { lib = null; }
  if (!lib || typeof lib !== "object" || !lib.products) {
    // First time: gather what earlier catalogues already contain, oldest
    // first so the latest version of each edit wins.
    lib = { products: {}, sections: {}, sectionNotes: {} };
    var metas = historyLoad().slice().reverse().map(function (h) { return h.meta; });
    metas.push(state.meta);
    metas.forEach(function (m) {
      if (!m) return;
      var c = JSON.parse(JSON.stringify(m));
      normalizeMeta(c);
      Object.keys(c.edits).forEach(function (id) {
        var saved = lib.products[id] || (lib.products[id] = {});
        Object.keys(c.edits[id]).forEach(function (k) { saved[k] = c.edits[id][k]; });
      });
      Object.keys(c.sections).forEach(function (k) { lib.sections[k] = c.sections[k]; });
      Object.keys(c.sectionNotes || {}).forEach(function (k) { lib.sectionNotes[k] = c.sectionNotes[k]; });
    });
    libSave();
  }
  if (!lib.sections) lib.sections = {};
  if (!lib.sectionNotes) lib.sectionNotes = {};
  Object.keys(lib.products).forEach(function (id) {
    if (byId[id]) return;
    var now = resolveId(id);
    if (now == null) return;
    if (!lib.products[now]) lib.products[now] = lib.products[id];
    delete lib.products[id];
  });
  return lib;
}
function libSave() {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch (e) {}
}

/* Saved edits that this catalogue does not have yet. */
function savedOffers() {
  var L = libLoad(), out = { products: [], sections: [], notes: [] };
  selectedItems().forEach(function (p) {
    var saved = L.products[p.id];
    if (!saved) return;
    var cur = ed(p);
    var keys = Object.keys(saved).filter(function (k) {
      return JSON.stringify(cur[k]) !== JSON.stringify(saved[k]);
    });
    if (keys.length) out.products.push({ p: p, saved: saved, keys: keys });
  });
  if (state.meta.group) {
    currentSectionKeys().forEach(function (k) {
      var v = L.sections[k];
      if (v && state.meta.sections[k] !== v) out.sections.push({ key: k, label: v });
      var note = (L.sectionNotes || {})[k];
      if (note && state.meta.sectionNotes[k] !== note) out.notes.push({ key: k, note: note });
    });
  }
  return out;
}

function describeEdit(saved, keys) {
  return keys.map(function (k) {
    var v = saved[k];
    if (k === "title") return "name “" + v + "”";
    if (k === "sku") return "SKU " + (v || "(none)");
    if (k === "brand") return "brand " + (v || "(none)");
    if (k === "country") return "country " + (v || "(none)");
    if (k === "units_per_case") return v ? v + " per case" : "case size hidden";
    if (k === "units_per_display") return v ? "display of " + v : "display size hidden";
    if (k === "section") return "section “" + sectionLabel(v) + "”";
    if (k === "photo") return v === "none" ? "photo removed" : "your own photo";
    if (k === "note") return "note “" + v + "”";
    return k;
  }).join(" · ");
}

var offer = null;

function savedModal(on) {
  $("#sv-modal").classList.toggle("on", on);
  $("#sv-back").classList.toggle("on", on);
  if (on) savedRender();
}

function savedRender() {
  offer = savedOffers();
  var box = $("#sv-body");
  box.innerHTML = "";
  var n = offer.products.length + offer.sections.length + offer.notes.length;
  $("#sv-ok").disabled = !n;
  if (!n) {
    box.appendChild(el("div", "meta-note", "Nothing to apply - this catalog " +
      "already has all your saved edits."));
    return;
  }
  box.appendChild(el("div", "meta-note sv-intro", "Changes you made to these in " +
    "earlier catalogs. Untick anything this customer should see as the " +
    "original; × forgets a saved edit for good."));

  function row(label, sub, attr, i, forget) {
    var r = el("label", "sv-row");
    var cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = true;
    cb.setAttribute(attr, i);
    r.appendChild(cb);
    var t = el("div", "sv-main");
    t.appendChild(el("div", "sv-name", label));
    t.appendChild(el("div", "meta-note", sub));
    r.appendChild(t);
    var f = el("button", "hist-del", "×");
    f.title = "Forget this saved edit";
    f.onclick = function (e) {
      e.preventDefault();
      forget();
      libSave();
      savedRender();
      renderSelected();
    };
    r.appendChild(f);
    box.appendChild(r);
  }
  if (offer.products.length) box.appendChild(el("div", "sv-head", "Products"));
  offer.products.forEach(function (x, i) {
    row(view(x.p).name, describeEdit(x.saved, x.keys), "data-i", i,
        function () { delete libLoad().products[x.p.id]; });
  });
  if (offer.sections.length) box.appendChild(el("div", "sv-head", "Section headings"));
  offer.sections.forEach(function (x, i) {
    row(sectionLabel(x.key), "heading “" + x.label + "”", "data-s", i,
        function () { delete libLoad().sections[x.key]; });
  });
  if (offer.notes.length) box.appendChild(el("div", "sv-head", "Section notes"));
  offer.notes.forEach(function (x, i) {
    row(sectionLabel(x.key), "note “" + x.note + "”", "data-n", i,
        function () { delete libLoad().sectionNotes[x.key]; });
  });
}

function applySaved() {
  if (!offer) return;
  pinSections();
  var n = 0;
  document.querySelectorAll("#sv-body input[data-i]").forEach(function (cb) {
    if (!cb.checked) return;
    var x = offer.products[+cb.getAttribute("data-i")];
    x.keys.forEach(function (k) {
      if (k === "section") setSection(x.p, x.saved[k]);
      else setEdit(x.p, k, x.saved[k]);
    });
    n++;
  });
  document.querySelectorAll("#sv-body input[data-s]").forEach(function (cb) {
    if (!cb.checked) return;
    var x = offer.sections[+cb.getAttribute("data-s")];
    state.meta.sections[x.key] = x.label;
    n++;
  });
  document.querySelectorAll("#sv-body input[data-n]").forEach(function (cb) {
    if (!cb.checked) return;
    var x = offer.notes[+cb.getAttribute("data-n")];
    state.meta.sectionNotes[x.key] = x.note;
    n++;
  });
  savedModal(false);
  loadPhotos(changed);
  toast(n ? "Applied " + n + " saved edit" + (n > 1 ? "s" : "") : "Nothing applied");
}

function defaultSection(p) {
  return p.subcategories[0] || p.categories[0] || "Other products";
}
function sectionKey(p) { return ed(p).section || defaultSection(p); }
function sectionLabel(key) { return state.meta.sections[key] || key; }
function sectionNote(key) { return state.meta.sectionNotes[key] || ""; }
function setSectionNote(key, text) {
  var v = String(text || "").replace(/[ \t]+/g, " ").trim();
  if (v) { state.meta.sectionNotes[key] = v; libLoad().sectionNotes[key] = v; libSave(); }
  else delete state.meta.sectionNotes[key];
  changed();
}

/* Photos uploaded for a catalogue, by key ("img:..."). Held in memory while
   the page is open and in this browser's IndexedDB between visits - never in
   the project folder, never in localStorage. */
var PHOTO_MEM = {};

function photoOf(p) {
  var r = ed(p).photo;
  if (r === "none") return "";
  if (r && PHOTO_MEM[r]) return PHOTO_MEM[r];
  return bestImage(p);
}

/* The product as it prints in this catalogue. */
function view(p) {
  var e = ed(p);
  return {
    name: e.title || cleanTitle(p.title),
    sku: has(e, "sku") ? e.sku : (p.sku || ""),
    brand: has(e, "brand") ? e.brand : (p.brands[0] || ""),
    country: has(e, "country") ? e.country : (p.countries[0] || ""),
    units_per_case: has(e, "units_per_case") ? e.units_per_case : p.units_per_case,
    units_per_display: has(e, "units_per_display") ? e.units_per_display : p.units_per_display,
    // Only printed when "Show prices" is ticked. Products without one simply
    // print nothing, so a half-priced list is fine.
    price: priceText(has(e, "price") ? e.price : (p.price || "")),
    image: photoOf(p),
    noPhoto: e.photo === "none",
    note: e.note || ""
  };
}

/* ---- uploaded photo storage (IndexedDB) ---- */
var PHOTO_DB = "st-catalog-photos", PHOTO_STORE = "photos";
function idb(cb) {
  if (idb.db !== undefined) return cb(idb.db);
  try {
    var rq = indexedDB.open(PHOTO_DB, 1);
    rq.onupgradeneeded = function () { rq.result.createObjectStore(PHOTO_STORE); };
    rq.onsuccess = function () { idb.db = rq.result; cb(idb.db); };
    rq.onerror = function () { idb.db = null; cb(null); };
  } catch (e) { idb.db = null; cb(null); }
}
function idbPut(key, uri) {
  idb(function (db) {
    if (!db) return toast("This browser would not keep the photo - it will be gone after a reload.");
    try { db.transaction(PHOTO_STORE, "readwrite").objectStore(PHOTO_STORE).put(uri, key); }
    catch (e) {}
  });
}
/* Load the uploaded photos this catalogue uses, then call back. */
function loadPhotos(cb) {
  var want = [];
  Object.keys(state.meta.edits).forEach(function (id) {
    var r = state.meta.edits[id].photo;
    if (r && r.indexOf("img:") === 0 && !PHOTO_MEM[r]) want.push(r);
  });
  if (!want.length) return cb();
  idb(function (db) {
    if (!db) return cb();
    var left = want.length, st;
    try { st = db.transaction(PHOTO_STORE).objectStore(PHOTO_STORE); }
    catch (e) { return cb(); }
    want.forEach(function (k) {
      var g = st.get(k);
      g.onsuccess = function () { if (g.result) PHOTO_MEM[k] = g.result; if (!--left) cb(); };
      g.onerror = function () { if (!--left) cb(); };
    });
  });
}
/* Forget uploaded photos that neither the draft nor any recent catalogue uses. */
function prunePhotos() {
  var keep = {};
  function mark(m) {
    if (m && m.edits) Object.keys(m.edits).forEach(function (id) {
      if (m.edits[id].photo) keep[m.edits[id].photo] = 1;
    });
  }
  mark(state.meta);
  historyLoad().forEach(function (h) { mark(h.meta); });
  mark({ edits: libLoad().products });
  idb(function (db) {
    if (!db) return;
    try {
      var c = db.transaction(PHOTO_STORE, "readwrite").objectStore(PHOTO_STORE).openCursor();
      c.onsuccess = function () {
        var cur = c.result;
        if (!cur) return;
        if (!keep[cur.key]) cur.delete();
        cur.continue();
      };
    } catch (e) {}
  });
}

/* Pack size for the customer-facing catalogue. "Units per display" is 1 on
   most products, which means there is no display - only show it when real. */
function caseLabel(p) {
  var c = p.units_per_case;
  return (c && c > 1) ? c + " per case" : "";
}
function displayLabel(p) {
  var d = p.units_per_display;
  return (d && d > 1) ? "Display of " + d : "";
}

/* Retry a thumbnail, then try the other source, before declaring it missing.

   There are two possible sources and either can fail: the repository photo is
   unreachable to anyone without the marketing folder synced, and Shopify's CDN
   links expire. Whichever we started with, fall back to the other. */
function imageRetry(im, p, width, holder) {
  var tries = 0, swapped = false;
  var first = im.src;
  return function () {
    tries++;
    if (tries > 2) {
      if (!swapped) {
        swapped = true;
        tries = 0;
        var alt = (first.indexOf(p.image) === -1 && p.image)
          ? img(p.image, width)          // started with the repository
          : img(photoFor(p.sku), width); // started with Shopify
        if (alt && alt !== first) { im.src = alt; return; }
      }
      if (holder) holder.classList.add("broken");
      return;
    }
    var delay = 400 * tries + Math.random() * 600;
    // Cache-bust with the right separator: the photo route has no query
    // string, and "&r=1" without a "?" was being read as part of the SKU.
    var current = im.src.replace(/[?&]r=\d+$/, "");
    setTimeout(function () {
      im.src = current + (current.indexOf("?") > -1 ? "&" : "?") + "r=" + tries;
    }, delay);
  };
}

function toast(msg) {
  var t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.classList.remove("on"); }, 2200);
}

/* --------------------------------------------------------------- filtering */
var FACETS = [
  { key: "countries",     label: "Country"      },
  { key: "categories",    label: "Category"     },
  { key: "subcategories", label: "Subcategory"  },
  { key: "brands",        label: "Brand"        }
];

/* Match a product against every filter except `skip` (used for facet counts,
   so each list shows how many results choosing that option would give). */
function matches(p, skip) {
  if (state.inStock && !p.available) return false;
  if (skip !== "xprod" && state.xprod && isXprod(p) !== (state.xprod === "only")) return false;

  if (skip !== "q" && state.q) {
    var hay = (p.title + " " + p.sku + " " + p.brands.join(" ")).toLowerCase();
    var terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < terms.length; i++) {
      if (hay.indexOf(terms[i]) === -1) return false;
    }
  }
  for (var j = 0; j < FACETS.length; j++) {
    var k = FACETS[j].key;
    if (k === skip) continue;
    var sel = state.f[k];
    if (!sel.length) continue;
    var hit = false;
    for (var m = 0; m < sel.length; m++) {
      if (p[k].indexOf(sel[m]) > -1) { hit = true; break; }
    }
    if (!hit) return false;
  }
  return true;
}

function filtered() {
  var out = PRODUCTS.filter(function (p) { return matches(p, null); });
  var s = state.sort;
  out.sort(function (a, b) {
    if (s === "brand") {
      var ab = (a.brands[0] || "zzz"), bb = (b.brands[0] || "zzz");
      if (ab !== bb) return ab.localeCompare(bb);
    }
    return a.title.localeCompare(b.title);
  });
  return out;
}

/* XPROD products (titles "XPROD …", SKUs "X1234") are items the company brings in
   on request rather than its regular range; salespeople ask to hide them or
   to see only them. The SKU catches the few whose title lacks the prefix. */
function isXprod(p) {
  return /^XPROD\b/i.test(p.title || "") || /^X\d/i.test(p.sku || "");
}

/* XPROD products already in the catalogue stay there when hidden; this
   button takes them out in one go. Redrawn whenever the selection changes. */
function renderXprodRemove() {
  var slot = document.getElementById("xrm-slot");
  if (!slot) return;
  slot.innerHTML = "";
  var picked = state.selected.filter(function (id) { return byId[id] && isXprod(byId[id]); });
  if (!picked.length) return;
  var rm = el("button", "xrm", "Remove " + picked.length + " XPROD from selection");
  rm.type = "button";
  rm.onclick = function () {
    state.selected = state.selected.filter(function (id) { return picked.indexOf(id) === -1; });
    renderAll();
    toast(picked.length + " XPROD product" + (picked.length > 1 ? "s" : "") + " removed from the catalog");
  };
  slot.appendChild(rm);
}

/* Count, for one facet, how many products each value would yield. */
function facetCounts(key) {
  var pool = PRODUCTS.filter(function (p) { return matches(p, key); });
  var c = {};
  pool.forEach(function (p) {
    p[key].forEach(function (v) { c[v] = (c[v] || 0) + 1; });
  });
  return c;
}

/* Every value that exists in the catalogue for a facet. Recomputed after an
   import, because price list products can introduce new brands or categories. */
var ALL = {};
function computeFacets() {
  FACETS.forEach(function (f) {
    var seen = {};
    PRODUCTS.forEach(function (p) { p[f.key].forEach(function (v) { seen[v] = 1; }); });
    ALL[f.key] = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
  });
}
computeFacets();

/* ------------------------------------------------------------ render: filters */
function renderFilters() {
  var box = $("#filters");
  box.innerHTML = "";

  // In-stock toggle
  var g0 = el("div", "fgroup");
  var sw = el("label", "sw");
  var cb = el("input"); cb.type = "checkbox"; cb.checked = state.inStock;
  cb.setAttribute("aria-label", "In stock only");
  cb.onchange = function () { state.inStock = cb.checked; renderAll(); };
  sw.appendChild(cb);
  sw.appendChild(document.createTextNode("In stock only"));
  g0.appendChild(sw);
  box.appendChild(g0);

  // XPROD: show all / hide them / only them
  var pool = PRODUCTS.filter(function (p) { return matches(p, "xprod"); });
  var nx = pool.filter(isXprod).length;
  var gx = el("div", "fgroup");
  var hx = el("h3", null, "XPROD");
  if (state.xprod) {
    var cx = el("span", "clr", "clear");
    cx.onclick = function () { state.xprod = ""; renderAll(); };
    hx.appendChild(cx);
  }
  gx.appendChild(hx);
  [["", "Show all", pool.length], ["hide", "Hide XPROD", pool.length - nx], ["only", "Only XPROD", nx]]
    .forEach(function (o) {
      var lab = el("label", "opt");
      var r = el("input"); r.type = "radio"; r.name = "xprod";
      r.checked = state.xprod === o[0];
      r.onchange = function () { state.xprod = o[0]; renderAll(); };
      lab.appendChild(r);
      lab.appendChild(el("span", "lbl", o[1]));
      lab.appendChild(el("span", "n", o[2]));
      gx.appendChild(lab);
    });
  gx.appendChild(el("div", null)).id = "xrm-slot";
  box.appendChild(gx);
  renderXprodRemove();

  FACETS.forEach(function (f) {
    var counts = facetCounts(f.key);
    var values = ALL[f.key];

    // Subcategory list follows the chosen categories when there is one.
    if (f.key === "subcategories" && state.f.categories.length) {
      values = values.filter(function (v) {
        return counts[v] || state.f.subcategories.indexOf(v) > -1;
      });
    }

    var g = el("div", "fgroup");
    var h = el("h3", null, f.label);
    if (state.f[f.key].length) {
      var clr = el("span", "clr", "clear");
      clr.onclick = function () { state.f[f.key] = []; renderAll(); };
      h.appendChild(clr);
    }
    g.appendChild(h);

    // Brand list is long - give it its own search box.
    if (f.key === "brands") {
      var bq = el("input", "txt mini");
      bq.placeholder = "Find a brand…";
      bq.value = state.brandQuery;
      bq.oninput = function () { state.brandQuery = bq.value; renderFilters(); };
      g.appendChild(bq);
      if (state.brandQuery) {
        var q = state.brandQuery.toLowerCase();
        values = values.filter(function (v) { return v.toLowerCase().indexOf(q) > -1; });
      }
      // most relevant first
      values = values.slice().sort(function (a, b) {
        var d = (counts[b] || 0) - (counts[a] || 0);
        return d || a.localeCompare(b);
      });
    }

    var list = el("div", values.length > 9 ? "scroll-list" : "");
    if (!values.length) list.appendChild(el("div", "meta-note", "No matches"));

    values.forEach(function (v) {
      var on = state.f[f.key].indexOf(v) > -1;
      var n  = counts[v] || 0;
      var o = el("label", "opt" + (!n && !on ? " off" : ""));
      o.title = v + " (" + n + ")";
      var i = el("input"); i.type = "checkbox"; i.checked = on;
      i.setAttribute("aria-label", f.label + ": " + v);
      i.onchange = function () {
        var arr = state.f[f.key], k = arr.indexOf(v);
        if (k > -1) arr.splice(k, 1); else arr.push(v);
        if (f.key === "categories") {
          // drop subcategories that no longer apply
          state.f.subcategories = state.f.subcategories.filter(function (s) {
            return PRODUCTS.some(function (p) {
              return p.subcategories.indexOf(s) > -1 &&
                     (!arr.length || arr.some(function (c) { return p.categories.indexOf(c) > -1; }));
            });
          });
        }
        renderAll();
      };
      o.appendChild(i);
      o.appendChild(el("span", "lbl", v));
      o.appendChild(el("span", "n", n));
      list.appendChild(o);
    });
    g.appendChild(list);
    box.appendChild(g);
  });
}

/* --------------------------------------------------------------- render: chips */
function renderChips() {
  var c = $("#chips");
  c.innerHTML = "";
  FACETS.forEach(function (f) {
    state.f[f.key].forEach(function (v) {
      var chip = el("span", "chip", v);
      var x = el("b", null, "×");
      x.onclick = function () {
        state.f[f.key].splice(state.f[f.key].indexOf(v), 1);
        renderAll();
      };
      chip.appendChild(x);
      c.appendChild(chip);
    });
  });
  if (state.xprod) {
    var chip3 = el("span", "chip", state.xprod === "hide" ? "No XPROD" : "Only XPROD");
    var x3 = el("b", null, "×");
    x3.onclick = function () { state.xprod = ""; renderAll(); };
    chip3.appendChild(x3);
    c.appendChild(chip3);
  }
  if (state.q) {
    var chip2 = el("span", "chip", '"' + state.q + '"');
    var x2 = el("b", null, "×");
    x2.onclick = function () { state.q = ""; $("#q").value = ""; renderAll(); };
    chip2.appendChild(x2);
    c.appendChild(chip2);
  }
}

/* ---------------------------------------------------------------- render: grid */
var shown = [];
function renderGrid() {
  shown = filtered();
  var g = $("#grid");
  g.innerHTML = "";
  $("#resultcount").textContent = shown.length + " of " + PRODUCTS.length + " products";

  if (!shown.length) {
    var e = el("div", "empty");
    e.appendChild(el("h2", null, "No products match these filters"));
    e.appendChild(el("div", null, "Try removing a filter or clearing the search."));
    g.parentNode.appendChild(e);
    return;
  }
  var old = document.querySelector(".grid-wrap .empty");
  if (old) old.remove();

  var frag = document.createDocumentFragment();
  shown.forEach(function (p) {
    var on = state.selected.indexOf(p.id) > -1;
    var card = el("div", "pcard" + (on ? " sel" : ""));
    card.setAttribute("data-id", p.id);
    card.setAttribute("role", "checkbox");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-checked", on ? "true" : "false");
    card.setAttribute("aria-label", nice(p.title));
    card.onkeydown = function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(p.id); }
    };

    var th = el("div", "thumb");
    var src = bestImage(p);
    if (src) {
      var im = document.createElement("img");
      im.loading = "lazy";
      im.src = img(src, 300);
      im.alt = "";
      // Shopify URLs go stale between refreshes; show the placeholder rather
      // than the browser's broken-image icon.
      // A failure here is usually the CDN throttling a burst of requests, not
      // a missing file. Give it a couple of retries before showing the
      // placeholder, or a momentary blip strands the card on "No image".
      im.onerror = imageRetry(im, p, 300, th);
      th.appendChild(im);
    } else {
      th.appendChild(el("div", "noimg", "No image"));
    }
    card.appendChild(th);

    var b = el("div", "body");
    b.appendChild(el("div", "t", nice(p.title)));
    var spec = [];
    if (p.units_per_case) spec.push(p.units_per_case + "/case");
    if ((p.units_per_display || 0) > 1) spec.push(p.units_per_display + "/display");
    if (p.sku) spec.push("#" + p.sku);
    if (spec.length) b.appendChild(el("div", "spec", spec.join(" · ")));
    var sub = el("div", "sub");
    sub.appendChild(el("span", null, p.brands[0] || ""));
    b.appendChild(sub);
    card.appendChild(b);

    card.appendChild(el("div", "tick", "✓"));
    if (!p.available) card.appendChild(el("div", "oos", "OUT"));

    card.onclick = function () { toggle(p.id); };
    frag.appendChild(card);
  });
  g.appendChild(frag);
}

function toggle(id) {
  var i = state.selected.indexOf(id);
  if (i > -1) state.selected.splice(i, 1);
  else state.selected.push(id);
  syncSelectionUI();
  save();
}

function syncSelectionUI() {
  var n = state.selected.length;
  $("#pill").textContent = n + " selected";
  $("#tabcount").textContent = n ? "(" + n + ")" : "";
  $("#btn-pdf").disabled = !n;
  $("#btn-preview").disabled = !n;
  document.querySelectorAll(".pcard").forEach(function (c) {
    // Compare as strings: website products have numeric ids but products
    // imported from a price list have ids like "pl:20131", which "+" turns
    // into NaN - they never showed as selected, and clicking one turned it off.
    var cid = c.getAttribute("data-id");
    var on = state.selected.some(function (x) { return String(x) === cid; });
    c.classList.toggle("sel", on);
    c.setAttribute("aria-checked", on ? "true" : "false");
  });
  renderXprodRemove();
  renderSelected();
}

/* ------------------------------------------------------ render: arrange & edit
   The selection, laid out the way the PDF will be: sections in order, products
   in order within them. Drag a product to reorder it or to move it into
   another section; drag onto a heading to put it first in that section. */
var dragId = null;      // product being dragged
var dragSection = null; // section heading being dragged

/* While dragging near the top or bottom of the list, keep scrolling so a
   product can be moved past what fits on screen. */
var autoScroll = { timer: null, dy: 0 };
function autoScrollAt(y) {
  var box = $("#tab-items");
  if (!box) return;
  var r = box.getBoundingClientRect(), edge = 70, step = 14;
  autoScroll.dy = y < r.top + edge ? -step : (y > r.bottom - edge ? step : 0);
  if (autoScroll.dy && !autoScroll.timer) {
    autoScroll.timer = setInterval(function () {
      if (!autoScroll.dy) return stopAutoScroll();
      box.scrollTop += autoScroll.dy;
    }, 16);
  } else if (!autoScroll.dy && autoScroll.timer) stopAutoScroll();
}
function stopAutoScroll() {
  if (autoScroll.timer) clearInterval(autoScroll.timer);
  autoScroll.timer = null; autoScroll.dy = 0;
}

function selectedItems() {
  return state.selected.map(function (id) { return byId[id]; }).filter(Boolean);
}
function currentSectionKeys() {
  return sectionsFor(selectedItems(), true).map(function (s) { return s.key; });
}
/* Freeze the section order as it looks now, so moving one product can never
   reshuffle whole sections behind the salesperson's back. */
function pinSections() {
  if (state.meta.group) state.meta.sectionOrder = currentSectionKeys();
}
function changed() { renderSelected(); save(); }

/* Add products by SKU, for when the catalogue is already arranged and only a
   few more items are needed. Anything that is not a SKU in the text is
   ignored, so a list pasted out of Excel or an email works.
   With a section key the products go into that section; without one they
   land in the section their product type gives them. */
/* Products that exist nowhere yet - not on the website, not in any price
   list. The salesperson types one in and fills in the details by hand; it
   behaves like an imported product from then on, and lives in this browser
   only (state.imported), so nothing is written back to the product data. */
var NEW_WORDS = /\b(new|nueva?|nuevos?|novedad(es)?|x{2,}|tbd)\b/i;

function newProduct(sku, key) {
  var id = "new:" + (sku || Math.random().toString(36).slice(2, 8));
  while (byId[id]) id = "new:" + Math.random().toString(36).slice(2, 8);
  var p = {
    id: id, custom: true, fromPriceList: true,
    title: sku ? "New product " + sku : "New product",
    sku: sku || "", handle: "", url: "", image: "", images: [],
    brands: [], countries: [], categories: [], subcategories: [], types: [],
    tags: [], units_per_case: 0, units_per_display: 0,
    cases_per_pallet: 0, case_weight: "", ean_case: "", available: true
  };
  adoptProduct(p);
  if (p.sku && !bySku[p.sku]) bySku[p.sku] = p;
  state.selected.push(p.id);
  // A heading of its own: these are the items nobody has seen before.
  if (state.meta.group) { pinSections(); setSection(p, key || "New products"); }
  return p;
}

/* One or more blank products, with the editor opened on the first so the
   details can be typed straight away. */
function newProducts(skus, key) {
  var made = (skus && skus.length ? skus : [""]).map(function (sku) {
    return newProduct(sku, key);
  });
  computeFacets();
  renderAll();
  renderSelected();
  openEditor(made[0], true);
  if (made.length > 1) {
    toast(made.length + " new products added \u00b7 fill in each one with Edit");
  }
  return made.length;
}

/* Returns { added, missing } - missing being SKUs that are in no list, which
   the caller offers to create as new products. */
function addSkus(text, key) {
  var raw = String(text || "");
  var tokens = raw.toUpperCase().match(/\b[A-Z]?\d{4,6}\b/g) || [];
  // "NEW", "NUEVO" or "XXX" asks for a product that does not exist yet.
  var wantsNew = NEW_WORDS.test(raw);
  if (!tokens.length && wantsNew) return { added: newProducts([], key), missing: [] };
  var added = 0, already = [], missing = [], seen = {};
  if (key) pinSections();
  tokens.forEach(function (sku) {
    if (seen[sku]) return;
    seen[sku] = 1;
    var p = bySku[sku];
    if (!p) { missing.push(sku); return; }
    if (state.selected.indexOf(p.id) > -1) { already.push(sku); return; }
    state.selected.push(p.id);
    if (key && state.meta.group) setSection(p, key);
    added++;
  });
  if (!tokens.length) {
    toast("Type a SKU, for example 20128 - or NEW for something not in the list yet");
    return { added: 0, missing: [] };
  }
  // "NEW 26468": the SKUs that are in no list are the ones to create. Typed
  // without that word they are only reported, in case of a typo.
  var made = 0;
  if (wantsNew && missing.length) { made = newProducts(missing, key); missing = []; }
  var bits = [];
  if (made) bits.push(made + " new product" + (made > 1 ? "s" : "") + " to fill in");
  if (added) bits.push("Added " + added + " product" + (added > 1 ? "s" : "") +
                       (key ? " to " + sectionLabel(key) : ""));
  if (already.length) bits.push(already.length + " already in the catalog");
  if (missing.length) bits.push("not in the product list: " + missing.join(", "));
  toast(bits.join(" · "));
  if (added) { computeFacets(); renderAll(); }
  return { added: added + made, missing: missing };
}

/* The little "type a SKU" box used at the top of the list and on each
   heading. Stays open after adding, so several can be typed in a row. */
function skuAdder(key, holder, focus) {
  var box = el("div", "skuadd");
  var input = document.createElement("input");
  input.className = "txt mini";
  input.placeholder = key ? "SKU into " + sectionLabel(key) + "…"
                          : "Add by SKU, e.g. 20128, 24063 — or type NEW";
  var go = el("button", "btn sm primary", "Add");
  var mk = el("button", "btn sm", "+ New");
  mk.title = "Add a product that is not on the website or in a price list yet " +
             "and type its details in yourself";

  /* Offered under the box when a typed SKU is in no list at all. */
  var offer = el("div", "skuoffer hidden");
  function askNew(skus) {
    offer.innerHTML = "";
    offer.classList.remove("hidden");
    var one = skus.length === 1;
    offer.appendChild(el("span", null,
      (one ? skus[0] + " is not in the product list."
           : skus.join(", ") + " are not in the product list.") + " New product?"));
    var b = el("button", "btn sm primary", one ? "Add it by hand" : "Add them by hand");
    b.onclick = function () { newProducts(skus, key); };
    offer.appendChild(b);
    var no = el("button", "btn sm ghost", "No thanks");
    no.onclick = function () { offer.classList.add("hidden"); input.focus(); };
    offer.appendChild(no);
  }

  function run() {
    var res = addSkus(input.value, key);
    input.value = "";
    offer.classList.add("hidden");
    if (res.missing.length) askNew(res.missing);
    if (!res.added) input.focus();
  }
  go.onclick = run;
  mk.onclick = function () {
    // Whatever is typed is taken as the new product's SKU.
    var sku = (input.value.toUpperCase().match(/\b[A-Z]?\d{4,6}\b/) || [""])[0];
    input.value = "";
    newProducts([sku], key);
  };
  input.onkeydown = function (e) {
    if (e.key === "Enter") { e.preventDefault(); run(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (holder) holder(); }
  };
  box.appendChild(input); box.appendChild(go); box.appendChild(mk);
  box.appendChild(offer);
  // Only focus when it was just opened on purpose: focusing the box at the
  // top of the list on every rebuild scrolled the list back to the top.
  if (focus) setTimeout(function () { input.focus(); }, 0);
  return box;
}

/* Set to a product id to highlight it after the list is rebuilt - the one
   just moved, so it can be found again at a glance. */
var justMoved = null;
var listScroll = 0;   // where the list was scrolled to, kept across rebuilds

function renderSelected() {
  var box = $("#tab-items");
  // Rebuilding the list would jump back to the top; stay where the
  // salesperson was. The position is tracked as they scroll rather than read
  // here: a second render can arrive while the list is empty, when the box
  // reports 0, and that would throw the position away.
  if (!box.hasAttribute("data-scroll-tracked")) {
    box.setAttribute("data-scroll-tracked", "1");
    box.addEventListener("scroll", function () {
      if (box.firstChild) listScroll = box.scrollTop;
    });
  }
  var keepScroll = listScroll;
  box.innerHTML = "";
  if (!state.selected.length) {
    // The SKU box comes first: a catalogue can be started by typing SKUs,
    // without picking anything in the grid.
    box.appendChild(skuAdder(null, null, true));
    box.appendChild(el("div", "empty", "Nothing selected yet."));
    return;
  }
  box.appendChild(el("div", "meta-note shint", state.meta.group
    ? "Drag products to reorder them or move them to another section. " +
      "Click a heading or a name to rename it, and Edit for pack size, photo and the rest."
    : "Drag products to reorder them. Click a name to rename it, " +
      "and Edit for pack size, photo and the rest."));

  box.appendChild(skuAdder(null));

  var o = savedOffers();
  if (o.products.length || o.sections.length || o.notes.length) {
    var parts = [];
    if (o.products.length) parts.push(o.products.length + " product" + (o.products.length > 1 ? "s" : ""));
    if (o.sections.length) parts.push(o.sections.length + " heading" + (o.sections.length > 1 ? "s" : ""));
    var b = el("div", "sv-banner");
    b.appendChild(el("span", null, "You have saved edits from earlier catalogs for " +
                     parts.join(" and ") + " in this one."));
    var btn = el("button", "btn sm primary", "Review & apply");
    btn.onclick = function () { savedModal(true); };
    b.appendChild(btn);
    box.appendChild(b);
  }
  var secs = sectionsFor(selectedItems(), state.meta.group);
  secs.forEach(function (sec, si) {
    if (sec.key !== null) box.appendChild(sectionHeader(sec, si, secs.length));
    sec.items.forEach(function (p, i) {
      box.appendChild(selRow(p, sec, i));
    });
  });
  // The rows have only just been added: make the browser work out their
  // heights before restoring the position, or the scroll is clamped to 0.
  void box.scrollHeight;
  box.scrollTop = keepScroll;

  var moved = justMoved;
  justMoved = null;
  requestAnimationFrame(function () {
    box.scrollTop = keepScroll;
    if (moved == null) return;
    var row = box.querySelector('.srow[data-id="' + String(moved).replace(/"/g, '\\"') + '"]');
    if (!row) return;
    row.classList.add("moved");
    var r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top + 8 || r.bottom > b.bottom - 8) {
      box.scrollTop += (r.top - b.top) - b.height / 2 + r.height / 2;
      listScroll = box.scrollTop;
    }
    setTimeout(function () { row.classList.remove("moved"); }, 1200);
  });
}

function sectionHeader(sec, si, n) {
  var h = el("div", "ssec");
  var ord = el("div", "ord");
  var up = el("button", null, "▲"); up.title = "Move this section up";
  up.disabled = si === 0;
  up.onclick = function () { moveSection(sec.key, -1); };
  var dn = el("button", null, "▼"); dn.title = "Move this section down";
  dn.disabled = si === n - 1;
  dn.onclick = function () { moveSection(sec.key, 1); };
  ord.appendChild(up); ord.appendChild(dn);
  h.appendChild(ord);

  var renamed = !!state.meta.sections[sec.key];
  var label = el("div", "ssec-name" + (renamed ? " renamed" : ""), sec.name);
  label.title = "Click to rename this heading" +
                (renamed ? " (originally “" + sec.key + "”)" : "");
  label.onclick = function () {
    inlineEdit(label, sec.name, function (v) { renameSection(sec.key, v); });
  };
  h.appendChild(label);
  if (renamed) {
    var undo = el("button", "sreset", "undo");
    undo.title = "Back to “" + sec.key + "”";
    undo.onclick = function () { renameSection(sec.key, ""); };
    h.appendChild(undo);
  }
  var add = el("button", "ssec-add", "+ SKU");
  add.title = "Add a product to this section by SKU";
  h.appendChild(add);
  h.appendChild(el("span", "ssec-n", sec.items.length));

  /* The heading itself can be dragged, to move a whole section. */
  h.draggable = true;
  h.ondragstart = function (e) {
    dragSection = sec.key;
    h.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", sec.key); } catch (err) {}
  };
  h.ondragend = function () {
    dragSection = null; h.classList.remove("dragging"); clearDropMarks(); stopAutoScroll();
  };
  h.ondragover = function (e) {
    if (dragId == null && dragSection == null) return;
    if (dragSection === sec.key) return;
    e.preventDefault();
    autoScrollAt(e.clientY);
    h.classList.add("drop");
  };
  h.ondragleave = function () { h.classList.remove("drop"); };
  h.ondrop = function (e) {
    e.preventDefault();
    h.classList.remove("drop");
    stopAutoScroll();
    if (dragSection != null) return moveSectionBefore(dragSection, sec.key);
    placeProduct(dragId, sec.items[0].id, false, sec.key);
  };

  /* A line printed under the heading, to introduce the section. */
  var wrap = el("div", "ssecwrap");
  wrap.appendChild(h);
  add.onclick = function () {
    var open = wrap.querySelector(".skuadd");
    if (open) { open.remove(); return; }
    wrap.appendChild(skuAdder(sec.key, function () { renderSelected(); }, true));
  };
  var note = sectionNote(sec.key);
  var line = el("div", "ssec-note" + (note ? "" : " empty"),
                note || "+ add a note for this section");
  line.title = "Printed under this heading in the catalog";
  line.onclick = function () {
    inlineEdit(line, note, function (v) { setSectionNote(sec.key, v); }, 2);
  };
  wrap.appendChild(line);
  return wrap;
}

function selRow(p, sec, i) {
  var v = view(p);
  var r = el("div", "srow" + (isEdited(p) ? " edited" : ""));
  r.setAttribute("data-id", String(p.id));
  r.draggable = true;
  var grip = el("div", "grip", "⋮⋮");
  grip.title = "Drag to move";
  r.appendChild(grip);

  var ord = el("div", "ord");
  var up = el("button", null, "▲"); up.title = "Move up";
  up.disabled = i === 0;
  up.onclick = function () { moveWithin(p, -1); };
  var dn = el("button", null, "▼"); dn.title = "Move down";
  dn.disabled = i === sec.items.length - 1;
  dn.onclick = function () { moveWithin(p, 1); };
  ord.appendChild(up); ord.appendChild(dn);
  r.appendChild(ord);

  if (v.image) {
    var im = document.createElement("img");
    im.src = img(v.image, 120); im.loading = "lazy"; im.alt = ""; im.draggable = false;
    // Same fallback as the product grid: if the repository photo cannot be
    // reached, show the storefront one rather than an empty square.
    im.onerror = function () {
      var alt = img(p.image, 120);
      if (p.image && im.src.indexOf(p.image) === -1) { im.onerror = null; im.src = alt; }
      else im.replaceWith(el("div", "srow-noimg"));
    };
    r.appendChild(im);
  } else {
    r.appendChild(el("div", "srow-noimg"));
  }
  r.appendChild(nameEditor(p));

  var edit = el("button", "sedbtn", "Edit");
  edit.title = "Name, SKU, brand, pack size, section and photo";
  edit.onclick = function () { openEditor(p); };
  r.appendChild(edit);

  var x = el("button", "sx", "×");
  x.title = p.custom ? "Delete this product" : "Remove from this catalog";
  x.onclick = function () {
    // A hand-typed product belongs to this catalogue only: removing it is
    // deleting it, otherwise it would linger in the product list for good.
    if (!p.custom) return toggle(p.id);
    dropProduct(p);
    computeFacets();
    renderAll();
    renderSelected();
  };
  r.appendChild(x);

  r.ondragstart = function (e) {
    dragId = p.id;
    r.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(p.id)); } catch (err) {}
  };
  r.ondragend = function () {
    dragId = null;
    r.classList.remove("dragging");
    clearDropMarks();
    stopAutoScroll();
  };
  r.ondragover = function (e) {
    if (dragId == null || dragId === p.id) return;
    e.preventDefault();
    autoScrollAt(e.clientY);
    var box = r.getBoundingClientRect();
    var after = e.clientY > box.top + box.height / 2;
    r.classList.toggle("drop-before", !after);
    r.classList.toggle("drop-after", after);
  };
  r.ondragleave = function () { r.classList.remove("drop-before", "drop-after"); };
  r.ondrop = function (e) {
    e.preventDefault();
    var after = r.classList.contains("drop-after");
    clearDropMarks();
    stopAutoScroll();
    placeProduct(dragId, p.id, after, sec.key);
  };
  return r;
}

function clearDropMarks() {
  document.querySelectorAll(".drop-before,.drop-after,.ssec.drop").forEach(function (n) {
    n.classList.remove("drop-before", "drop-after", "drop");
  });
}

/* Name as it will print, editable in place. Click it to type a new one;
   Enter or clicking away keeps it, Esc cancels, and clearing the box goes
   back to the original. */
function nameEditor(p) {
  var e = ed(p), v = view(p);
  var t = el("div", "st");
  var line = el("div", "sname" + (e.title ? " renamed" : ""), v.name);
  line.title = e.title ? "Originally “" + cleanTitle(p.title) + "” - click to change"
                       : "Click to change how this name appears in the catalog";
  line.onclick = function () {
    inlineEdit(line, v.name, function (val) { setName(p, val); }, 2);
  };
  t.appendChild(line);

  var bits = [];
  if (v.sku) bits.push("#" + v.sku);
  if (v.units_per_case > 1) bits.push(v.units_per_case + "/case");
  if (v.units_per_display > 1) bits.push("display " + v.units_per_display);
  if (v.price) bits.push(v.price);
  var m = el("div", "meta-note", bits.join(" · "));
  // A product typed in by hand is nothing but edits - undoing them all would
  // wipe the name and the pack size, so it is not offered.
  if (isEdited(p) && !p.custom) {
    m.appendChild(document.createTextNode(bits.length ? " · " : ""));
    m.appendChild(el("span", "sflag", "edited"));
    m.appendChild(document.createTextNode(" "));
    var undo = el("button", "sreset", "undo");
    undo.title = "Put back everything you changed on this product";
    undo.onclick = function () { delete state.meta.edits[p.id]; changed(); };
    m.appendChild(undo);
  }
  t.appendChild(m);

  var note = ed(p).note || "";
  var nl = el("div", "srow-note" + (note ? "" : " empty"), note || "+ note");
  nl.title = "Printed under the product in the catalog";
  nl.onclick = function () {
    inlineEdit(nl, note, function (v) {
      var val = String(v || "").replace(/[ \t]+/g, " ").trim();
      setEdit(p, "note", val || undefined);
      changed();
    }, 2);
  };
  t.appendChild(nl);
  return t;
}

/* Swap a label for a text box. Enter or clicking away commits, Esc cancels. */
function inlineEdit(node, value, commit, rows) {
  var box = document.createElement(rows ? "textarea" : "input");
  box.className = "sedit";
  if (rows) box.rows = rows;
  box.value = value;
  // Selecting text inside a draggable row would otherwise drag the row.
  var row = node.closest(".srow");
  if (row) row.draggable = false;
  node.replaceWith(box);
  box.focus(); box.select();
  var done = false;
  function finish(keep) {
    if (done) return;
    done = true;
    if (keep) commit(box.value); else renderSelected();
  }
  box.onkeydown = function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  box.onblur = function () { finish(true); };
}

function setName(p, text) {
  var v = String(text || "").replace(/\s+/g, " ").trim();
  setEdit(p, "title", (!v || v === cleanTitle(p.title)) ? undefined : v);
  changed();
}

function renameSection(key, text) {
  var v = String(text || "").replace(/\s+/g, " ").trim();
  if (!v || v === key) delete state.meta.sections[key];
  else {
    state.meta.sections[key] = v;
    libLoad().sections[key] = v;
    libSave();
  }
  changed();
}

/* Drop one section onto another: it takes that section's place. */
function moveSectionBefore(key, beforeKey) {
  if (key === beforeKey) return;
  var keys = currentSectionKeys();
  var from = keys.indexOf(key);
  if (from < 0) return;
  keys.splice(from, 1);
  var to = keys.indexOf(beforeKey);
  keys.splice(to < 0 ? keys.length : to, 0, key);
  state.meta.sectionOrder = keys;
  changed();
}

function moveSection(key, d) {
  var keys = currentSectionKeys();
  var i = keys.indexOf(key), j = i + d;
  if (i < 0 || j < 0 || j >= keys.length) return;
  keys[i] = keys[j]; keys[j] = key;
  state.meta.sectionOrder = keys;
  changed();
}

/* Up/down within the product's own section: swap with the nearest neighbour
   in that section, leaving every other product where it is. */
function moveWithin(p, d) {
  pinSections();
  var a = state.selected, i = a.indexOf(p.id), j = i;
  var k = state.meta.group ? sectionKey(p) : null;
  do { j += d; } while (j >= 0 && j < a.length &&
                        !(byId[a[j]] && (k === null || sectionKey(byId[a[j]]) === k)));
  if (i < 0 || j < 0 || j >= a.length) return;
  a[i] = a[j]; a[j] = p.id;
  justMoved = p.id;
  changed();
}

/* Drop `movingId` before (or after) `targetId`, joining that product's section. */
function placeProduct(movingId, targetId, after, targetKey) {
  if (movingId == null || movingId === targetId) return;
  var a = state.selected, from = a.indexOf(movingId);
  if (from < 0) return;
  pinSections();
  if (state.meta.group && targetKey != null) setSection(byId[movingId], targetKey);
  a.splice(from, 1);
  var to = a.indexOf(targetId);
  if (to < 0) to = a.length; else if (after) to += 1;
  a.splice(to, 0, movingId);
  justMoved = movingId;
  changed();
}

function setSection(p, key) {
  setEdit(p, "section", key === defaultSection(p) ? undefined : key);
}

/* A typed price, tidied: a bare number becomes euros, anything written out
   ("$18.50", "on request", "26.28 / case") is left exactly as typed. */
function priceText(raw) {
  var v = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (!v) return "";
  if (/[\u20ac$\u00a3]/.test(v)) return v;            // already has a currency
  if (!/\d/.test(v)) return v;                       // "on request"
  if (/^\d+([.,]\d{1,2})?$/.test(v)) return "\u20ac" + v.replace(",", ".");
  return "\u20ac" + v;                                // "26.28 / case"
}

/* ------------------------------------------------------------ product editor */
var editing = null;   // { p, photo } while the edit window is open

function openEditor(p, fresh) {
  var v = view(p);
  // fresh: the product was just typed in and the editor is its first stop,
  // so closing without saving throws it away again.
  editing = { p: p, photo: ed(p).photo, fresh: !!fresh };
  $("#ed-title").textContent = p.custom
    ? "New product · fill in the details"
    : "Edit product · SKU " + (p.sku || "-");
  // A product typed in by hand has no original to fall back on: start the
  // name empty with an example, rather than with the placeholder title.
  $("#ed-name").value = p.custom ? (ed(p).title || "") : v.name;
  $("#ed-name").placeholder = p.custom ? "e.g. Casa Roja 150 ML Habanero Gift Box" : "";
  $("#ed-name-o").textContent = p.custom ? "" : "Original: " + cleanTitle(p.title);
  $("#ed-sku").value = v.sku;
  $("#ed-sku").placeholder = p.sku || "";
  $("#ed-brand").value = v.brand;
  $("#ed-brand").placeholder = p.brands[0] || "";
  $("#ed-note").value = v.note;
  $("#ed-country").value = v.country;
  $("#ed-country").placeholder = p.countries[0] || "";
  $("#ed-case").value = v.units_per_case || "";
  $("#ed-case").placeholder = p.units_per_case || "";
  $("#ed-disp").value = v.units_per_display || "";
  $("#ed-disp").placeholder = p.units_per_display || "";
  $("#ed-price").value = v.price;
  // Nothing to go back to on a product that was typed in by hand.
  $("#ed-reset").classList.toggle("hidden", !!p.custom);
  $("#ed-price-h").textContent = state.meta.prices
    ? "\u2014 printed in this catalog"
    : "\u2014 kept until you tick \u201cShow prices\u201d in Details";

  var sel = $("#ed-section");
  sel.innerHTML = "";
  var keys = currentSectionKeys();
  if (keys.indexOf(defaultSection(p)) < 0) keys.push(defaultSection(p));
  keys.forEach(function (k) {
    var o = el("option", null, sectionLabel(k));
    o.value = k;
    sel.appendChild(o);
  });
  var nw = el("option", null, "New section…");
  nw.value = "__new";
  sel.appendChild(nw);
  sel.value = sectionKey(p);
  $("#ed-newsec").value = "";
  $("#ed-newsec-f").classList.add("hidden");
  $("#ed-section-f").classList.toggle("hidden", !state.meta.group);

  edPhotoRender();
  edModal(true);
  $("#ed-name").focus();
}

function edModal(on) {
  $("#ed-modal").classList.toggle("on", on);
  $("#ed-back").classList.toggle("on", on);
  if (!on) editing = null;
}

/* Cancel on a product that was just typed in: take it away again, rather
   than leaving an empty card in the catalog. */
function cancelEditor() {
  var fresh = editing && editing.fresh ? editing.p : null;
  edModal(false);
  if (!fresh) return;
  dropProduct(fresh);
  computeFacets();
  renderAll();
  renderSelected();
}

function dropProduct(p) {
  delete state.meta.edits[p.id];
  delete byId[p.id];
  if (bySku[p.sku] === p) delete bySku[p.sku];
  state.selected = state.selected.filter(function (id) { return id !== p.id; });
  state.imported = state.imported.filter(function (x) { return x.id !== p.id; });
  var i = PRODUCTS.indexOf(p);
  if (i > -1) PRODUCTS.splice(i, 1);
}

function edPhotoSrc() {
  var r = editing.photo;
  if (r === "none") return "";
  if (r && PHOTO_MEM[r]) return PHOTO_MEM[r];
  return bestImage(editing.p);
}

function edPhotoRender() {
  var src = edPhotoSrc();
  var box = $("#ed-img");
  box.innerHTML = src ? '<img src="' + esc(img(src, 400)) + '" alt="">'
                      : '<span class="meta-note">No photo</span>';
  $("#ed-nophoto").classList.toggle("hidden", !src);
  $("#ed-origphoto").classList.toggle("hidden", !editing.photo);
}

/* Scale an uploaded photo to print size. PNGs stay PNG so a cut-out product
   keeps its transparent background; everything else becomes a JPEG. */
function fitPhoto(uri, type, cb) {
  var im = new Image();
  im.onload = function () {
    try {
      var max = 1200;
      var s = Math.min(1, max / Math.max(im.width, im.height));
      if (s === 1 && uri.length < 1500000) return cb(uri);
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(im.width * s));
      c.height = Math.max(1, Math.round(im.height * s));
      var ctx = c.getContext("2d");
      var png = type === "image/png";
      if (!png) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(im, 0, 0, c.width, c.height);
      var out = png ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.88);
      cb(out.length < uri.length ? out : uri);
    } catch (e) { cb(uri); }
  };
  im.onerror = function () { toast("That image could not be read."); };
  im.src = uri;
}

function takePhoto(file) {
  if (!editing) return;
  if (!file || !/^image\//.test(file.type)) return toast("That isn't an image file.");
  var r = new FileReader();
  r.onload = function () {
    fitPhoto(r.result, file.type, function (uri) {
      if (!editing) return;
      var key = "img:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      PHOTO_MEM[key] = uri;
      editing.photo = key;
      edPhotoRender();
    });
  };
  r.readAsDataURL(file);
}

function saveEditor() {
  if (!editing) return;
  var p = editing.p;
  var name = $("#ed-name").value.replace(/\s+/g, " ").trim();
  if (p.custom && !name) {
    toast("Give the new product a name first");
    $("#ed-name").focus();
    return;
  }
  setEdit(p, "title", (!name || name === cleanTitle(p.title)) ? undefined : name);

  function text(key, input, orig) {
    var val = $(input).value.replace(/\s+/g, " ").trim();
    setEdit(p, key, val === orig ? undefined : val);
  }
  text("sku", "#ed-sku", p.sku || "");
  text("brand", "#ed-brand", p.brands[0] || "");
  text("country", "#ed-country", p.countries[0] || "");
  var note = $("#ed-note").value.replace(/[ \t]+/g, " ").trim();
  setEdit(p, "note", note || undefined);
  setEdit(p, "price", priceText($("#ed-price").value) || undefined);

  function num(key, input, orig) {
    var raw = $(input).value.trim();
    var n = raw === "" ? 0 : Math.max(0, parseInt(raw, 10) || 0);
    setEdit(p, key, n === (orig || 0) ? undefined : n);
  }
  num("units_per_case", "#ed-case", p.units_per_case);
  num("units_per_display", "#ed-disp", p.units_per_display);

  var s = $("#ed-section").value;
  if (s === "__new") s = $("#ed-newsec").value.replace(/\s+/g, " ").trim();
  if (s && s !== sectionKey(p)) { pinSections(); setSection(p, s); }

  var ph = editing.photo;
  setEdit(p, "photo", ph || undefined);
  if (ph && ph.indexOf("img:") === 0) idbPut(ph, PHOTO_MEM[ph]);

  edModal(false);
  changed();
  toast("Saved - only this catalog changes");
}

function renderAll() {
  renderFilters();
  renderChips();
  renderGrid();
  syncSelectionUI();
  save();
}

/* ------------------------------------------------------------------ persistence */
/* Image data is never written down - not to localStorage, not to a saved
   selection. Photos are referenced from where they already live (the Shopify
   CDN, or the marketing photo repository). Thumbnails lifted out of an
   imported spreadsheet are held in memory for the session only; re-importing
   the sheet brings them back. */
function stripImages(list) {
  return list.map(function (p) {
    var c = {};
    Object.keys(p).forEach(function (k) { c[k] = p[k]; });
    if (c.image && c.image.indexOf("data:") === 0) { c.image = ""; c.images = []; }
    delete c.price;   // older imports carried the sheet's price; never keep it
    return c;
  });
}

/* Split a saved catalogue's ids into the ones today's data has and the ones
   it does not. The missing ones are kept, never dropped: a refresh that
   briefly lacks some products (a price list still syncing, say) must not
   eat them out of every catalog that is opened meanwhile. */
function knownIds(ids) {
  var have = [], lack = [];
  remap = {};
  (ids || []).forEach(function (id) {
    var now = resolveId(id);
    if (now == null) { lack.push(id); return; }
    if (now !== id) remap[id] = now;
    if (have.indexOf(now) < 0) have.push(now);
  });
  state.unavailable = lack;
  return have;
}

/* A product's id changes when it moves between the website and the price
   lists, though its SKU does not. Find an id that is gone by its SKU:
   "pl:<SKU>" carries it, and the data remembers the SKU of every older id. */
var SKU_OF = DATA.sku_of || {};
var remap = {};
function resolveId(id) {
  if (byId[id]) return id;
  var s = String(id);
  var sku = s.indexOf("pl:") === 0 ? s.slice(3) : SKU_OF[s];
  var p = sku && bySku[sku];
  return p ? p.id : null;
}
/* Move edits made under an old id onto the product's current id. */
function applyRemap(edits) {
  Object.keys(remap).forEach(function (oldId) {
    var e = edits[oldId], now = String(remap[oldId]);
    if (!e) return;
    if (!edits[now]) edits[now] = e;
    delete edits[oldId];
  });
}
function warnUnavailable() {
  var n = state.unavailable.length;
  if (n) toast(n + " product" + (n > 1 ? "s" : "") + " in this catalog " +
               (n > 1 ? "are" : "is") + " missing from today's product data - " +
               "kept, and back once the data is refreshed");
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      selected: state.selected.concat(state.unavailable), meta: state.meta, f: state.f,
      q: state.q, inStock: state.inStock, xprod: state.xprod,
      imported: stripImages(state.imported)
    }));
  } catch (e) { /* storage full or disabled - not fatal */ }
}

function restore() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    var s = JSON.parse(raw);
    // Re-adopt price list products first, or their ids would be dropped below.
    if (s.imported) s.imported.forEach(function (p) { adoptProduct(p); });
    if (s.selected) state.selected = knownIds(s.selected);
    if (s.meta) Object.keys(s.meta).forEach(function (k) { state.meta[k] = s.meta[k]; });
    normalizeMeta(state.meta);
    applyRemap(state.meta.edits);
    // A draft left open overnight would otherwise go out with yesterday's date.
    if (!state.meta.date || state.meta.date < today()) state.meta.date = today();
    if (s.f) Object.keys(s.f).forEach(function (k) { if (state.f[k]) state.f[k] = s.f[k]; });
    if (s.q) state.q = s.q;
    state.inStock = !!s.inStock;
    if (s.xprod === "hide" || s.xprod === "only") state.xprod = s.xprod;
  } catch (e) { /* ignore corrupt state */ }
}

function download(name, text, mime) {
  var b = new Blob([text], { type: mime || "application/json" });
  var u = URL.createObjectURL(b);
  var a = document.createElement("a");
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
}

/* ============================== PDF / print ============================== */

/* Image pixel width per layout. "high" is ~250 dpi for printing, "standard"
   keeps the PDF small enough to email. */
function imgWidth(layout) {
  var hi = state.meta.quality === "high";
  if (layout === "compact") return hi ? 340 : 220;
  return hi ? 520 : 320;
}

function itemHTML(p, m, layout) {
  var v = view(p);
  var h = '<div class="pitem">';
  // A photo removed on purpose leaves a clean white box, not "No image".
  h += '<div class="pimg">' +
       (v.image ? '<img src="' + esc(img(v.image, imgWidth(layout))) + '" alt="" ' +
                  'onerror="this.remove();this.parentNode.classList.add(\'noimg\')">'
                : (v.noPhoto ? "" : '<span class="ph">No image</span>')) +
       '</div>';
  h += '<div class="pb">';
  h += '<div class="pn">' + esc(v.name) + '</div>';
  if (layout === "detailed" && (v.brand || v.country)) {
    h += '<div class="ptags">' +
         (v.brand ? '<span class="ptag">' + esc(v.brand) + '</span>' : "") +
         (v.country ? '<span class="ptag">' + esc(v.country) + '</span>' : "") +
         '</div>';
  }
  if (v.note) h += '<div class="pnote">' + esc(v.note) + '</div>';
  h += '<div class="pmeta">';
  h += '<span class="psku">' + (m.sku && v.sku ? "SKU " + esc(v.sku) : "") + '</span>';
  h += '<span class="pmr">';
  if (m.pack) {
    var cl = caseLabel(v), dl = displayLabel(v);
    if (cl) h += '<span class="pk">' + esc(cl) + '</span>';
    if (dl) h += '<span class="pk alt">' + esc(dl) + '</span>';
  }
  if (m.prices && v.price) h += '<span class="pk price">' + esc(v.price) + '</span>';
  h += '</span></div></div></div>';
  return h;
}

function rowHTML(p, m) {
  var v = view(p);
  var h = '<tr>';
  h += '<td class="tim">' + (v.image ? '<img src="' + esc(img(v.image, 90)) +
       '" alt="" onerror="this.remove()">' : "") + '</td>';
  h += '<td>' + esc(v.name) +
       (v.note ? '<span class="tnote">' + esc(v.note) + '</span>' : "") + '</td>';
  h += '<td>' + esc(v.brand) + '</td>';
  if (m.sku)    h += '<td class="ts">' + esc(v.sku) + '</td>';
  if (m.pack) {
    h += '<td class="tc">' + (v.units_per_case || "") + '</td>';
    h += '<td class="tc">' + ((v.units_per_display || 0) > 1 ? v.units_per_display : "") + '</td>';
  }
  if (m.prices) h += '<td class="tp">' + esc(v.price) + '</td>';
  return h + '</tr>';
}

/* Split the selection into printable sheets.

   Sections flow rather than each starting a fresh page: a page is filled by
   packing section headings and rows of products against a millimetre budget,
   so a two-product category no longer wastes a whole sheet. */

/* Usable height between the page header and footer, in mm. */
/* Measured against the rendered A4 sheet: 296mm less the brand banner, the
   title line and the page footer leaves about 236mm for content. Row heights include the
   5mm grid gap; list rows are sized by their 9mm thumbnail. */
var CONTENT_MM = 235;

/* Height a section note takes on paper: one line plus a line per ~95 more
   characters, never more than four lines. */
function noteHeightMM(text) {
  var lines = Math.min(4, Math.ceil(String(text).length / 95) || 1);
  return 3 + lines * 4;
}
var METRICS = {
  detailed: { cols: 2, rowMM: 74, headMM: 11, noteMM: 8 },
  compact:  { cols: 3, rowMM: 55, headMM: 11, noteMM: 7 },
  list:     { cols: 1, rowMM: 13, headMM: 11, tableHeadMM: 9, noteMM: 5 }
};

/* Sections are product types (Chilis, Beans, Sauces...). Category alone put
   nearly a food-service catalog under one "Food & Grocery" heading.
   The salesperson can move products between sections, rename headings and
   reorder sections; sections they have not placed follow in the order their
   first product appears. */
function sectionsFor(items, group) {
  if (!group) return [{ key: null, name: null, items: items }];
  var order = [], bucket = {};
  items.forEach(function (p) {
    var k = sectionKey(p);
    if (!bucket[k]) { bucket[k] = []; order.push(k); }
    bucket[k].push(p);
  });
  var placed = state.meta.sectionOrder.filter(function (k) { return bucket[k]; });
  order = placed.concat(order.filter(function (k) { return placed.indexOf(k) < 0; }));
  return order.map(function (k) {
    return { key: k, name: sectionLabel(k), note: sectionNote(k), items: bucket[k] };
  });
}

/* Pack sections into pages. Each page is a list of blocks:
   {type:"head", text} or {type:"items", items:[...]}  */
function paginate(sections, layout) {
  var M = METRICS[layout];
  var pages = [], page = [], used = 0;

  function flush() {
    if (page.length) { pages.push(page); page = []; used = 0; }
  }

  sections.forEach(function (sec) {
    var rows = [];
    for (var i = 0; i < sec.items.length; i += M.cols) {
      rows.push(sec.items.slice(i, i + M.cols));
    }
    var headCost = (sec.name ? M.headMM : 0) + (layout === "list" ? M.tableHeadMM : 0);
    var first = true;
    // A row is taller when one of its products carries a note.
    function rowMM(r) {
      return M.rowMM + (r.some(function (p) { return view(p).note; }) ? M.noteMM : 0);
    }

    while (rows.length) {
      // A heading is only worth placing if at least one row follows it here.
      // The section note is printed once, under the first heading.
      var noteCost = (first && sec.note) ? noteHeightMM(sec.note) : 0;
      if (used + headCost + noteCost + rowMM(rows[0]) > CONTENT_MM) {
        flush();
        noteCost = (first && sec.note) ? noteHeightMM(sec.note) : 0;
      }

      var label = sec.name ? (first ? sec.name : sec.name + " (cont.)") : null;
      if (label || layout === "list") {
        page.push({ type: "head", text: label, note: first ? sec.note : "" });
        used += headCost + noteCost;
      }
      first = false;

      var slice = [];
      while (rows.length && used + rowMM(rows[0]) <= CONTENT_MM) {
        used += rowMM(rows[0]);
        slice.push(rows.shift());
      }
      if (!slice.length) { slice.push(rows.shift()); used = CONTENT_MM; }
      var flat = [];
      slice.forEach(function (r) { flat = flat.concat(r); });
      page.push({ type: "items", items: flat });

      if (rows.length) flush();
    }
  });
  flush();
  return pages;
}

function buildSheets() {
  var m = state.meta;
  var items = state.selected.map(function (id) { return byId[id]; }).filter(Boolean);
  var sections = sectionsFor(items, m.group);
  var pages = paginate(sections, m.layout);
  var html = "";

  /* ---- cover ---- */
  var dateStr = m.date
    ? new Date(m.date + "T00:00:00").toLocaleDateString("en-GB",
        { day: "numeric", month: "long", year: "numeric" })
    : "";
  html += '<div class="sheet cover">' +
            '<div class="chero"' +
              (BRAND.cover ? ' style="background-image:url(' + BRAND.cover + ')"' : "") +
            '></div>' +
            '<div class="cmid">' +
              '<div class="ckick">Demo Foods</div>' +
              '<h1>' + esc(m.title || "Product Catalog") + '</h1>' +
              '<div class="crule"></div>';
  if (m.customer) {
    html += '<div class="cfor">Prepared for</div>' +
            '<div class="cname">' + esc(m.customer) + '</div>';
  }
  if (m.note) html += '<div class="cnote">' + esc(m.note) + '</div>';
  html += '</div><div class="cfoot"><div>' +
            (m.rep ? '<b>' + esc(m.rep) + '</b>' : "") +
            (m.contact ? esc(m.contact) : "") +
          '</div><div style="text-align:right">' +
            (dateStr ? esc(dateStr) + '<br>' : "") +
            items.length + ' products' +
          '</div></div></div>';

  /* ---- product sheets ---- */
  pages.forEach(function (blocks, i) {
    html += '<div class="sheet page">';
    html += '<div class="pbanner"' +
            (BRAND.banner ? ' style="background-image:url(' + BRAND.banner + ')"' : "") +
            '></div>';
    html += '<div class="pinner">';
    html += '<div class="phead"><b>' + esc(m.title || "Product Catalog") + '</b>' +
            (m.customer ? '<span class="pcust">' + esc(m.customer) + '</span>' : "") +
            '</div>';
    html += '<div class="pflow">';

    blocks.forEach(function (b) {
      if (b.type === "head") {
        if (b.text) html += '<div class="psection">' + esc(b.text) + '</div>';
        if (b.note) html += '<div class="psecnote">' + esc(b.note) + '</div>';
      } else if (m.layout === "list") {
        html += '<table class="ptable"><thead><tr><th></th><th>Product</th><th>Brand</th>' +
                (m.sku ? '<th>SKU</th>' : "") +
                (m.pack ? '<th class="tc">Per case</th><th class="tc">Per display</th>' : "") +
                (m.prices ? '<th class="tp">Price</th>' : "") +
                '</tr></thead><tbody>';
        b.items.forEach(function (p) { html += rowHTML(p, m); });
        html += '</tbody></table>';
      } else {
        html += '<div class="pgrid ' + m.layout + '">';
        b.items.forEach(function (p) { html += itemHTML(p, m, m.layout); });
        html += '</div>';
      }
    });

    html += '</div>';
    html += '<div class="pfoot"><span>Demo Foods Ltd &middot; demofoods.example</span>' +
            '<span>Page ' + (i + 1) + ' of ' + pages.length + '</span></div>';
    html += '</div></div>';
  });

  return html;
}

function renderPrint() {
  $("#print-root").innerHTML = buildSheets();
}

/* Wait for images so the PDF is never printed half-empty. */
function waitImages(root, cb) {
  var imgs = Array.prototype.slice.call(root.querySelectorAll("img"));
  var left = imgs.length;
  if (!left) return cb();
  var done = false;
  function tick() {
    if (--left <= 0 && !done) { done = true; cb(); }
  }
  imgs.forEach(function (i) {
    if (i.complete) return tick();
    i.addEventListener("load", tick);
    i.addEventListener("error", tick);
  });
  // Never hang on a slow CDN.
  setTimeout(function () { if (!done) { done = true; cb(); } }, 12000);
}

/* Uploaded photos come out of IndexedDB asynchronously; have them in memory
   before the sheets are drawn. */
function doPreview() {
  readMeta();
  loadPhotos(showPreview);
}
function showPreview() {
  historyRecord();
  renderPrint();
  document.body.classList.add("previewing");
  if (!$("#printbar")) {
    var bar = el("div"); bar.id = "printbar";
    bar.innerHTML = '<b>Catalog preview</b><span class="tip">Check the pages, then print. ' +
                    'In the print dialog choose <b>Save as PDF</b>, ' +
                    'set margins to <b>None</b> and tick <b>Background graphics</b>.</span>' +
                    '<span class="spacer"></span>';
    var back = el("button", "btn sm", "Back to editing");
    back.onclick = closePreview;
    var pr = el("button", "btn sm primary", "Print / Save as PDF");
    pr.onclick = function () { window.print(); };
    bar.appendChild(back); bar.appendChild(pr);
    document.body.appendChild(bar);
  }
  $("#printbar").classList.remove("hidden");
  window.scrollTo(0, 0);
}
function closePreview() {
  document.body.classList.remove("previewing");
  var b = $("#printbar");
  if (b) b.classList.add("hidden");
}

function doPDF() {
  readMeta();
  loadPhotos(printPDF);
}
function printPDF() {
  historyRecord();
  renderPrint();
  toast("Preparing images…");
  waitImages($("#print-root"), function () {
    window.print();
  });
}

/* Reopen a catalogue saved earlier with "Save selection". */
function openSaved(file) {
  var r = new FileReader();
  r.onload = function () {
    try {
      var d = JSON.parse(r.result);
      (d.imported || []).forEach(function (p) { adoptProduct(p); });
      computeFacets();
      state.selected = knownIds(d.selected);
      listScroll = 0;
      freshEdits(state.meta);
      if (d.meta) Object.keys(d.meta).forEach(function (k) { state.meta[k] = d.meta[k]; });
      normalizeMeta(state.meta);
      applyRemap(state.meta.edits);
      writeMeta();
      renderAll();
      loadPhotos(renderSelected);
      if (state.unavailable.length) warnUnavailable();
      else toast("Loaded " + state.selected.length + " products");
    } catch (e) {
      toast("That file could not be read as a saved catalog.");
    }
  };
  r.readAsText(file);
}

/* ------------------------------------------------------------------- meta I/O */
var METAMAP = {
  customer: "#m-customer", title: "#m-title", rep: "#m-rep", date: "#m-date",
  contact: "#m-contact", note: "#m-note", layout: "#m-layout", quality: "#m-quality"
};
var METABOOL = { pack: "#m-pack", sku: "#m-sku", group: "#m-group",
                 prices: "#m-prices" };

function readMeta() {
  Object.keys(METAMAP).forEach(function (k) { state.meta[k] = $(METAMAP[k]).value; });
  Object.keys(METABOOL).forEach(function (k) { state.meta[k] = $(METABOOL[k]).checked; });
  save();
}
function writeMeta() {
  Object.keys(METAMAP).forEach(function (k) { $(METAMAP[k]).value = state.meta[k] || ""; });
  Object.keys(METABOOL).forEach(function (k) { $(METABOOL[k]).checked = !!state.meta[k]; });
}

/* ===================== recent catalogues =====================

   A catalog is remembered whenever one is generated, so a repeat customer
   can be answered without hunting for the saved file: who it was for, when,
   what was in it, and one click to open it again.

   Only the selection is kept - product ids, the cover details, and any
   imported rows with their images stripped. No image data, and the list is
   capped so it cannot grow without limit. */

var HIST_KEY = "st-catalog-history-v1";
var HIST_MAX = 150;

function historyLoad() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; }
  catch (e) { return []; }
}

function historySave(list) {
  // Browser storage is finite: rather than lose the save, drop the oldest
  // catalogues until it fits.
  var keep = list.slice(0, HIST_MAX);
  while (keep.length) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(keep)); return true; }
    catch (e) { keep = keep.slice(0, Math.floor(keep.length / 2)); }
  }
  return false;
}

/* Called when a catalogue is actually produced. Re-generating the same
   catalog - same customer AND same title - on the same day updates that
   entry rather than adding another. Matching on the customer alone let two
   different catalogs with no customer name overwrite each other. */
function historyRecord() {
  if (!state.selected.length) return;
  var list = historyLoad();
  var day = today();
  var customer = (state.meta.customer || "").trim();
  var entry = {
    at: new Date().toISOString(),
    customer: customer,
    title: state.meta.title || "Product Catalog",
    count: state.selected.length + state.unavailable.length,
    layout: state.meta.layout,
    meta: state.meta,
    selected: state.selected.concat(state.unavailable),
    imported: stripImages(state.imported)
  };
  var same = list.findIndex(function (e) {
    return (e.customer || "") === customer && (e.title || "") === entry.title &&
           e.at && dayOf(new Date(e.at)) === day;
  });
  if (same > -1) list.splice(same, 1);
  list.unshift(entry);
  historySave(list);
}

function historyOpen(entry) {
  (entry.imported || []).forEach(function (p) { adoptProduct(p); });
  computeFacets();
  state.selected = knownIds(entry.selected);
  listScroll = 0;
  freshEdits(state.meta);
  if (entry.meta) Object.keys(entry.meta).forEach(function (k) {
    state.meta[k] = entry.meta[k];
  });
  normalizeMeta(state.meta);
  applyRemap(state.meta.edits);
  writeMeta();
  renderAll();
  loadPhotos(renderSelected);
  histModal(false);
  if (state.unavailable.length) warnUnavailable();
  else toast("Opened " + state.selected.length + " products");
  openDrawer(true);
}

/* A catalogue history lives in one browser. These two make it portable:
   between the local tool and the website, between computers, and as a
   backup before anything is cleared. */
function historyExport() {
  var list = historyLoad();
  if (!list.length) return toast("No catalogs to save yet");
  download("st-catalogues-" + today() + ".json",
           JSON.stringify({ kind: "st-catalogue-history", at: new Date().toISOString(),
                            catalogues: list }, null, 1));
  toast("Saved " + list.length + " catalog" + (list.length > 1 ? "s" : "") + " to a file");
}

function historyImport(file) {
  var r = new FileReader();
  r.onload = function () {
    var d;
    try { d = JSON.parse(r.result); } catch (e) { return toast("That file could not be read."); }
    var incoming = d && (d.catalogues || (Array.isArray(d) ? d : null));
    if (!incoming || !incoming.length) return toast("No catalogs in that file.");
    var list = historyLoad(), seen = {}, merged = [];
    list.concat(incoming).forEach(function (e) {
      if (!e || !e.at || seen[e.at]) return;
      seen[e.at] = 1; merged.push(e);
    });
    merged.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    historySave(merged);
    historyRender();
    toast("Added " + (merged.length - list.length) + " catalog(s) from the file");
  };
  r.readAsText(file);
}

function histModal(on) {
  $("#hist-modal").classList.toggle("on", on);
  $("#hist-back").classList.toggle("on", on);
  if (on) historyRender();
}

function historyRender() {
  var list = historyLoad();
  var box = $("#hist-body");
  if (!list.length) {
    box.innerHTML = '<div class="meta-note" style="padding:18px 0;text-align:center">' +
      'Nothing here yet. Catalogs are remembered automatically when you ' +
      'generate one, so you can reopen them for a repeat customer.</div>';
    return;
  }
  box.innerHTML = "";
  list.forEach(function (e, i) {
    var when = new Date(e.at);
    var row = el("div", "hist-row");
    var main = el("div", "hist-main");
    main.appendChild(el("div", "hist-cust", e.customer || e.title || "Untitled catalog"));
    main.appendChild(el("div", "hist-sub",
      when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) +
      " \u00b7 " + e.count + " products" +
      (e.customer && e.title ? " \u00b7 " + e.title : "")));
    row.appendChild(main);

    var open = el("button", "btn sm", "Open");
    open.onclick = function () { historyOpen(e); };
    row.appendChild(open);

    var del = el("button", "hist-del", "\u00d7");
    del.title = "Remove from the list";
    del.onclick = function () {
      var l = historyLoad(); l.splice(i, 1); historySave(l); historyRender();
    };
    row.appendChild(del);
    box.appendChild(row);
  });
}

/* ======================= price list import ======================= */

var pendingImport = null;

function impModal(on) {
  $("#imp-modal").classList.toggle("on", on);
  $("#imp-back").classList.toggle("on", on);
}

function stat(n, label, sub, cls) {
  return '<div class="imp-stat ' + (cls || "") + '">' +
         '<b>' + n + '</b><span class="lbl">' + esc(label) +
         (sub ? '<div class="sub">' + esc(sub) + '</div>' : "") +
         '</span></div>';
}

function showImport(res) {
  pendingImport = res;
  var total = res.matched.length + res.extra.length;
  $("#imp-title").textContent = "Import price list";

  var h = '';
  h += '<div style="font-size:13px;margin-bottom:12px">' +
       '<b>' + esc(res.fileName) + '</b>' +
       '<div class="meta-note">Sheet “' + esc(res.sheet) + '” · ' +
       res.totalRows + ' product rows</div></div>';

  h += stat(total, "products for this catalog", null, "imp-ok");
  h += stat(res.matched.length, "matched to the website",
            "full photo, pack size and category");
  if (res.extra.length) {
    // bestImage() looks in the photo repository before the spreadsheet, so
    // count those too - otherwise rows with a perfectly good photo read as bare.
    var fromRepo = 0, fromSheet = 0;
    res.extra.forEach(function (e) {
      if (photoFor(e.product.sku)) fromRepo++;
      else if (e.product.image) fromSheet++;
    });
    var bare = res.extra.length - fromRepo - fromSheet;
    var how = [];
    if (fromRepo) how.push(fromRepo + " with a photo from the marketing folder");
    if (fromSheet) how.push(fromSheet + " with a photo from the spreadsheet");
    if (bare) how.push(bare + " without a photo");
    h += stat(res.extra.length, "only in the price list", how.join(", "),
              bare ? "imp-warn" : null);
  }

  h += '<div class="imp-note">';
  if (res.markedBy === "quantity") {
    h += 'Picked up the rows with a quantity in <b>Place your order</b>. ' +
         'Clear that column and re-import if you would rather use every row in the sheet.';
  } else {
    h += 'No quantities were filled in, so <b>every row in the sheet</b> is included. ' +
         'To send a subset instead, either delete the rows you do not want or ' +
         'put a quantity against the ones you do.';
  }
  h += '</div>';
  if (res.withUnits) {
    h += '<div class="imp-note">Took the case size for <b>' + res.withUnits + '</b> ' +
         (res.withUnits > 1 ? 'products' : 'product') + ' from the sheet’s units-per-case column, ' +
         'where the website has none or a different one. It stays with this catalog; ' +
         'change it in <b>Edit</b> if needed.</div>';
  }
  if (res.withPrice) {
    h += '<div class="imp-note">Found a price on <b>' + res.withPrice + '</b> ' +
         (res.withPrice > 1 ? 'rows' : 'row') +
         (res.priceColumn ? ', from the column <b>' + esc(res.priceColumn) + '</b>' : "") +
         ', so <b>Show prices</b> will be switched on for this catalog. ' +
         'Untick it in <b>Details</b> to leave prices out; rows without a price ' +
         'simply print without one, and any price can be changed in <b>Edit</b>.</div>';
  }

  if (res.extra.length) {
    var list = res.extra.slice(0, 60).map(function (e) {
      return '<div><span class="s">' + esc(e.product.sku) + '</span>' +
             '<span>' + esc(nice(e.product.title).slice(0, 62)) + '</span></div>';
    }).join("");
    h += '<div style="margin-top:14px;font-size:12.5px"><b>Not on the website</b> ' +
         '<span class="meta-note">— built from the spreadsheet</span></div>' +
         '<div class="imp-list">' + list +
         (res.extra.length > 60 ? '<div class="meta-note" style="padding:6px 10px">' +
           '+ ' + (res.extra.length - 60) + ' more</div>' : "") + '</div>';
  }

  $("#imp-body").innerHTML = h;
  $("#imp-ok").disabled = !total;
  impModal(true);
}

function applyImport() {
  var res = pendingImport;
  if (!res) return;
  var ids = [], priced = 0;
  res.matched.forEach(function (m) {
    // The price list carries English copy the Shopify feed usually lacks.
    if (m.english && !m.product.description) m.product.description = m.english;
    // A price in the sheet becomes a per-catalogue price, so it stays with
    // this catalogue and never gets written into the product data.
    if (m.price) { setEdit(m.product, "price", m.price); priced++; }
    // Likewise the sheet's case size, where it adds to or differs from the
    // website's (which many products don't have).
    if (m.units && m.units !== m.product.units_per_case) {
      setEdit(m.product, "units_per_case", m.units);
      (state.meta.sheetUnits = state.meta.sheetUnits || {})[m.product.id] = m.units;
    }
    ids.push(m.product.id);
  });
  res.extra.forEach(function (e) {
    var id = adoptProduct(e.product);
    ids.push(id);
    if (e.product.price && byId[id]) { setEdit(byId[id], "price", e.product.price); priced++; }
  });
  // The sheet had prices, so show them - one tick in Details hides them again.
  if (priced) state.meta.prices = true;
  computeFacets();

  state.selected = ids;
  // The import defines the catalogue, so clear filters that would hide it.
  state.f = { countries: [], categories: [], subcategories: [], brands: [] };
  state.xprod = "";
  state.q = "";
  $("#q").value = "";
  if (!state.meta.title || state.meta.title === "Product Catalog" || state.meta.title === "Product Catalogue") {
    state.meta.title = "Product Catalog";
  }
  writeMeta();
  renderAll();
  impModal(false);
  pendingImport = null;
  toast(ids.length + " products imported" +
        (priced ? " · prices on " + priced + ", shown in the PDF" : ""));
  openDrawer(true);
}

function importFile(file) {
  // One button for everything: a saved catalogue is JSON, anything else is
  // treated as a price list.
  if (/\.json$/i.test(file.name)) return openSaved(file);
  if (/\.xls$/i.test(file.name)) {
    $("#imp-title").textContent = "Could not read that file";
    $("#imp-body").innerHTML = '<div class="imp-err">This is an old-format ' +
      '<b>.xls</b> file, which cannot be read directly.</div>' +
      '<div class="meta-note" style="margin-top:10px">Open it in Excel and use ' +
      '<b>File › Save As</b> to save it as <b>.xlsx</b>, then import that.</div>';
    $("#imp-ok").disabled = true;
    impModal(true);
    return;
  }
  toast("Reading " + file.name + "…");
  window.PriceListImport.analyse(file, bySku).then(showImport).catch(function (err) {
    $("#imp-title").textContent = "Could not read that file";
    $("#imp-body").innerHTML = '<div class="imp-err">' + esc(err.message || String(err)) +
      '</div><div class="meta-note" style="margin-top:10px">' +
      'Expected a wholesale price list (.xlsx) or a CSV export of one, ' +
      'with a header row containing <b>SKU</b>.</div>';
    $("#imp-ok").disabled = true;
    impModal(true);
  });
}

/* The catalogue is a snapshot. Say how old it is, and say so loudly once it is
   old enough that products may have come or gone. */
function showDataAge() {
  var el = $("#datastamp");
  if (!DATA.generated_at) { el.textContent = ""; return; }
  var days = Math.floor((Date.now() - new Date(DATA.generated_at)) / 86400000);
  var age = days <= 0 ? "today" : days === 1 ? "yesterday" : days + " days old";
  el.textContent = "Data: " + age + " \u00b7 " + PRODUCTS.length + " products";
  el.classList.toggle("stale", days >= 7);
  el.title = days >= 7
    ? "Last refreshed " + DATA.generated_at.slice(0, 10) + ". Products may have "
      + "been added or removed since. Run: python3 refresh_data.py"
    : "Last refreshed " + DATA.generated_at.slice(0, 10);
}

/* ------------------------------------------------------------------- wiring */
function openDrawer(on) {
  $("#drawer").classList.toggle("open", on);
  $("#backdrop").classList.toggle("on", on);
}

function init() {
  if (LOGO) $("#hdr-logo").src = LOGO;
  if (!PRODUCTS.length) {
    document.querySelector(".grid-wrap").innerHTML =
      '<div class="empty"><h2>No catalog data found</h2>' +
      '<div>Run <code>python3 refresh_data.py</code> in this folder, then reload.</div></div>';
  }
  showDataAge();

  restore();
  writeMeta();
  $("#q").value = state.q;
  $("#sort").value = state.sort;

  var qt;
  $("#q").oninput = function () {
    clearTimeout(qt);
    var v = this.value;
    qt = setTimeout(function () { state.q = v; renderChips(); renderGrid(); save(); }, 160);
  };
  $("#sort").onchange = function () { state.sort = this.value; renderGrid(); };

  $("#btn-selall").onclick = function () {
    shown.forEach(function (p) {
      if (state.selected.indexOf(p.id) === -1) state.selected.push(p.id);
    });
    syncSelectionUI(); save();
    toast(state.selected.length + " products selected");
  };
  $("#btn-clear").onclick = function () {
    if (!state.selected.length) return;
    if (!confirm("Clear all " + state.selected.length + " selected products?")) return;
    historyRecord();   // keep it in Recent catalogues rather than lose it
    state.selected = [];
    state.unavailable = [];
    state.imported = [];
    freshEdits(state.meta);   // the edits were for that customer's catalogue
    // Drop only what was imported here. Price list products that came with
    // catalog.js are part of the range; removing them made a later import
    // match their SKUs to products that no longer existed, and they vanished
    // from the catalogue without a word.
    PRODUCTS = PRODUCTS.filter(function (p) { return BUILT_IN[p.id]; });
    Object.keys(byId).forEach(function (k) {
      if (!BUILT_IN[k]) delete byId[k];
    });
    computeFacets();
    renderAll();
  };

  $("#btn-open-drawer").onclick = function () { openDrawer(true); };
  $("#btn-close-drawer").onclick = function () { readMeta(); openDrawer(false); };
  $("#backdrop").onclick = function () { readMeta(); openDrawer(false); };

  document.querySelectorAll(".tab").forEach(function (t) {
    t.onclick = function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("on"); });
      t.classList.add("on");
      var which = t.getAttribute("data-tab");
      $("#tab-details").classList.toggle("hidden", which !== "details");
      $("#tab-items").classList.toggle("hidden", which !== "items");
    };
  });

  $("#btn-preview").onclick = doPreview;

  $("#sv-ok").onclick = applySaved;
  $("#sv-cancel").onclick = function () { savedModal(false); };
  $("#sv-back").onclick = function () { savedModal(false); };

  $("#ed-cancel").onclick = cancelEditor;
  $("#ed-back").onclick = cancelEditor;
  $("#ed-save").onclick = saveEditor;
  $("#ed-reset").onclick = function () {
    if (!editing) return;
    delete state.meta.edits[editing.p.id];
    edModal(false);
    changed();
    toast("Back to the original product");
  };
  $("#ed-section").onchange = function () {
    var nw = this.value === "__new";
    $("#ed-newsec-f").classList.toggle("hidden", !nw);
    if (nw) $("#ed-newsec").focus();
  };
  $("#ed-upload").onclick = function () { $("#ed-file").click(); };
  $("#ed-file").onchange = function () { takePhoto(this.files[0]); this.value = ""; };
  $("#ed-nophoto").onclick = function () { editing.photo = "none"; edPhotoRender(); };
  $("#ed-origphoto").onclick = function () { editing.photo = undefined; edPhotoRender(); };
  var drop = $("#ed-img");
  drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = function () { drop.classList.remove("over"); };
  drop.ondrop = function (e) {
    e.preventDefault();
    drop.classList.remove("over");
    takePhoto(e.dataTransfer.files[0]);
  };
  // Paste a screenshot or a copied image straight in.
  document.addEventListener("paste", function (e) {
    if (!editing || !e.clipboardData) return;
    var f = Array.prototype.slice.call(e.clipboardData.files || [])
      .filter(function (x) { return /^image\//.test(x.type); })[0];
    if (f) { e.preventDefault(); takePhoto(f); }
  });
  // Enter saves from any field; Shift+Enter still breaks a line in the name.
  $("#ed-modal").addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.shiftKey || e.target.tagName === "SELECT" ||
        e.target.tagName === "BUTTON") return;
    e.preventDefault();
    saveEditor();
  });
  $("#btn-pdf").onclick = doPDF;


  $("#btn-history").onclick = function () { histModal(true); };
  $("#hist-export").onclick = historyExport;
  $("#hist-import").onclick = function () { $("#hist-file").click(); };
  $("#hist-file").onchange = function () {
    if (this.files[0]) historyImport(this.files[0]);
    this.value = "";
  };
  $("#hist-close").onclick = function () { histModal(false); };
  $("#hist-back").onclick = function () { histModal(false); };

  $("#btn-import").onclick = function () { $("#plinput").click(); };
  $("#plinput").onchange = function () {
    var f = this.files[0];
    if (f) importFile(f);
    this.value = "";
  };
  $("#imp-cancel").onclick = function () { impModal(false); pendingImport = null; };
  $("#imp-back").onclick = function () { impModal(false); pendingImport = null; };
  $("#imp-ok").onclick = applyImport;

  $("#btn-csv").onclick = function () {
    // Export the selection if there is one, otherwise whatever is on screen.
    // Doing nothing but flashing a toast made this look broken.
    var list = state.selected.length
      ? state.selected.map(function (id) { return byId[id]; }).filter(Boolean)
      : shown;
    if (!list.length) return toast("Nothing to export");
    var rows = [["SKU", "Product", "Name in catalog", "Note", "Price", "Brand", "Country", "Category",
                 "Units per case", "Units per display", "Cases per pallet",
                 "Case weight", "EAN case", "In stock", "URL"]];
    list.forEach(function (p) {
      // What the customer sees: the catalogue's own edits, where there are any.
      var v = view(p);
      rows.push([v.sku, p.title, v.name, v.note, v.price, v.brand, v.country,
                 p.categories.join(" / "), v.units_per_case || "",
                 v.units_per_display || "", p.cases_per_pallet || "",
                 p.case_weight || "", p.ean_case || "",
                 p.available ? "yes" : "no", p.url]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\r\n");
    var name = (state.meta.customer || "catalog").replace(/[^\w\- ]+/g, "").trim() || "catalog";
    download(name + " - products.csv", "﻿" + csv, "text/csv");
    toast("Exported " + list.length + " products" +
          (state.selected.length ? "" : " (everything currently shown)"));
  };

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if ($("#sv-modal").classList.contains("on")) savedModal(false);
      else if ($("#ed-modal").classList.contains("on")) cancelEditor();
      else if ($("#hist-modal").classList.contains("on")) histModal(false);
      else if ($("#imp-modal").classList.contains("on")) { impModal(false); pendingImport = null; }
      else if (document.body.classList.contains("previewing")) closePreview();
      else openDrawer(false);
    }
  });

  renderAll();
  warnUnavailable();
  loadPhotos(function () { renderSelected(); prunePhotos(); });

  /* Shown once to whoever opens this for the first time, and whenever they
     ask for it again with "How it works". The print-dialog settings are the
     one thing that silently ruins a PDF. */
  $("#firstrun-ok").onclick = function () {
    $("#firstrun").classList.remove("on");
    try { localStorage.setItem("st-seen-intro", "1"); } catch (e) {}
  };
  $("#btn-help").onclick = function () {
    $("#firstrun").classList.toggle("on");
  };
  try {
    if (!localStorage.getItem("st-seen-intro")) $("#firstrun").classList.add("on");
  } catch (e) { /* storage disabled - just skip the hint */ }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else { init(); }

})();
