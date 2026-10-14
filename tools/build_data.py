"""Builds the per-country pin pools used by the site.

Inputs (in ./raw, see README for download commands):
  cities1000.zip          GeoNames populated places (pop >= 1000)
  countryInfo.txt         GeoNames country populations
  admin1CodesASCII.txt    GeoNames state / province names
  countries50m.geojson    Natural Earth 1:50m country borders
  states50m.geojson       Natural Earth 1:50m states / provinces (US, CA, AU, BR, IN, ...)
  unesco.csv, parks.csv, attractions.csv, iso.csv   Wikidata landmark exports
  tools/landmarks_extra.csv                         hand-curated landmarks

Outputs (in ./site/data):
  countries.geojson       simplified borders, properties {iso, name}
  index.json              list of countries that have a pin pool
  c/<ISO>.json            pin pool for one country
  regions/<ISO>.geojson   state / province borders, for countries in states50m.geojson

Every town gets a bitmask of the reasons it is eligible:
  1 METRO      within METRO_CORE_KM of a metro anchor (metro pop >= 400k)
  2 NEAR_METRO within NEAR_KM (50 mi) of a metro anchor
  4 LANDMARK   within NEAR_KM (50 mi) of a landmark / tourist spot
  8 SMALL      the whole country or state/province is small enough to be fully eligible
Towns with no reason are dropped. The browser picks a tier first, then a town.
"""
import csv, io, json, math, os, re, sys, zipfile
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
OUT = os.path.join(ROOT, "site", "data")

METRO_MIN_POP = 400_000      # metro population that counts as a "major metro"
METRO_CLUSTER_KM = 35        # radius used to estimate a metro population
METRO_SEED_POP = 50_000      # only places this big can anchor a metro
METRO_CORE_KM = 30           # towns this close to an anchor count as "in the metro"
NEAR_KM = 80.5               # 50 miles
SMALL_REGION_POP = 1_000_000 # countries / states under this are fully eligible
MIN_TOWN_POP = 500
SEAT_CODES = {"PPLC", "PPLA", "PPLA2"}
BAD_CODES = {"PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH", "PPLR"}

METRO, NEAR_METRO, LANDMARK, SMALL = 1, 2, 4, 8


def haversine(a_lat, a_lng, b_lat, b_lng):
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class Grid:
    """1-degree bucket index for "what is within X km" lookups."""

    def __init__(self, items):  # items: list of (lat, lng, payload)
        self.cells = defaultdict(list)
        for it in items:
            self.cells[(int(math.floor(it[0])), int(math.floor(it[1])))].append(it)

    def near(self, lat, lng, km):
        dlat = km / 111.0 + 1
        dlng = km / (111.0 * max(math.cos(math.radians(lat)), 0.05)) + 1
        for i in range(int(math.floor(lat - dlat)), int(math.floor(lat + dlat)) + 1):
            for j in range(int(math.floor(lng - dlng)), int(math.floor(lng + dlng)) + 1):
                jj = ((j + 180) % 360) - 180
                for it in self.cells.get((i, jj), ()):
                    d = haversine(lat, lng, it[0], it[1])
                    if d <= km:
                        yield d, it

    def nearest(self, lat, lng, km):
        best = None
        for d, it in self.near(lat, lng, km):
            if best is None or d < best[0]:
                best = (d, it)
        return best


def load_countries():
    info = {}
    with open(os.path.join(RAW, "countryInfo.txt"), encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            p = line.rstrip("\n").split("\t")
            info[p[0]] = {"name": p[4], "pop": int(p[7] or 0)}
    return info


def load_admin1():
    names = {}
    with open(os.path.join(RAW, "admin1CodesASCII.txt"), encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            names[p[0]] = p[1]
    return names


def load_towns():
    towns = []
    with zipfile.ZipFile(os.path.join(RAW, "cities1000.zip")) as z:
        with z.open("cities1000.txt") as f:
            for line in io.TextIOWrapper(f, encoding="utf-8"):
                p = line.rstrip("\n").split("\t")
                if p[6] != "P" or p[7] in BAD_CODES:
                    continue
                pop = int(p[14] or 0)
                if pop < MIN_TOWN_POP:
                    continue
                towns.append({
                    "name": p[1], "lat": float(p[4]), "lng": float(p[5]),
                    "cc": p[8], "a1": p[10], "pop": pop, "code": p[7],
                })
    return towns


def load_landmarks():
    iso = {}
    with open(os.path.join(RAW, "iso.csv"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            iso[row["c"]] = row["iso"]
    pt = re.compile(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)")
    out = []
    for fn in ("unesco.csv", "parks.csv", "attractions.csv"):
        with open(os.path.join(RAW, fn), encoding="utf-8") as f:
            for row in csv.DictReader(f):
                m = pt.match(row["coord"])
                cc = iso.get(row["c"])
                if not m or not cc:
                    continue
                name = row.get("label") or ""
                if not name or re.fullmatch(r"Q\d+", name):
                    continue
                out.append((float(m.group(2)), float(m.group(1)), name, cc))
    with open(os.path.join(ROOT, "tools", "landmarks_extra.csv"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            out.append((float(row["lat"]), float(row["lng"]), row["name"], row["cc"]))
    # Drop near-duplicates (UNESCO lists many component parts of one site).
    kept, grid = [], Grid([])
    for lm in out:
        if grid.nearest(lm[0], lm[1], 3):
            continue
        kept.append(lm)
        grid.cells[(int(math.floor(lm[0])), int(math.floor(lm[1])))].append(lm)
    return kept


def find_metro_anchors(towns):
    seeds = [t for t in towns if t["pop"] >= METRO_SEED_POP]
    grid = Grid([(t["lat"], t["lng"], t) for t in towns])
    anchors = []
    for s in seeds:
        total = sum(it[2]["pop"] for _, it in grid.near(s["lat"], s["lng"], METRO_CLUSTER_KM))
        if total >= METRO_MIN_POP:
            s["metro_pop"] = total
            anchors.append(s)
    # Name each anchor after the biggest city in its cluster, so suburbs read "Atlanta metro".
    # Capitals and admin seats get a boost, which skips GeoNames duplicates like a
    # second "Minato" entry sitting on top of Wakayama.
    score = lambda t: t["pop"] * (1.5 if t["code"] in SEAT_CODES else 1)
    agrid = Grid([(a["lat"], a["lng"], a) for a in anchors])
    for a in anchors:
        a["parent"] = max((it[2] for _, it in agrid.near(a["lat"], a["lng"], METRO_CLUSTER_KM)), key=score)
    # Follow the chain of bigger neighbours (Hicksville -> Queens -> New York City).
    for a in anchors:
        top, seen = a, set()
        while top["parent"] is not top and id(top) not in seen:
            seen.add(id(top))
            top = top["parent"]
        a["metro_name"] = top["name"]
        a["top"] = top
    return anchors


def simplify_ring(ring, tol=0.01):
    """Drops points closer than tol degrees to the previous kept point; rounds to 3 dp."""
    out = []
    for x, y in ring:
        p = [round(x, 3), round(y, 3)]
        if out and abs(p[0] - out[-1][0]) < tol and abs(p[1] - out[-1][1]) < tol:
            continue
        out.append(p)
    if out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else None


def clean_polys(geometry):
    """GeoJSON (Multi)Polygon -> simplified list of polygons."""
    polys = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    out = []
    for poly in polys:
        rings = [r for r in (simplify_ring(r) for r in poly) if r]
        if rings and len(rings[0]) >= 4:
            out.append(rings)
    return out


def in_ring(ring, lat, lng):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def load_regions():
    """States / provinces keyed by country: {cc: [{id, name, gn, polys, bbox}]}."""
    with open(os.path.join(RAW, "states50m.geojson"), encoding="utf-8") as f:
        gj = json.load(f)
    out = defaultdict(list)
    for ft in gj["features"]:
        p = ft["properties"]
        cc, gn = p.get("iso_a2"), p.get("gn_a1_code") or ""
        polys = clean_polys(ft["geometry"])
        if not cc or not polys:
            continue
        suffix = gn.split(".", 1)[1] if "." in gn else ""
        suffix = suffix or p.get("postal") or p.get("adm1_code")
        xs = [x for poly in polys for x, _ in poly[0]]
        ys = [y for poly in polys for _, y in poly[0]]
        out[cc].append({"id": f"{cc}-{suffix}", "name": p["name"], "gn": gn, "polys": polys,
                        "bbox": (min(xs), min(ys), max(xs), max(ys))})
    return out


def region_of(t, regions, by_gn):
    """GeoNames admin1 code first; point-in-polygon for the few codes that don't line up."""
    r = by_gn.get(f'{t["cc"]}.{t["a1"]}')
    if r:
        return r
    for r in regions:
        x0, y0, x1, y1 = r["bbox"]
        if x0 <= t["lng"] <= x1 and y0 <= t["lat"] <= y1:
            for poly in r["polys"]:
                if in_ring(poly[0], t["lat"], t["lng"]) and not any(in_ring(h, t["lat"], t["lng"]) for h in poly[1:]):
                    return r
    return None


def build_borders(have_pool, info):
    with open(os.path.join(RAW, "countries50m.geojson"), encoding="utf-8") as f:
        gj = json.load(f)
    feats = []
    for ft in gj["features"]:
        p = ft["properties"]
        iso = p.get("ISO_A2_EH") or p.get("ISO_A2")
        if not iso or iso == "-99":
            continue
        new_polys = clean_polys(ft["geometry"])
        if not new_polys:
            continue
        name = info.get(iso, {}).get("name") or p.get("NAME")
        feats.append({
            "type": "Feature",
            "properties": {"iso": iso, "name": name, "pool": iso in have_pool},
            "geometry": {"type": "MultiPolygon", "coordinates": new_polys},
        })
    with open(os.path.join(OUT, "countries.geojson"), "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"))
    return {ft["properties"]["iso"] for ft in feats}


def main():
    os.makedirs(os.path.join(OUT, "c"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "regions"), exist_ok=True)
    info = load_countries()
    a1names = load_admin1()
    towns = load_towns()
    landmarks = load_landmarks()
    regions = load_regions()
    anchors = find_metro_anchors(towns)
    print(f"{len(towns)} towns, {len(landmarks)} landmarks, {len(anchors)} metro anchors")

    # Estimate state / province populations from the town list, scaled up so the
    # total matches the real country population (town lists miss rural residents).
    town_sum = defaultdict(int)
    a1_sum = defaultdict(int)
    for t in towns:
        town_sum[t["cc"]] += t["pop"]
        a1_sum[(t["cc"], t["a1"])] += t["pop"]

    def region_small(t):
        cpop = info.get(t["cc"], {}).get("pop", 0)
        if cpop and cpop < SMALL_REGION_POP:
            return True
        scale = (cpop / town_sum[t["cc"]]) if cpop and town_sum[t["cc"]] else 1
        return a1_sum[(t["cc"], t["a1"])] * scale < SMALL_REGION_POP

    agrid = Grid([(a["lat"], a["lng"], a) for a in anchors])
    lgrid = Grid(landmarks)

    by_cc = defaultdict(list)
    for t in towns:
        mask, metro, lm, dm = 0, "", "", -1
        hit = agrid.nearest(t["lat"], t["lng"], NEAR_KM)
        if hit:
            d, a = hit[0], hit[1][2]
            metro = a["metro_name"]
            mask |= METRO if d <= METRO_CORE_KM else NEAR_METRO
            # Distance to the metro's main city, so pins can favour downtowns over suburbs.
            dm = round(haversine(t["lat"], t["lng"], a["top"]["lat"], a["top"]["lng"]), 1)
        hit = lgrid.nearest(t["lat"], t["lng"], NEAR_KM)
        if hit:
            mask |= LANDMARK
            lm = hit[1][2]
        if region_small(t):
            mask |= SMALL
        if mask:
            by_cc[t["cc"]].append((t, mask, metro, lm, dm))

    index = []
    for cc, rows in sorted(by_cc.items()):
        strings, sidx = [""], {"": 0}

        def s(x):
            if x not in sidx:
                sidx[x] = len(strings)
                strings.append(x)
            return sidx[x]

        regs = regions.get(cc, [])
        by_gn = {r["gn"]: r for r in regs}
        reg_count = defaultdict(int)
        places = []
        for t, mask, metro, lm, dm in rows:
            region = a1names.get(f'{cc}.{t["a1"]}', "")
            r = region_of(t, regs, by_gn) if regs else None
            if r:
                region = r["name"]
                reg_count[r["id"]] += 1
            # [lat, lng, pop, tier mask, name, region name, metro, landmark, region id, km to metro centre]
            places.append([round(t["lat"], 4), round(t["lng"], 4), t["pop"], mask,
                           s(t["name"]), s(region), s(metro), s(lm), s(r["id"] if r else ""), dm])
        cname = info.get(cc, {}).get("name", cc)
        with open(os.path.join(OUT, "c", f"{cc}.json"), "w", encoding="utf-8") as f:
            json.dump({"iso": cc, "name": cname, "strings": strings, "places": places},
                      f, ensure_ascii=False, separators=(",", ":"))
        counts = {k: sum(1 for p in places if p[3] & v)
                  for k, v in (("metro", METRO), ("near", NEAR_METRO), ("landmark", LANDMARK), ("small", SMALL))}
        entry = {"iso": cc, "name": cname, "places": len(places), **counts}
        if regs:
            kept = [r for r in regs if reg_count[r["id"]]]
            entry["regions"] = sorted(({"id": r["id"], "name": r["name"], "places": reg_count[r["id"]]}
                                       for r in kept), key=lambda r: r["name"])
            features = [{"type": "Feature", "properties": {"id": r["id"], "name": r["name"]},
                         "geometry": {"type": "MultiPolygon", "coordinates": r["polys"]}} for r in kept]
            with open(os.path.join(OUT, "regions", f"{cc}.geojson"), "w", encoding="utf-8") as f:
                json.dump({"type": "FeatureCollection", "features": features},
                          f, ensure_ascii=False, separators=(",", ":"))
        index.append(entry)

    borders = build_borders({r["iso"] for r in index}, info)
    index = [r for r in index if r["iso"] in borders]
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(sorted(index, key=lambda r: r["name"]), f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(index)} countries")


if __name__ == "__main__":
    sys.exit(main())
