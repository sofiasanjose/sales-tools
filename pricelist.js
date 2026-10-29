/* Catalog Builder - price list import.

   Reads a wholesale price list (.xlsx) or a CSV export of one, and
   turns it into a catalogue selection, so a salesperson can mark up the
   spreadsheet they already work in instead of clicking products one by one.

   An .xlsx is a ZIP of XML. Both are parsed here with browser built-ins
   (DecompressionStream + DOMParser) so the tool stays dependency-free and
   keeps working from a file:// double-click. */

(function () {
"use strict";

/* ----------------------------------------------------------------- unzip */

function u16(d, o) { return d[o] | (d[o + 1] << 8); }
function u32(d, o) { return (d[o] | (d[o+1]<<8) | (d[o+2]<<16) | (d[o+3]<<24)) >>> 0; }

async function inflateRaw(bytes) {
  var ds = new DecompressionStream("deflate-raw");
  var stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* Returns a Map of entry name -> Uint8Array. */
async function unzip(buf) {
  var d = new Uint8Array(buf);
  // End of central directory: scan back for the signature.
  var eocd = -1;
  for (var i = d.length - 22; i >= 0 && i > d.length - 66000; i--) {
    if (u32(d, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file (no zip directory).");

  var count = u16(d, eocd + 10);
  var dirOff = u32(d, eocd + 16);
  var out = new Map();
  var p = dirOff;

  for (var n = 0; n < count; n++) {
    if (u32(d, p) !== 0x02014b50) break;
    var method  = u16(d, p + 10);
    var compSz  = u32(d, p + 20);
    var nameLen = u16(d, p + 28);
    var extraLen= u16(d, p + 30);
    var cmtLen  = u16(d, p + 32);
    var localOff= u32(d, p + 42);
    var name    = new TextDecoder().decode(d.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;

    // Local header tells us the real offset of the data.
    if (u32(d, localOff) !== 0x04034b50) continue;
    var lNameLen  = u16(d, localOff + 26);
    var lExtraLen = u16(d, localOff + 28);
    var start = localOff + 30 + lNameLen + lExtraLen;
    var raw = d.subarray(start, start + compSz);
    out.set(name, method === 0 ? raw : await inflateRaw(raw));
  }
  return out;
}

function textOf(bytes) {
  return bytes ? new TextDecoder("utf-8").decode(bytes) : "";
}
function xml(bytes) {
  return new DOMParser().parseFromString(textOf(bytes), "application/xml");
}

/* --------------------------------------------------------------- xlsx read */

function colIndex(ref) {
  var m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return 0;
  var n = 0, s = m[1];
  for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}

async function readXlsx(buf) {
  var z = await unzip(buf);

  // shared strings
  var shared = [];
  if (z.has("xl/sharedStrings.xml")) {
    var sdoc = xml(z.get("xl/sharedStrings.xml"));
    var sis = sdoc.getElementsByTagName("si");
    for (var i = 0; i < sis.length; i++) {
      var ts = sis[i].getElementsByTagName("t"), s = "";
      for (var j = 0; j < ts.length; j++) s += ts[j].textContent || "";
      shared.push(s);
    }
  }

  // first worksheet (price lists are a single sheet)
  var wbRels = xml(z.get("xl/_rels/workbook.xml.rels"));
  var relMap = {};
  var rels = wbRels.getElementsByTagName("Relationship");
  for (var r = 0; r < rels.length; r++) {
    relMap[rels[r].getAttribute("Id")] = rels[r].getAttribute("Target");
  }
  var wb = xml(z.get("xl/workbook.xml"));
  var sheetEls = wb.getElementsByTagName("sheet");
  var sheetName = sheetEls.length ? sheetEls[0].getAttribute("name") : "Sheet1";
  var target = relMap[sheetEls[0].getAttribute("r:id")] ||
               relMap[sheetEls[0].getAttributeNS(
                 "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")] ||
               "worksheets/sheet1.xml";
  var path = "xl/" + String(target).replace(/^\/?xl\//, "").replace(/^\//, "");
  if (!z.has(path)) path = "xl/worksheets/sheet1.xml";

  var sh = xml(z.get(path));
  var rowEls = sh.getElementsByTagName("row");
  var rows = [], vmByRow = {};

  for (var ri = 0; ri < rowEls.length; ri++) {
    var rowEl = rowEls[ri];
    var rowNum = parseInt(rowEl.getAttribute("r"), 10) || (ri + 1);
    var cells = rowEl.getElementsByTagName("c");
    var vals = [], max = -1;
    for (var ci = 0; ci < cells.length; ci++) {
      var c = cells[ci], idx = colIndex(c.getAttribute("r")), t = c.getAttribute("t");
      var vm = c.getAttribute("vm");
      if (vm) vmByRow[rowNum] = parseInt(vm, 10);
      var txt = "";
      if (t === "inlineStr") {
        var isEl = c.getElementsByTagName("t");
        for (var k = 0; k < isEl.length; k++) txt += isEl[k].textContent || "";
      } else {
        var v = c.getElementsByTagName("v")[0];
        if (v) {
          txt = v.textContent || "";
          if (t === "s") txt = shared[parseInt(txt, 10)] || "";
        }
      }
      vals[idx] = txt;
      if (idx > max) max = idx;
    }
    for (var f = 0; f <= max; f++) if (vals[f] === undefined) vals[f] = "";
    rows[rowNum - 1] = vals;
  }
  for (var g = 0; g < rows.length; g++) if (!rows[g]) rows[g] = [];

  return { sheet: sheetName, rows: rows, images: await readCellImages(z, vmByRow) };
}

/* Excel "image in cell" values: cell vm=N -> rich value N-1 -> relationship
   -> xl/media/<file>. Gives us a (small) photo for products that are in the
   price list but not on the website. */
async function readCellImages(z, vmByRow) {
  var out = {};
  if (!z.has("xl/richData/rdrichvalue.xml") || !z.has("xl/richData/richValueRel.xml")) {
    return out;
  }
  try {
    var rvDoc = xml(z.get("xl/richData/rdrichvalue.xml"));
    var rvs = rvDoc.getElementsByTagName("rv");
    var relIdx = [];
    for (var i = 0; i < rvs.length; i++) {
      var v = rvs[i].getElementsByTagName("v")[0];
      relIdx.push(v ? parseInt(v.textContent, 10) : -1);
    }
    var rrDoc = xml(z.get("xl/richData/richValueRel.xml"));
    var rels = rrDoc.getElementsByTagName("rel");
    var relIds = [];
    for (var j = 0; j < rels.length; j++) {
      relIds.push(rels[j].getAttribute("r:id") ||
        rels[j].getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"));
    }
    var rmap = {};
    var rdoc = xml(z.get("xl/richData/_rels/richValueRel.xml.rels"));
    var rl = rdoc.getElementsByTagName("Relationship");
    for (var m = 0; m < rl.length; m++) rmap[rl[m].getAttribute("Id")] = rl[m].getAttribute("Target");

    var cache = {}, wanted = {};
    Object.keys(vmByRow).forEach(function (rowNum) {
      var n = vmByRow[rowNum];
      var k = relIdx[n - 1];
      if (k == null || k < 0) return;
      var tgt = rmap[relIds[k]];
      if (!tgt) return;
      var mediaPath = "xl/" + tgt.replace(/^\.\.\//, "");
      if (!z.has(mediaPath)) return;
      if (!cache[mediaPath]) {
        var bytes = z.get(mediaPath);
        var bin = "";
        for (var b = 0; b < bytes.length; b++) bin += String.fromCharCode(bytes[b]);
        var ext = /\.jpe?g$/i.test(mediaPath) ? "jpeg" : "png";
        cache[mediaPath] = "data:image/" + ext + ";base64," + btoa(bin);
      }
      out[rowNum] = cache[mediaPath];
      wanted[mediaPath] = true;
    });
  } catch (e) { /* images are a bonus - never fail the import over them */ }
  return shrinkAll(out);
}

/* Re-encode data URIs as modest JPEGs. Keeps the catalogue inside the browser's
   storage quota and keeps the exported PDF small. */
function shrink(dataUri) {
  return new Promise(function (resolve) {
    var im = new Image();
    im.onload = function () {
      try {
        var max = 260;
        var scale = Math.min(1, max / Math.max(im.width || max, im.height || max));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round((im.width || max) * scale));
        c.height = Math.max(1, Math.round((im.height || max) * scale));
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(im, 0, 0, c.width, c.height);
        var out = c.toDataURL("image/jpeg", 0.72);
        resolve(out.length < dataUri.length ? out : dataUri);
      } catch (e) { resolve(dataUri); }
    };
    im.onerror = function () { resolve(dataUri); };
    im.src = dataUri;
  });
}

async function shrinkAll(map) {
  var seen = {}, keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var uri = map[keys[i]];
    if (!seen[uri]) seen[uri] = await shrink(uri);
    map[keys[i]] = seen[uri];
  }
  return map;
}

/* ---------------------------------------------------------------- csv read */

function readCsv(text) {
  var rows = [], row = [], cur = "", q = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === "," || ch === ";") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return { sheet: "CSV", rows: rows, images: {} };
}

/* ------------------------------------------------------- column detection */

/* Header aliases, lower-cased and stripped of punctuation/whitespace. */
var COLS = {
  sku:        ["sku", "artikelnr", "articlenumber", "art", "artno", "itemnumber"],
  // Includes the Spanish headers the company's own sheets use - "Referencia" holds
  // the product name in the Prodesco price tracking file, for example.
  product:    ["product", "productname", "description", "artikel",
               "producto", "nombre", "descripcion", "descripcin",
               "referencia", "articulo", "artculo"],
  english:    ["englishdescription", "englishdesc"],
  brand:      ["brand", "marca"],
  category:   ["category", "categoria"],
  subcategory:["subcategory", "subcategoria"],
  size:       ["size", "format", "content"],
  origin:     ["originofgoods", "origin", "country", "countryoforigin"],
  units:      ["unitscase", "unitspercase", "unitscasepcs", "pcscase"],
  order:      ["placeyourorder", "order", "orderqty", "quantity", "qty", "cases"],
  // Prices are read from the sheet only when the salesperson asks to show
  // them; they never go near the product data (see HOSTING.md / README).
  price:      ["pricecase", "pricepercase", "price", "precio", "preciocaja",
               "preciounidad", "wholesaleprice", "retailprice", "pvp"],
  weight:     ["caseweightkgs", "caseweight", "weightkgs"]
};

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

/* The price list uses its own category words ("BEVERAGES", "SAUCES & DIPS")
   while the website uses another set ("Drinks", "Sauces"). Left unmapped they
   would sit side by side in the filters as near-duplicates, so imported rows
   are translated into the website's vocabulary. */
var PL_CATEGORY = {
  "saucesdips": "Food & Grocery", "condiments": "Food & Grocery",
  "chilis": "Food & Grocery", "tortillascornproducts": "Food & Grocery",
  "vegetables": "Food & Grocery", "beans": "Food & Grocery",
  "flour": "Food & Grocery", "readytoserve": "Food & Grocery",
  "mole": "Food & Grocery", "hojatamal": "Food & Grocery",
  "candy": "Sweets", "sweetsdesserts": "Sweets",
  "beverages": "Drinks",
  "snacks": "Snacks",
  "nonfood": "Non-Food"
};
var PL_SUBCATEGORY = {
  "sauces": "Sauces",
  "candy": "Candy",
  "chillicannedandpowder": "Chilis",
  "driedchili": "Chilis",
  "seasonings": "Seasonings & Spices",
  "tortillas": "Tortillas",
  "vegetables": "Vegetables & Canned",
  "beans": "Beans",
  "flour": "Flour",
  "heatserve": "Ready to Eat",
  "softdrinks": "Soda",
  "mole": "Moles",
  "pastriesandcookies": "Biscuits"
  // Deliberately unmapped, because the website has no equivalent and inventing
  // one would tag imported products differently from the same products online:
  // SALTY SNACK, OTHER FOOD, BEERS, OTHER BEVERAGES, DRINK MIXERS,
  // SPORTS AND ENERGY DRINKS, YERBA MATE, CORN HUSKS, NON-FOOD.
};

function findHeader(rows) {
  for (var i = 0; i < Math.min(rows.length, 25); i++) {
    var r = rows[i] || [];
    for (var j = 0; j < r.length; j++) {
      if (norm(r[j]) === "sku") return i;
    }
  }
  return -1;
}

/* When no heading says "SKU", find the column by its contents: the one
   whose values are most often known SKUs. The row above the data is
   taken as the header row, so the other columns still map by name. */
function findSkuColumn(rows, bySku) {
  var limit = Math.min(rows.length, 25);
  for (var h = 0; h < limit; h++) {
    var header = rows[h] || [];
    if (!header.some(function (c) { return /[a-z]/i.test(String(c == null ? "" : c)); })) continue;
    var width = 0, best = null;
    for (var i = h + 1; i < rows.length; i++) width = Math.max(width, (rows[i] || []).length);
    for (var j = 0; j < width; j++) {
      var hits = 0, filled = 0;
      for (var k = h + 1; k < rows.length; k++) {
        var v = String(((rows[k] || [])[j]) == null ? "" : rows[k][j]).trim();
        if (!v) continue;
        filled++;
        if (bySku[v]) hits++;
      }
      if (hits >= 3 && hits >= filled * 0.3 && (!best || hits > best.hits)) {
        best = { header: h, col: j, hits: hits };
      }
    }
    if (best) return best;
  }
  return null;
}

function mapColumns(header, rows, hi) {
  var map = {};
  for (var j = 0; j < header.length; j++) {
    var h = norm(header[j]);
    if (!h) continue;
    Object.keys(COLS).forEach(function (key) {
      if (map[key] !== undefined) return;
      if (COLS[key].indexOf(h) > -1) map[key] = j;
    });
  }
  if (map.price === undefined) {
    var guess = guessPrice(header, rows || [], hi || 0);
    if (guess !== null) map.price = guess;
  }
  return map;
}

/* Price headings are written a hundred ways - "NEW PRICE PER CASE", "Precio
   caja", "Nuevo Precio Coste 13 de Marzo 26" - and a comparison sheet carries
   several of them side by side. Any heading with a word for price in it is a
   candidate. What the customer should see is the new price, not last year's
   and never a difference; between equals, the column that is actually filled
   in wins, and then the rightmost, which is usually the newest. */
function guessPrice(header, rows, hi) {
  var best = null, bestScore = -99, bestFilled = -1;
  for (var j = 0; j < header.length; j++) {
    var h = norm(header[j]);
    if (!h || !/(price|precio|prijs|preis|prezzo|pvp|tarif|coste|kosten)/.test(h)) continue;
    // A difference, a percentage or a margin is not a price to print.
    if (/(diff|percent|change|margen|margin|variac|vs|index)/.test(h)) continue;
    var score = 0;
    if (/(new|nuevo|nueva|propuesto|propose)/.test(h)) score += 3;
    if (/(old|previous|actual|current|anterior|odoo|notupdated|last|antigu)/.test(h)) score -= 3;
    if (/(case|caja|doos|box)/.test(h)) score += 1;
    var filled = 0;
    for (var k = hi + 1; k < rows.length; k++) {
      var v = String(((rows[k] || [])[j]) == null ? "" : rows[k][j]).trim();
      if (v && /\d/.test(v)) filled++;
    }
    if (score > bestScore || (score === bestScore && filled >= bestFilled)) {
      bestScore = score; bestFilled = filled; best = j;
    }
  }
  return best;
}

/* -------------------------------------------------------------- the import */

function cell(row, map, key) {
  var i = map[key];
  return (i === undefined || !row) ? "" : String(row[i] == null ? "" : row[i]).trim();
}
/* A price as it should read in the catalogue. Numbers from a spreadsheet
   come back as plain numbers and are written as euros; text that already
   carries a currency, or says something else ("on request"), is kept as the
   salesperson wrote it. */
function money(v) {
  var raw = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  if (!raw) return "";
  var n = parseFloat(raw.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  if (!isFinite(n) || /[a-zA-Z]/.test(raw)) {
    // Text such as "on request", or "18 / case" - left as written, with a
    // euro sign in front of it when it is money without one.
    if (!/\d/.test(raw) || /[€$£]/.test(raw)) return raw;
    return "€" + raw;
  }
  return "€" + n.toFixed(2);
}

function intOf(v) {
  var n = parseInt(String(v).replace(/[^\d.-]/g, ""), 10);
  return isFinite(n) && n > 0 ? n : null;
}

/* ---------------------------------------------- classification by name

   refresh_data.py ships its name rules and title codes inside catalog.js,
   so an imported row is classified exactly as a catalogue product would be. */

var nameRules = null;

function rulesFromCatalog() {
  if (nameRules) return nameRules;
  var c = window.CATALOG_DATA || {};
  nameRules = (c.title_rules || []).map(function (r) {
    try { return [new RegExp(r[0]), r[1]]; } catch (e) { return null; }
  }).filter(Boolean);
  return nameRules;
}

function codeOf(upper) {
  var codes = (window.CATALOG_DATA || {}).title_prefix || {};
  return codes[upper.split(/\s+/)[0]] || null;
}

function subFromName(upper) {
  var rules = rulesFromCatalog();
  for (var i = 0; i < rules.length; i++) {
    if (rules[i][0].test(upper)) return rules[i][1];
  }
  var code = codeOf(upper);
  return code && code[1] ? code[1] : "";
}

/* Category from the title code, else the category that product type most
   often sits under in the catalogue ("Tortillas" -> "Food & Grocery"). */
var catBySub = null;
function catFor(upper, sub) {
  var code = codeOf(upper);
  if (code && code[0]) return code[0];
  if (!sub) return "";
  if (!catBySub) {
    var tally = {};
    ((window.CATALOG_DATA || {}).products || []).forEach(function (p) {
      var s = p.subcategories && p.subcategories[0], c = p.categories && p.categories[0];
      if (!s || !c) return;
      tally[s] = tally[s] || {};
      tally[s][c] = (tally[s][c] || 0) + 1;
    });
    catBySub = {};
    Object.keys(tally).forEach(function (s) {
      catBySub[s] = Object.keys(tally[s]).sort(function (a, b) {
        return tally[s][b] - tally[s][a];
      })[0];
    });
  }
  return catBySub[sub] || "";
}

/* Turn a price-list row into a product record the rest of the app understands,
   for SKUs that are not on the website. */
function productFromRow(row, map, image, nice) {
  var sku = cell(row, map, "sku");
  // A column that turned out to hold codes rather than names ("Referencia" is
  // sometimes used that way) must not become the product title.
  var name = cell(row, map, "product");
  if (/^[\d\s.\-\/]*$/.test(name)) name = "";
  // Some lists prefix the name with its own SKU: "[20072] FRIJO ...".
  var title = (name || cell(row, map, "english") ||
               ("Article " + sku)).replace(/^\s*\[\s*\d+\s*\]\s*/, "");
  var size = cell(row, map, "size");
  var origin = cell(row, map, "origin");
  var country = /mexic/i.test(origin) ? "Mexican"
              : /united states|america|usa/i.test(origin) ? "American"
              : /china|japan|korea|thai|viet|indonesi|philipp|asia/i.test(origin) ? "Asian"
              : "";
  var titleCase = function (s) {
    return s.replace(/\S+/g, function (w) {
      return w.length <= 2 ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  };
  var rawCat = cell(row, map, "category");
  var rawSub = cell(row, map, "subcategory");
  var cat = PL_CATEGORY[norm(rawCat)] || (rawCat ? titleCase(rawCat) : "");
  var sub = PL_SUBCATEGORY[norm(rawSub)] || "";
  // Sheets without category columns - the company's own tracking files - would
  // otherwise leave these rows under "Other products". Classify them by name
  // with the same rules the catalogue itself uses.
  var upper = title.toUpperCase();
  if (!sub) sub = subFromName(upper);
  if (!cat) cat = catFor(upper, sub);
  return {
    id: "pl:" + sku,
    fromPriceList: true,
    title: title + (size && title.indexOf(size) === -1 ? " " + size : ""),
    handle: "", url: "",
    sku: sku,
    available: true,
    grams: 0,
    image: image || "",
    images: image ? [image] : [],
    description: cell(row, map, "english"),
    vendor: "Demo Foods",
    type: "",
    tags: [],
    countries: country ? [country] : [],
    // cat/sub are already in the website's vocabulary - title-casing them
    // again would turn "Non-Food" into "Non-food" and "Ready to Eat" into
    // "Ready TO Eat", splitting the filter lists.
    categories: cat ? [cat] : [],
    subcategories: sub ? [sub] : [],
    brands: cell(row, map, "brand") ? [titleCase(cell(row, map, "brand"))] : [],
    price: money(cell(row, map, "price")),
    units_per_case: intOf(cell(row, map, "units")),
    units_per_display: null,
    cases_per_pallet: null,
    ean_unit: "", ean_case: "",
    case_weight: cell(row, map, "weight")
  };
}

/* Parse a file and work out what the salesperson meant.
   Returns { rows, matched, extra, missing, markedBy }. */
async function analyse(file, bySku) {
  var parsed;
  if (/\.csv$/i.test(file.name)) {
    parsed = readCsv(await file.text());
  } else {
    parsed = await readXlsx(await file.arrayBuffer());
  }

  var hi = findHeader(parsed.rows), map;
  if (hi > -1) {
    map = mapColumns(parsed.rows[hi], parsed.rows, hi);
  } else {
    // No heading says "SKU" - relabelled, typed over, or missing. Find the
    // column by what is in it instead of refusing a perfectly usable sheet.
    var guess = findSkuColumn(parsed.rows, bySku);
    if (!guess) throw new Error(
      "Could not find a SKU column. Expected a header row containing “SKU”, " +
      "or a column of article numbers.");
    hi = guess.header;
    map = mapColumns(parsed.rows[hi], parsed.rows, hi);
    map.sku = guess.col;
  }
  if (map.sku === undefined) throw new Error("No SKU column found.");

  var body = [];
  for (var i = hi + 1; i < parsed.rows.length; i++) {
    var r = parsed.rows[i];
    if (!r || !r.length) continue;
    var sku = cell(r, map, "sku");
    if (!sku || !/\d/.test(sku)) continue;
    body.push({ row: r, excelRow: i + 1, sku: sku });
  }

  // If any quantities are filled in, the salesperson marked a subset that way.
  // Otherwise they pruned the sheet, so every remaining row counts.
  var marked = map.order === undefined ? [] :
    body.filter(function (b) { return intOf(cell(b.row, map, "order")); });
  var chosen = marked.length ? marked : body;

  var matched = [], extra = [];
  chosen.forEach(function (b) {
    var p = bySku[b.sku];
    if (p) {
      matched.push({ product: p, qty: intOf(cell(b.row, map, "order")),
                     english: cell(b.row, map, "english"),
                     price: money(cell(b.row, map, "price")),
                     // The sheet's case size: the website only knows it for
                     // some products, and the salesperson's sheet is the
                     // better source for this customer anyway.
                     units: intOf(cell(b.row, map, "units")) });
    } else {
      extra.push({ product: productFromRow(b.row, map, parsed.images[b.excelRow]),
                   qty: intOf(cell(b.row, map, "order")) });
    }
  });

  return {
    sheet: parsed.sheet,
    fileName: file.name,
    totalRows: body.length,
    markedBy: marked.length ? "quantity" : "rows",
    matched: matched,
    extra: extra,
    withPhoto: extra.filter(function (e) { return e.product.image; }).length,
    withUnits: matched.filter(function (m) { return m.units && m.units !== m.product.units_per_case; }).length,
    withPrice: matched.filter(function (m) { return m.price; }).length +
               extra.filter(function (e) { return e.product.price; }).length,
    // Named in the summary: a sheet can hold several price columns, and the
    // salesperson should see which one the catalogue is about to quote.
    priceColumn: map.price === undefined ? ""
                 : String(parsed.rows[hi][map.price] || "").trim(),
    columns: map
  };
}

window.PriceListImport = { analyse: analyse, readXlsx: readXlsx };

})();
