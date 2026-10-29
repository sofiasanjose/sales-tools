/* Demo mode: answers the pages' API calls from the static test data in
   demo-data/ (built by tools/build_demo_data.py), so the whole site runs on
   GitHub Pages with no server and no ERP behind it.

   In the real tool these calls go to a Python API that reads live data from
   Odoo (stock, orders, price lists). Loaded before any other script. */
(function () {
  var realFetch = window.fetch.bind(window);
  var cache = {};

  function json(data, status) {
    return Promise.resolve(new Response(JSON.stringify(data), {
      status: status || 200, headers: { "Content-Type": "application/json" }
    }));
  }
  function file(path) {
    if (!cache[path]) {
      cache[path] = realFetch(path).then(function (r) {
        if (!r.ok) throw new Error("Not in the demo data");
        return r.json();
      });
    }
    return cache[path];
  }
  function serve(path, fix) {
    return file(path).then(function (d) {
      d = JSON.parse(JSON.stringify(d));
      if (d.fetched_at) d.fetched_at = new Date().toISOString();
      return json(fix ? fix(d) : d);
    }).catch(function (e) { return json({ error: e.message }, 404); });
  }
  // A short wait, so loading states show the way they do against the live ERP.
  function later(p) { return new Promise(function (ok) { setTimeout(function () { ok(p); }, 350); }); }

  window.fetch = function (input, init) {
    var raw = typeof input === "string" ? input : input.url;
    var url = new URL(raw, location.href);
    var path = url.pathname.replace(/^.*?\/(api\/|\.auth\/|data\/catalog\.json)/, "/$1");
    var q = url.searchParams;
    var low = (q.get("q") || "").trim().toLowerCase();

    if (path === "/.auth/me") {
      return json({ clientPrincipal: { userDetails: "demo.user@example.com", claims: [{ typ: "name", val: "Demo User" }] } });
    }
    if (path === "/data/catalog.json") return serve("demo-data/catalog.json");
    if (path.indexOf("/api/") !== 0) return realFetch(input, init);

    switch (path) {
      case "/api/pricelists":
        return later(serve("demo-data/pricelists.json"));
      case "/api/customers":
        return serve("demo-data/customers.json", function (d) {
          return { results: low.length < 2 ? [] : d.results.filter(function (c) { return c.name.toLowerCase().indexOf(low) > -1; }).slice(0, 10) };
        });
      case "/api/report/pricelist-stock":
        return later(serve("demo-data/stock/" + q.get("id") + (q.get("client") ? "-" + q.get("client") : "") + ".json"));
      case "/api/export/pricelist-stock":
        return json({ error: "Excel export is switched off in this demo. In the real tool it downloads the list shown, with prices in €." }, 400);
      case "/api/customer-profile":
        return later(serve("demo-data/profile/" + q.get("id") +
          (q.get("location") ? "-" + q.get("location").replace(/[^A-Za-z0-9]+/g, "_") : "") + ".json"));
      case "/api/reco/pricelist":
        return later(serve("demo-data/reco/pl-" + q.get("pricelist") + ".json"));
      case "/api/reco/customer":
        return later(serve("demo-data/reco/c-" + q.get("id") + ".json"));
      case "/api/products":
        return serve("demo-data/products.json", function (d) {
          return { results: low.length < 2 ? [] : d.results.filter(function (p) {
            return p.sku.indexOf(low) > -1 || p.name.toLowerCase().indexOf(low) > -1;
          }).slice(0, 12).map(function (p) { return { sku: p.sku, name: p.name }; }) };
        });
      case "/api/sku-stock":
        var want = (q.get("skus") || "").split(",");
        return serve("demo-data/products.json", function (d) {
          var out = {};
          d.results.forEach(function (p) { if (want.indexOf(p.sku) > -1) out[p.sku] = p; });
          return { results: out };
        });
    }
    return json({ error: "Not available in the demo" }, 404);
  };
})();
