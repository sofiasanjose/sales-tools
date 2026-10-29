"""
Builds the demo's test data: a made-up food distributor with ~90 products,
6 price lists, 36 customer shops and two years of orders, then works out
every answer the pages ask the API for and writes them to demo-data/ as
static JSON (so the demo runs on GitHub Pages, with no server).

The numbers are computed with the same rules as the real tool:
  - Stock check: free to use = on hand - reserved, incoming deliveries with
    their dates, and when the price list's clients (or one client) last bought.
  - Customer profile: this year against the same days last year, how often
    they order, products "due" (ordered at least twice and it's been 30% longer
    than their usual gap) or "stopped", open orders, and what the 25 customers
    with the most similar basket (Jaccard) buy that this one doesn't.
  - Recommendations: "bought together" (share of a product's buyers who also
    buy another, kept only when lift > 1) and "similar" (names sharing the most
    telling words, weighted by IDF), never suggesting what a customer already
    has, another size of it, or a sample.

Everything is invented: shops, people, products, prices and orders.

    python3 tools/build_demo_data.py          # rebuild demo-data/ for today
"""
import datetime as dt
import json
import math
import random
import re
import shutil
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "demo-data"
rng = random.Random(7)
TODAY = dt.date.today()
YEAR = TODAY.year
START = dt.date(YEAR - 1, 1, 1)

# ---------------------------------------------------------------------------
# Products: "[SKU] CODE BRAND SIZE VARIANT", like the real ERP's names.
# ---------------------------------------------------------------------------
LINES = [
    # code, category, brand, size, unit, base price per case, variants
    ("SALPIC", "Sauces", "CASA ROJA", "150 ML", "CS/12", 18, ["HABANERO", "CHIPOTLE", "VERDE", "ORIGINAL", "MANGO HABANERO"]),
    ("SALPIC", "Sauces", "EL FUEGO", "370 ML", "CS/24", 31, ["CLASICA", "EXTRA PICANTE", "LIMON"]),
    ("SALSA", "Sauces", "DONA LUPE", "240 GR", "CS/12", 26, ["SALSA VERDE GLASS", "SALSA ROJA GLASS", "GUACAMOLE CREMOSA"]),
    ("CHILE", "Chilis", "RANCHO VERDE", "2.8 KG", "CS/6", 44, ["JALAPENO NACHOS", "JALAPENO ENTEROS", "CHIPOTLE ADOBADO"]),
    ("CHILE", "Chilis", "RANCHO VERDE", "198 GR", "CS/12", 21, ["CHIPOTLE ADOBADO", "JALAPENO RAJAS"]),
    ("CHILE", "Chilis", "LA HUERTA", "1 KG", "DISPLAYS", 13, ["SECO BULK GUAJILLO", "SECO BULK ANCHO", "SECO BULK ARBOL"]),
    ("FRIJO", "Beans", "LA HUERTA", "430 GR", "CS/12", 17, ["FRIJOLES NEGROS REFRITOS", "FRIJOLES BAYOS REFRITOS", "FRIJOLES PINTOS ENTEROS"]),
    ("TORTI", "Tortillas", "MAIZ DORADO", "500 GR", "CS/10", 19, ["MAIZ 12 CM TAQUERA", "MAIZ 15 CM AMARILLA"]),
    ("TORTI", "Tortillas", "MAIZ DORADO", "1 KG", "CS/10", 27, ["TRIGO 20 CM", "TRIGO 25 CM BURRITO"]),
    ("TOSTA", "Tortillas", "MAIZ DORADO", "325 GR", "CS/8", 22, ["TOSTADAS ORIGINALES", "TOSTADAS HORNEADAS"]),
    ("HARIN", "Pantry", "MASA FINA", "1 KG", "CS/10", 19, ["HARINA MAIZ BLANCO", "HARINA MAIZ AZUL", "HARINA PARA TAMALES"]),
    ("CPOWD", "Pantry", "SAZON REAL", "142 GR", "CS/12", 24, ["CHILI LIMON POWDER", "CHILI LIMON POWDER LOW SODIUM"]),
    ("CPOWD", "Pantry", "SAZON REAL", "45 GR", "CS/24", 20, ["CHILI LIMON POWDER", "HABANERO POWDER"]),
    ("CONDI", "Pantry", "DONA LUPE", "1 KG", "CS/6", 29, ["ACHIOTE PASTA", "MOLE ROJO PASTA"]),
    ("SNACK", "Snacks", "CRUJIX", "150 GR", "CS/20", 23, ["CHIPS CHILI LIMON", "CHIPS QUESO", "CHIPS FUEGO", "CHIPS SAL"]),
    ("SNACK", "Snacks", "CRUJIX", "42 GR", "CS/40", 25, ["CHIPS CHILI LIMON", "CHIPS FUEGO"]),
    ("SNACK", "Snacks", "BOTANA BRAVA", "200 GR", "CS/12", 21, ["CACAHUATES ENCHILADOS", "PALOMITAS CHILE"]),
    ("CANDY", "Sweets", "DULCERIA SOL", "20 x 14 GR", "DISPLAYS", 11, ["TAMARINDO POP", "MANGO CHILE POP", "SANDIA CHILE POP"]),
    ("CANDY", "Sweets", "DULCERIA SOL", "40 x 14 GR", "DISPLAYS", 15, ["MANGO CON CHILE", "TAMARINDO CON CHILE"]),
    ("CANDY", "Sweets", "PICOSITO", "12 x 30 GR", "DISPLAYS", 14, ["PALETA CHILE", "GOMITAS CHILE"]),
    ("POSTR", "Sweets", "DONA LUPE", "350 GR", "CS/12", 28, ["CAJETA SQUEEZE", "DULCE DE LECHE"]),
    ("BEVER", "Drinks", "AGUA CLARA", "700 ML", "CS/12", 26, ["JAMAICA CONCENTRADO", "HORCHATA CONCENTRADO", "TAMARINDO CONCENTRADO"]),
    ("BEVER", "Drinks", "SOL SODA", "355 ML", "CS/24", 22, ["MANDARINA CAN", "TAMARINDO CAN", "TORONJA CAN", "MANZANA CAN"]),
    ("BEVER", "Drinks", "SOL SODA", "1.5 LT", "CS/8", 17, ["MANDARINA PET", "TORONJA PET"]),
    ("BEVER", "Drinks", "CERVECERIA LUNA", "355 ML", "CS/24", 34, ["LAGER GLASS", "OSCURA GLASS", "MICHELADA CAN"]),
    ("XPROD", "Sweets", "SUGAR WAVE", "60 GR", "CS/12", 30, ["SOUR GUMMY BEARS", "BLUE RASPBERRY STRIPS"]),
    ("XPROD", "Drinks", "BOBA BAY", "320 ML", "CS/24", 38, ["BROWN SUGAR MILK TEA", "STRAWBERRY TEA"]),
]
COLORS = {"Sauces": "#d23a2a", "Chilis": "#3f8f3a", "Beans": "#7a4a2b", "Tortillas": "#e0a526",
          "Pantry": "#c46a1c", "Snacks": "#e8562a", "Sweets": "#d6418f", "Drinks": "#2477c9"}

products = []
sku = 30000
for code, cat, brand, size, unit, price, variants in LINES:
    for v in variants:
        sku += rng.choice([1, 2, 3, 5])
        products.append({
            "id": sku, "sku": str(sku), "code": code, "category": cat, "brand": brand, "variant": v,
            "name": f"[{sku}] {code} {brand} {size} {v}" + (f" ({unit[3:]} UN)" if unit.startswith("CS/") and rng.random() < .3 else ""),
            "uom": unit, "price": round(price * rng.uniform(.9, 1.15), 2),
        })
P = {p["id"]: p for p in products}
# A couple of samples, which the recommendations must never suggest.
for p in rng.sample(products, 2):
    sid = p["id"] + 9000
    P[sid] = dict(p, id=sid, sku=str(sid), name=f"[{sid}] {p['code']} {p['brand']} SAMPLE {p['variant']}", sample=True)

# Stock: on hand, reserved for other orders, deliveries on their way.
stock = {}
for p in products:
    on_hand = 0 if rng.random() < .2 else rng.choice([rng.randint(1, 60), rng.randint(60, 900), rng.randint(900, 6000)])
    reserved = min(on_hand, rng.randint(0, 40)) if on_hand else 0
    arrivals = []
    if rng.random() < .45:
        for k in range(rng.choice([1, 1, 1, 2, 3])):
            day = TODAY + dt.timedelta(days=rng.randint(-12, 70))
            arrivals.append({"date": day.isoformat(), "qty": float(rng.randint(20, 1500)), "ref": f"P{rng.randint(10000, 10999)}"})
        arrivals.sort(key=lambda a: a["date"])
    stock[p["id"]] = {"on_hand": float(on_hand), "reserved": float(reserved), "arrivals": arrivals}

# ---------------------------------------------------------------------------
# Price lists and customers.
# ---------------------------------------------------------------------------
def by_cats(*cats):
    return {p["id"] for p in products if p["category"] in cats}

PRICELISTS = [
    {"id": 11, "name": "Retail (EUR)", "products": {p["id"] for p in products}, "factor": 1.0},
    {"id": 12, "name": "Wholesale (EUR)", "products": {p["id"] for p in products}, "factor": .86},
    {"id": 13, "name": "Restaurants (EUR)", "products": by_cats("Sauces", "Chilis", "Beans", "Tortillas", "Pantry", "Drinks"), "factor": .92},
    {"id": 14, "name": "Supermarkets DE (EUR)", "products": by_cats("Sauces", "Snacks", "Sweets", "Drinks", "Tortillas"), "factor": .9},
    {"id": 15, "name": "Candy & Snacks (EUR)", "products": by_cats("Snacks", "Sweets", "Drinks"), "factor": .95},
    {"id": 16, "name": "Gourmet Shops (EUR)", "products": by_cats("Sauces", "Chilis", "Pantry", "Sweets"), "factor": 1.05},
]
PL = {pl["id"]: pl for pl in PRICELISTS}
for pl in PRICELISTS:
    pl["prices"] = {pid: round(P[pid]["price"] * pl["factor"], 2) for pid in pl["products"]}

SALES = ["Ana López", "Marco Weber", "Julie Martin", "Tomás Ruiz"]
# name, city, country, price list, taste (categories they lean to), trend this year
SHOPS = [
    ("La Tiendita Verde", "Madrid", "Spain", 11, ["Sauces", "Chilis", "Snacks"], 1.1),
    ("Mercado Azul", "Barcelona", "Spain", 12, ["Sauces", "Beans", "Tortillas", "Pantry"], .8),
    ("Casa Sabor GmbH", "Berlin", "Germany", 14, ["Snacks", "Sweets", "Drinks"], 1.25),
    ("Taqueria Luna", "Paris", "France", 13, ["Tortillas", "Chilis", "Sauces", "Drinks"], 1.0),
    ("El Rincón Mexicano", "Lyon", "France", 11, ["Sauces", "Sweets", "Pantry"], .7),
    ("Sweet Corner BV", "Amsterdam", "Netherlands", 15, ["Sweets", "Snacks", "Drinks"], 1.4),
    ("Picante & Co", "Milan", "Italy", 16, ["Sauces", "Chilis", "Pantry"], .95),
    ("Nordic Taco AB", "Stockholm", "Sweden", 13, ["Tortillas", "Sauces", "Beans"], 1.15),
    ("Mexi Markt", "Munich", "Germany", 14, ["Sauces", "Snacks", "Drinks", "Tortillas"], .9),
    ("Sol y Sombra", "Valencia", "Spain", 12, ["Drinks", "Snacks", "Sweets"], 1.05),
    ("Gourmet Latino", "Brussels", "Belgium", 16, ["Pantry", "Chilis", "Sweets"], 1.3),
    ("Burrito Brothers Ltd", "Dublin", "Ireland", 13, ["Tortillas", "Beans", "Sauces", "Chilis"], .6),
    ("Kiosk Paradiso", "Vienna", "Austria", 15, ["Sweets", "Drinks"], 1.0),
    ("Cantina Roja", "Hamburg", "Germany", 13, ["Chilis", "Tortillas", "Drinks"], 1.2),
    ("Little Mexico Shop", "Prague", "Czech Republic", 11, ["Sauces", "Snacks", "Sweets", "Pantry"], .85),
    ("Fiesta Foods SARL", "Marseille", "France", 12, ["Beans", "Tortillas", "Pantry", "Chilis"], 1.1),
    ("Chili Club", "Copenhagen", "Denmark", 16, ["Sauces", "Chilis"], 1.0),
    ("Abarrotes Europa", "Lisbon", "Portugal", 11, ["Pantry", "Beans", "Drinks", "Sweets"], .75),
    ("Snack Attack GmbH", "Cologne", "Germany", 15, ["Snacks", "Sweets", "Drinks"], 1.35),
    ("Tortilla Factory", "Rotterdam", "Netherlands", 13, ["Tortillas", "Sauces"], 1.0),
    ("Casa Maya", "Warsaw", "Poland", 11, ["Sauces", "Sweets", "Snacks"], 1.2),
    ("Mole & More", "Zurich", "Switzerland", 16, ["Pantry", "Sauces"], .9),
    ("Bodega Central", "Seville", "Spain", 12, ["Drinks", "Beans", "Tortillas"], 1.05),
    ("Street Taco Co", "London", "United Kingdom", 13, ["Tortillas", "Chilis", "Sauces", "Drinks"], 1.15),
]
MULTI = {"Mercado Azul": [("Barcelona", .55), ("Madrid", .45)],
         "Mexi Markt": [("Munich", .6), ("Nuremberg", .3), ("Augsburg", .1)],
         "Casa Sabor GmbH": [("Berlin", .7), ("Hamburg", .3)]}
DROPSHIP = "Little Mexico Shop"   # ships web orders to its own customers' homes
HOME_TOWNS = ["Brno", "Ostrava", "Plzeň", "Olomouc", "Liberec", "Zlín", "Pardubice", "Jihlava", "Kladno", "Most"]

customers = []
for i, (name, city, country, pl, taste, trend) in enumerate(SHOPS):
    cid = 500 + i * 7
    slug = re.sub(r"[^a-z]+", "", name.lower())[:14]
    customers.append({
        "id": cid, "name": name, "city": city, "country": country, "pricelist": pl, "taste": taste, "trend": trend,
        "salesperson": SALES[i % len(SALES)], "email": f"orders@{slug}.example",
        "phone": f"+{rng.randint(30, 49)} {rng.randint(600, 699)} {rng.randint(100, 999)} {rng.randint(100, 999)}",
        "every": rng.choice([5, 7, 10, 14, 14, 21, 28]),
        "since": START - dt.timedelta(days=rng.randint(40, 900)),
    })
C = {c["id"]: c for c in customers}

# ---------------------------------------------------------------------------
# Orders: each shop has regulars (often bought together, since they share a
# taste), occasional extras, products it dropped last year, and new ones.
# ---------------------------------------------------------------------------
orders, lines = [], []
oid = 100000
for c in customers:
    pool = [pid for pid in PL[c["pricelist"]]["products"] if P[pid]["category"] in c["taste"]]
    others = [pid for pid in PL[c["pricelist"]]["products"] if pid not in pool]
    regulars = rng.sample(pool, min(len(pool), rng.randint(8, 16)))
    stopped = set(rng.sample(regulars, max(1, len(regulars) // 6)))
    stop_day = START + dt.timedelta(days=rng.randint(120, 300))
    fresh = [p for p in pool if p not in regulars] or others
    new = rng.sample(fresh, min(3, len(fresh)))
    new_from = dt.date(YEAR, 1, 1) + dt.timedelta(days=rng.randint(10, max(11, (TODAY - dt.date(YEAR, 1, 1)).days - 30)))
    # Some regulars every order, some every few orders.
    weight = {pid: rng.choice([.9, .7, .5, .35]) for pid in regulars}
    day = START + dt.timedelta(days=rng.randint(0, 10))
    while day <= TODAY:
        factor = c["trend"] if day.year == YEAR else 1.0
        places = MULTI.get(c["name"])
        if c["name"] == DROPSHIP and rng.random() < .35:
            place = rng.choice(HOME_TOWNS)
        elif places:
            place = rng.choices([p for p, _ in places], [w for _, w in places])[0]
        else:
            place = c["city"]
        basket = [pid for pid in regulars if rng.random() < weight[pid] and not (pid in stopped and day > stop_day)]
        if day >= new_from:
            basket += [pid for pid in new if rng.random() < .6]
        if rng.random() < .3:
            basket.append(rng.choice(others or pool))
        if basket:
            oid += 1
            total = 0.0
            recent = (TODAY - day).days < 25
            for pid in set(basket):
                qty = max(1, round(rng.randint(1, 8) * factor))
                price = PL[c["pricelist"]]["prices"].get(pid, P[pid]["price"])
                sub = round(qty * price, 2)
                delivered = qty if not recent or rng.random() < .6 else rng.randint(0, qty - 1)
                lines.append({"order": oid, "product": pid, "qty": float(qty), "delivered": float(delivered), "subtotal": sub, "price": price})
                total += sub
            orders.append({"id": oid, "name": f"S{oid}", "customer": c["id"], "date": day.isoformat(),
                           "amount": round(total, 2), "place": place, "pricelist": c["pricelist"]})
        gap = c["every"] / (factor if day.year == YEAR else 1)
        day += dt.timedelta(days=max(2, round(gap * rng.uniform(.6, 1.5))))
O = {o["id"]: o for o in orders}
for l in lines:
    l["date"] = O[l["order"]]["date"]
    l["customer"] = O[l["order"]]["customer"]

# ---------------------------------------------------------------------------
# Shared helpers (same rules as the real tool).
# ---------------------------------------------------------------------------
STOP = {"GR", "KG", "ML", "LT", "UN", "CAN", "PET", "GLASS", "CON", "DE", "LA", "EL", "PARA", "SAMPLE"}


def words(pid):
    name = re.sub(r"^\[[^\]]*\]\s*", "", P[pid]["name"])
    return {w for w in re.findall(r"[A-ZÁÉÍÓÚÑ]{3,}", name.upper()) if w not in STOP}


def split(pid):
    m = re.match(r"^\[([^\]]+)\]\s*(.*)$", P[pid]["name"])
    return m.group(1), m.group(2)


def free(pid):
    s = stock.get(pid, {"on_hand": 0, "reserved": 0})
    return round(s["on_hand"] - s["reserved"], 2)


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def days(a, b):
    return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days


def place_of(c):
    return f"{c['city']}, {c['country']}"


def customer_card(c):
    return {"id": c["id"], "name": c["name"], "place": place_of(c),
            "pricelist": {"id": c["pricelist"], "name": PL[c["pricelist"]]["name"]}}


year_ago = (TODAY - dt.timedelta(days=365)).isoformat()
baskets = defaultdict(lambda: defaultdict(float))     # last 12 months: customer -> product -> spend
for l in lines:
    if l["date"] >= year_ago:
        baskets[l["customer"]][l["product"]] += l["subtotal"]
buyers = defaultdict(set)
for c, b in baskets.items():
    for pid in b:
        buyers[pid].add(c)
TOTAL = len(baskets) or 1
index = defaultdict(set)
for pid in P:
    for w in words(pid):
        index[w].add(pid)
IDF = {w: math.log(len(P) / len(ps)) for w, ps in index.items()}


def bought_together(pid, exclude, limit=4):
    bs = buyers.get(pid, set())
    if not bs:
        return []
    co = Counter(q for c in bs for q in baskets[c] if q not in exclude and q != pid)
    out = []
    for q, n in co.items():
        if n < (2 if len(bs) >= 3 else 1):
            continue
        conf = n / len(bs)
        lift = conf / (len(buyers[q]) / TOTAL)
        if lift > 1:
            out.append({"product_id": q, "kind": "together", "confidence": round(conf, 3), "lift": round(lift, 2),
                        "co_buyers": n, "buyers": len(bs)})
    out.sort(key=lambda r: (-r["confidence"], -r["lift"]))
    return out[:limit]


def similar(pid, exclude, limit=4):
    ws = words(pid)
    norm = sum(IDF.get(w, 0) for w in ws)
    if not norm:
        return []
    score, shared = Counter(), defaultdict(list)
    for w in ws:
        if len(index[w]) > .15 * len(P):
            continue
        for q in index[w]:
            if q != pid and q not in exclude and not P[q].get("sample"):
                score[q] += IDF[w]
                shared[q].append(w)
    out = []
    for q, sc in score.items():
        match = sc / norm
        if match < .25 or words(q) == ws or (len(ws) >= 3 and len(shared[q]) < 2):
            continue
        pop = len(buyers.get(q, ()))
        rank = match + (.15 if P[q]["category"] == P[pid]["category"] else 0) + .05 * math.log1p(pop)
        out.append((rank, {"product_id": q, "kind": "similar", "match": round(match, 3), "popularity": pop,
                           "shared": sorted(shared[q], key=lambda w: -IDF[w])[:3]}))
    out.sort(key=lambda r: -r[0])
    return [r for _, r in out[:limit]]


def skip_set(have):
    have_words = {frozenset(words(pid)) for pid in have}
    return set(have) | {q for q in P if q not in have and (P[q].get("sample") or frozenset(words(q)) in have_words)}


def per_sku(rows, skip, prices):
    out = []
    for pid in rows:
        tog = bought_together(pid, skip)
        sim = similar(pid, skip | {x["product_id"] for x in tog})
        for x in tog + sim:
            x["sku"], x["name"] = split(x["product_id"])
        sku_, name = split(pid)
        out.append({"product_id": pid, "sku": sku_, "name": name, "price": prices.get(pid),
                    "customers": len(buyers.get(pid, ())), "together": tog, "similar": sim})
    return out


def details(pid, prices):
    sku_, name = split(pid)
    return {"product_id": pid, "sku": sku_, "name": name, "on_pricelist": pid in prices, "price": prices.get(pid),
            "free_qty": free(pid), "base_uom": P[pid]["uom"], "pack": None}


def similar_shops(own_ids, own):
    mine = set(own)
    scored = sorted(((len(mine & b.keys()) / len(mine | b.keys()), c) for c, b in baskets.items()
                     if c not in own_ids and len(mine & b.keys()) >= 3), reverse=True)[:25]
    score, count = Counter(), Counter()
    for sim, c in scored:
        for q in baskets[c]:
            if q not in mine:
                score[q] += sim
                count[q] += 1
    best = sorted((q for q in score if count[q] >= 2 and not P[q].get("sample")), key=lambda q: -score[q])
    return [(q, score[q], count[q]) for q in best[:15]], len(scored)


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Stock check: one price list, optionally for one customer.
# ---------------------------------------------------------------------------
def stock_check(pl_id, client=None):
    pl = PL[pl_id]
    cutoff = (TODAY - dt.timedelta(days=3 * 365)).isoformat()
    if client:
        who = [client]
    else:
        spend = Counter()
        for o in orders:
            if o["pricelist"] == pl_id:
                spend[o["customer"]] += o["amount"]
        who = [c for c, _ in spend.most_common()]
    last = {}
    for l in lines:
        if l["customer"] in who and l["date"] >= cutoff and l["date"] > last.get(l["product"], ("",))[0]:
            last[l["product"]] = (l["date"], C[l["customer"]]["name"])
    rows = []
    for pid in sorted(pl["products"]):
        s = stock[pid]
        f = free(pid)
        rows.append({
            "id": pid, "name": P[pid]["name"], "price": pl["prices"][pid], "on_hand": s["on_hand"], "free_qty": f,
            "sku": P[pid]["sku"], "incoming": round(sum(a["qty"] for a in s["arrivals"]), 2), "arrivals": s["arrivals"],
            "next_eta": s["arrivals"][0]["date"] if s["arrivals"] else None,
            "last_sold": last.get(pid, (None, None))[0], "last_sold_by": last.get(pid, (None, None))[1],
            "status": "out" if f <= 0 else "ok", "base_uom": P[pid]["uom"], "pack": None,
        })
    rows.sort(key=lambda r: -r["free_qty"])
    return {
        "fetched_at": now_iso(), "report_type": "pricelist_stock", "pricelist": {"id": pl_id, "name": pl["name"].replace(" (EUR)", "")},
        "generated_at": TODAY.isoformat(), "months_back": 36, "other_rules": 0, "product_count": len(rows),
        "out_of_stock_count": sum(1 for r in rows if r["status"] == "out"), "products": rows, "product_uom": {},
        "clients": [C[c]["name"] for c in who],
        "client": {"id": client, "name": C[client]["name"], "last_order_pricelist": None} if client else None,
    }


# ---------------------------------------------------------------------------
# Customer profile.
# ---------------------------------------------------------------------------
def profile(cid, location=None):
    c = C[cid]
    mine = [o for o in orders if o["customer"] == cid]
    by_place = defaultdict(lambda: {"orders": 0, "total": 0.0})
    for o in mine:
        by_place[o["place"]]["orders"] += 1
        by_place[o["place"]]["total"] += o["amount"]
    grand = sum(v["total"] for v in by_place.values()) or 1
    main = {k for k, v in by_place.items() if v["orders"] >= 3 and v["total"] / grand >= .05}
    locs = sorted(({"name": k, "orders": v["orders"], "total": round(v["total"], 2)} for k, v in by_place.items() if k in main),
                  key=lambda l: -l["total"])
    rest = [v for k, v in by_place.items() if k not in main]
    if rest:
        locs.append({"name": "Other places", "orders": sum(v["orders"] for v in rest),
                     "total": round(sum(v["total"] for v in rest), 2), "places": len(rest)})
    if len(main) < 2:
        locs = []
    if location:
        mine = [o for o in mine if (o["place"] if o["place"] in main else "Other places") == location]
    ids = {o["id"] for o in mine}
    my_lines = [l for l in lines if l["order"] in ids]
    same_day = TODAY.replace(year=YEAR - 1).isoformat()

    def total(y, upto=None):
        return round(sum(o["amount"] for o in mine if o["date"][:4] == str(y) and (not upto or o["date"] <= upto)), 2)
    months = {str(YEAR - 1): [0.0] * 12, str(YEAR): [0.0] * 12}
    for o in mine:
        months[o["date"][:4]][int(o["date"][5:7]) - 1] += o["amount"]
    order_days = sorted({o["date"] for o in mine})
    gaps = [g for g in (days(a, b) for a, b in zip(order_days, order_days[1:])) if g > 0]
    usual = median(gaps) if len(gaps) >= 2 else None
    last_order = order_days[-1] if order_days else None
    since = (TODAY - dt.date.fromisoformat(last_order)).days if last_order else None

    per, open_lines = {}, []
    for l in my_lines:
        pid, day = l["product"], l["date"]
        p = per.setdefault(pid, {"id": pid, "name": P[pid]["name"], "uom": P[pid]["uom"], "qty_last": 0.0, "qty_last_same": 0.0,
                                 "qty_now": 0.0, "spent_last": 0.0, "spent_now": 0.0, "days": set(), "last": "", "first": "9999",
                                 "last_price": None})
        if day[:4] == str(YEAR):
            p["qty_now"] += l["qty"]
            p["spent_now"] += l["subtotal"]
        else:
            p["qty_last"] += l["qty"]
            p["spent_last"] += l["subtotal"]
            if day <= same_day:
                p["qty_last_same"] += l["qty"]
        p["days"].add(day)
        p["first"] = min(p["first"], day)
        if day >= p["last"]:
            p["last"], p["last_price"] = day, l["price"]
        left = l["qty"] - l["delivered"]
        if left > 0 and (TODAY - dt.date.fromisoformat(day)).days <= 90:
            open_lines.append({"order": O[l["order"]]["name"], "date": day, "name": P[pid]["name"], "ordered": l["qty"],
                               "to_deliver": left, "amount": round(l["price"] * left, 2)})
    prods = []
    for p in per.values():
        d = sorted(p.pop("days"))
        g = [days(a, b) for a, b in zip(d, d[1:])]
        every = median(g) if g else None
        idle = (TODAY - dt.date.fromisoformat(p["last"])).days
        if p["first"][:4] == str(YEAR):
            status = "new"
        elif len(d) < 2:
            status = "once"
        elif idle > max(120, 3 * every):
            status = "stopped"
        elif idle > 1.3 * every:
            status = "due"
        else:
            status = "ok"
        sku_, short = split(p["id"])
        prods.append({**p, "sku": sku_, "short": short, "orders": len(d), "every": every, "idle": idle, "status": status,
                      "spent_last": round(p["spent_last"], 2), "spent_now": round(p["spent_now"], 2),
                      "left_to_match": max(0.0, round(p["qty_last"] - p["qty_now"], 2)), "free": free(p["id"])})
    prods.sort(key=lambda p: -(p["spent_now"] + p["spent_last"]))
    ideas, near = similar_shops({cid}, [p["id"] for p in prods])
    last_same = total(YEAR - 1, same_day)
    return {
        "fetched_at": now_iso(),
        "client": {"id": cid, "name": c["name"], "place": place_of(c),
                   "pricelist": {"id": c["pricelist"], "name": PL[c["pricelist"]]["name"]}, "salesperson": c["salesperson"],
                   "email": c["email"], "phone": c["phone"], "first_order": c["since"].isoformat(), "last_order": last_order},
        "year": YEAR,
        "totals": {"last_full": total(YEAR - 1), "last_same": last_same, "now": total(YEAR),
                   "pace": round(total(YEAR) / last_same, 3) if last_same else None},
        "months": {"last": [round(x, 2) for x in months[str(YEAR - 1)]], "now": [round(x, 2) for x in months[str(YEAR)]]},
        "orders": {"count_now": sum(1 for o in mine if o["date"][:4] == str(YEAR)),
                   "count_last": sum(1 for o in mine if o["date"][:4] == str(YEAR - 1)),
                   "last": last_order, "since_last": since, "usual_gap": usual,
                   "overdue": bool(usual and since is not None and since > 1.3 * usual),
                   "avg_value": round(sum(o["amount"] for o in mine) / len(mine), 2) if mine else None},
        "products": prods,
        "open_lines": sorted(open_lines, key=lambda l: l["date"]),
        "ideas": [{"id": q, "name": P[q]["name"], "sku": P[q]["sku"], "short": split(q)[1], "similar_buyers": n, "free": free(q)}
                  for q, _, n in sorted(ideas, key=lambda i: free(i[0]) <= 0)],
        "similar_count": near,
        "locations": locs,
        "location": location,
    }


# ---------------------------------------------------------------------------
# Recommendations: for a price list, and for one customer.
# ---------------------------------------------------------------------------
def reco_pricelist(pl_id):
    pl = PL[pl_id]
    on = pl["products"]
    skip = skip_set(on)
    prods = per_sku(sorted(on), skip, pl["prices"])
    fit = {c: len(on & b.keys()) / len(on) for c, b in baskets.items() if on & b.keys()}
    score, count = Counter(), Counter()
    for c, f in fit.items():
        for q in baskets[c]:
            if q not in skip:
                score[q] += f
                count[q] += 1
    adds = []
    for q, sc in score.most_common(12):
        if count[q] >= 2:
            d = details(q, pl["prices"])
            d.update(customers=count[q], score=round(sc, 3))
            adds.append(d)
    who = Counter()
    for o in orders:
        if o["pricelist"] == pl_id and o["date"] >= year_ago:
            who[o["customer"]] += o["amount"]
    names = [C[c]["name"] for c, _ in who.most_common()]
    prods.sort(key=lambda p: (-p["customers"], p["name"]))
    return {"pricelist": {"id": pl_id, "name": pl["name"].replace(" (EUR)", "")}, "months": 12, "customers_total": TOTAL,
            "list_customers": names[:6], "list_customer_count": len(names), "additions": adds, "products": prods}


def reco_customer(cid):
    c = C[cid]
    own = baskets.get(cid, {})
    prices = PL[c["pricelist"]]["prices"]
    skip = skip_set(set(own))
    prods = per_sku(list(own), skip, prices)
    for p in prods:
        p["spent"] = round(own[p["product_id"]], 2)
    prods.sort(key=lambda p: -p["spent"])
    ideas, near = similar_shops({cid}, set(own))
    adds = []
    for q, sc, n in ideas:
        if q in skip:
            continue
        d = details(q, prices)
        d.update(customers=n, score=round(sc, 3))
        adds.append(d)
    adds = adds[:12]
    adds.sort(key=lambda a: a["free_qty"] <= 0)
    return {"client": {"id": cid, "name": c["name"], "place": place_of(c)},
            "pricelist": {"id": c["pricelist"], "name": PL[c["pricelist"]]["name"]}, "months": 12, "customers_total": TOTAL,
            "similar_count": near, "additions": adds, "products": prods}


# ---------------------------------------------------------------------------
# Product pictures: a simple jar / bottle / bag / can / box per category.
# ---------------------------------------------------------------------------
SHAPES = {
    "Sauces": '<path d="M52 18h16v14l8 10v56a6 6 0 0 1-6 6H50a6 6 0 0 1-6-6V42l8-10z" fill="{c}"/><rect x="51" y="10" width="18" height="10" rx="2" fill="#333"/><rect x="48" y="56" width="24" height="26" rx="3" fill="#fff" opacity=".92"/>',
    "Chilis": '<rect x="30" y="26" width="60" height="74" rx="8" fill="{c}"/><rect x="30" y="20" width="60" height="12" rx="4" fill="#aab0b8"/><rect x="36" y="48" width="48" height="30" rx="4" fill="#fff" opacity=".92"/>',
    "Beans": '<path d="M34 22h52l-4 78H38z" fill="{c}"/><rect x="40" y="48" width="40" height="28" rx="4" fill="#fff" opacity=".92"/>',
    "Tortillas": '<rect x="24" y="30" width="72" height="66" rx="10" fill="{c}"/><circle cx="60" cy="63" r="22" fill="#f6e3a8"/><circle cx="60" cy="63" r="22" fill="none" stroke="#fff" stroke-width="3"/>',
    "Pantry": '<path d="M36 26h48l6 74H30z" fill="{c}"/><rect x="38" y="46" width="44" height="30" rx="4" fill="#fff" opacity=".92"/>',
    "Snacks": '<path d="M30 20q30 8 60 0l-6 82q-24 6-48 0z" fill="{c}"/><rect x="38" y="46" width="44" height="26" rx="4" fill="#fff" opacity=".92"/>',
    "Sweets": '<rect x="26" y="34" width="68" height="60" rx="8" fill="{c}"/><circle cx="60" cy="64" r="16" fill="#fff" opacity=".92"/>',
    "Drinks": '<rect x="38" y="16" width="44" height="88" rx="10" fill="{c}"/><rect x="38" y="16" width="44" height="10" rx="5" fill="#cfd5dc"/><rect x="42" y="48" width="36" height="30" rx="4" fill="#fff" opacity=".92"/>',
}


def picture(p):
    initials = "".join(w[0] for w in p["brand"].split()[:2])
    shape = SHAPES[p["category"]].format(c=COLORS[p["category"]])
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#fff"/>{shape}'
            f'<text x="60" y="68" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="700" '
            f'fill="{COLORS[p["category"]]}">{initials}</text></svg>')


# ---------------------------------------------------------------------------
def write(rel, data):
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "img").mkdir(parents=True)
    for p in products:
        (OUT / "img" / f"{p['sku']}.svg").write_text(picture(p), encoding="utf-8")
    write("catalog.json", {"products": [{"sku": p["sku"], "image": f"demo-data/img/{p['sku']}.svg"} for p in products],
                           "photos_published": {}})
    write("pricelists.json", {"results": [{"id": pl["id"], "name": pl["name"].replace(" (EUR)", ""),
                                           "tag": f"{len(pl['products'])} rules · EUR"} for pl in PRICELISTS]})
    write("customers.json", {"results": [customer_card(c) for c in sorted(customers, key=lambda c: c["name"])]})
    write("products.json", {"results": [{
        "sku": p["sku"], "name": p["name"], "free_qty": free(p["id"]), "on_hand": stock[p["id"]]["on_hand"],
        "incoming": round(sum(a["qty"] for a in stock[p["id"]]["arrivals"]), 2), "arrivals": stock[p["id"]]["arrivals"],
        "next_eta": stock[p["id"]]["arrivals"][0]["date"] if stock[p["id"]]["arrivals"] else None,
        "base_uom": p["uom"], "pack": None} for p in products]})
    for pl in PRICELISTS:
        write(f"stock/{pl['id']}.json", stock_check(pl["id"]))
        write(f"reco/pl-{pl['id']}.json", reco_pricelist(pl["id"]))
    for c in customers:
        write(f"stock/{c['pricelist']}-{c['id']}.json", stock_check(c["pricelist"], c["id"]))
        prof = profile(c["id"])
        write(f"profile/{c['id']}.json", prof)
        for loc in prof["locations"]:
            write(f"profile/{c['id']}-{re.sub(r'[^A-Za-z0-9]+', '_', loc['name'])}.json", profile(c["id"], loc["name"]))
        write(f"reco/c-{c['id']}.json", reco_customer(c["id"]))
    print(f"{len(products)} products, {len(customers)} customers, {len(orders)} orders, {len(lines)} order lines "
          f"-> {OUT.relative_to(ROOT)}/ (as of {TODAY})")


if __name__ == "__main__":
    main()
