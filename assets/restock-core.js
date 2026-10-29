/* Restock requests, shared by restock.html (the list) and index.html (the
   badge, banner and pop-ups).

   Each salesperson's requests live in their own browser (localStorage), one
   list per signed-in account on the hosted site. Stock comes live from Odoo
   through /api/sku-stock. A request counts as "back in stock" once there is
   free stock for it; the site then flags it until the salesperson marks it
   "Told client" or "Done". */
window.SalesRestock = (function () {
  var BASE_KEY = "st-restock-requests";
  var key = BASE_KEY;
  var LOCAL = location.port === "5055";
  var ready = null;

  // On the website, keep a separate list per signed-in account (people may share
  // a computer); on a Mac running the app there is just the one.
  function init() {
    if (ready) return ready;
    ready = LOCAL ? Promise.resolve() : fetch("/.auth/me")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var email = d && d.clientPrincipal && d.clientPrincipal.userDetails;
        if (email) key = BASE_KEY + ":" + email.toLowerCase();
      })
      .catch(function () {});
    return ready;
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; }
  }

  function save(list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function add(fields) {
    var list = load();
    var req = {
      id: newId(),
      sku: String(fields.sku || "").trim(),
      name: fields.name || "",
      customer: (fields.customer || "").trim(),
      qty: Number(fields.qty) > 0 ? Number(fields.qty) : null,
      notes: (fields.notes || "").trim(),
      status: "waiting",
      created: new Date().toISOString(),
      stock: null,
      availableSince: null,
      alerted: false
    };
    list.unshift(req);
    save(list);
    return req;
  }

  function update(id, changes) {
    var list = load();
    list.forEach(function (r) { if (r.id === id) Object.assign(r, changes); });
    save(list);
  }

  function remove(id) {
    save(load().filter(function (r) { return r.id !== id; }));
  }

  function isOpen(r) { return r.status === "waiting"; }

  // Stock is counted in base units; requests are in the case/display the
  // product is sold in.
  function inPacks(stock, q) {
    return stock && stock.pack ? q / stock.pack.per : q;
  }

  function packLabel(stock) {
    return stock ? (stock.pack ? stock.pack.label : (stock.base_uom || "Units")) : "";
  }

  function fmtNum(n) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function fmtDay(iso) {
    var p = iso.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  /* What the stock means for this request:
     in      -- enough free stock for the quantity asked (or any, if no qty)
     partial -- some free stock, less than asked
     coming  -- none free, but a delivery is due
     none    -- none free, nothing ordered
     unknown -- not checked yet, or the SKU isn't in Odoo */
  function availability(r) {
    var s = r.stock;
    if (!s) return { kind: "unknown", text: r.checkedAt ? "SKU not found in Odoo" : "Not checked yet" };
    var free = inPacks(s, s.free_qty);
    var unit = packLabel(s);
    if (free > 0 && (!r.qty || free >= r.qty)) {
      return { kind: "in", text: "In stock · " + fmtNum(free) + " " + unit + " free" };
    }
    if (free > 0) {
      return { kind: "partial", text: "Only " + fmtNum(free) + " " + unit + " free" +
        (s.next_eta ? " · more due " + fmtDay(s.next_eta) : "") };
    }
    if (s.next_eta) {
      return { kind: "coming", text: "Arriving " + fmtDay(s.next_eta) + " · " +
        fmtNum(inPacks(s, s.incoming)) + " " + unit };
    }
    return { kind: "none", text: "Out of stock · nothing on order yet" };
  }

  function isAvailable(r) {
    var k = availability(r).kind;
    return k === "in" || k === "partial";
  }

  // Waiting requests that now have stock -- what the badge counts.
  function alerts(list) {
    return (list || load()).filter(function (r) { return isOpen(r) && isAvailable(r); });
  }

  /* Ask Odoo about every waiting request's SKU, store the answers, and
     return the requests that have just come back into stock (for pop-ups). */
  function refresh() {
    var skus = {};
    load().forEach(function (r) { if (isOpen(r) && r.sku) skus[r.sku] = true; });
    var wanted = Object.keys(skus);
    if (!wanted.length) return Promise.resolve({ list: load(), arrived: [] });
    return fetch("/api/sku-stock?skus=" + wanted.map(encodeURIComponent).join(","))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        var found = data.results || {};
        var now = new Date().toISOString();
        var arrived = [];
        // Re-read: the other page may have changed the list meanwhile.
        var list = load();
        list.forEach(function (r) {
          if (!isOpen(r) || !skus[r.sku]) return;
          r.stock = found[r.sku] || null;
          r.checkedAt = now;
          if (r.stock && !r.name) r.name = r.stock.name;
          if (isAvailable(r)) {
            if (!r.availableSince) { r.availableSince = now; r.alerted = false; }
            if (!r.alerted) arrived.push(r);
          } else {
            r.availableSince = null;
            r.alerted = false;
          }
        });
        save(list);
        try { localStorage.setItem(key + ":checked", now); } catch (e) {}
        return { list: list, arrived: arrived };
      });
  }

  function lastChecked() {
    try { return localStorage.getItem(key + ":checked"); } catch (e) { return null; }
  }

  /* Browser pop-up for requests that just came in (once per arrival). */
  function popUp(arrived) {
    if (!arrived.length) return;
    var list = load();
    var ids = {};
    arrived.forEach(function (r) { ids[r.id] = true; });
    list.forEach(function (r) { if (ids[r.id]) r.alerted = true; });
    save(list);
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    var names = arrived.map(function (r) { return (r.name || r.sku) + (r.customer ? " (" + r.customer + ")" : ""); });
    var n = new Notification(arrived.length === 1 ? "Back in stock" : arrived.length + " requests back in stock", {
      body: names.slice(0, 4).join("\n") + (names.length > 4 ? "\n…" : ""),
      tag: "st-restock"
    });
    n.onclick = function () { window.focus(); location.hash = "#restock"; n.close(); };
  }

  return {
    init: init, load: load, add: add, update: update, remove: remove,
    refresh: refresh, lastChecked: lastChecked, alerts: alerts, popUp: popUp,
    availability: availability, inPacks: inPacks, packLabel: packLabel, isOpen: isOpen
  };
})();
