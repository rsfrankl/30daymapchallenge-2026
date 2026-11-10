"""Step 1: geocode Strava place names offline.

Input : data/activities.csv  (id, start_local, sport_type, location_summary, is_trainer)
Output: data/places.csv      (location_summary, n, lat, lon, method)

Strava's connector returns a place name ("Cambridge, Massachusetts"), not coordinates.
At world scale, town-level precision is visually identical to GPS start points.

Method, in order:
  1. gazetteer  — exact name match in GeoNames cities1000 (bundled with the
                  `reverse_geocoder` package), constrained to the right US state
                  (admin1) or country.
  2. manual     — hand-assigned representative point for names the gazetteer
                  can't resolve (national parks, counties, districts, whole
                  countries). Listed in MANUAL below so every one is auditable.
"""
import csv, collections, os, sys, unicodedata
import reverse_geocoder

HERE = os.path.dirname(os.path.abspath(__file__))

COUNTRY = {  # region string as Strava writes it -> ISO2
    "United Kingdom": "GB", "Germany": "DE", "Italy": "IT", "Spain": "ES",
    "Australia": "AU", "Netherlands": "NL", "Slovakia": "SK", "Denmark": "DK",
    "Ireland": "IE", "Canada": "CA", "Belgium": "BE", "France": "FR",
    "New Zealand": "NZ", "Switzerland": "CH", "Greece": "GR", "Singapore": "SG",
    "United Arab Emirates": "AE", "Austria": "AT", "Sweden": "SE",
}
US_STATES = {
    "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut",
    "Delaware","District of Columbia","Florida","Georgia","Hawaii","Idaho","Illinois",
    "Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts",
    "Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada",
    "New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota",
    "Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina",
    "South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington",
    "West Virginia","Wisconsin","Wyoming",
}

# Hand-assigned points (lat, lon) for names a town gazetteer can't resolve.
# Representative point = main town / centroid of the named area.
MANUAL = {
    "North Tyneside, United Kingdom": (55.017, -1.45),        # Tynemouth / Whitley Bay
    "Greater London, United Kingdom": (51.507, -0.128),
    "City of Edinburgh, United Kingdom": (55.953, -3.189),
    "Inverleith Conservation Area, United Kingdom": (55.965, -3.21),
    "Cairngorms National Park, United Kingdom": (57.08, -3.67),
    "Northumberland National Park, United Kingdom": (55.30, -2.20),
    "Northumberland Coast AONB, United Kingdom": (55.55, -1.65),
    "Northumberland, United Kingdom": (55.17, -1.69),          # Morpeth
    "North Pennines AONB, United Kingdom": (54.75, -2.25),
    "Lake District National Park, United Kingdom": (54.46, -3.09),
    "Yorkshire Dales National Park, United Kingdom": (54.23, -2.10),
    "Loch Lomond and The Trossachs National Park, United Kingdom": (56.20, -4.60),
    "Perth and Kinross, United Kingdom": (56.396, -3.437),     # Perth
    "Highland, United Kingdom": (57.478, -4.225),              # Inverness
    "Fife, United Kingdom": (56.34, -2.80),                    # St Andrews
    "Northern Ireland, United Kingdom": (54.597, -5.930),      # Belfast
    "North Yorkshire, United Kingdom": (54.0, -1.54),          # Harrogate
    "Bath and North East Somerset, United Kingdom": (51.381, -2.359),
    "City of Bristol, United Kingdom": (51.454, -2.588),
    "Aberdeen City, United Kingdom": (57.149, -2.094),
    "Gwynedd, United Kingdom": (52.93, -4.05),
    "Charnwood, United Kingdom": (52.772, -1.206),             # Loughborough
    "Cambridge, United Kingdom": (52.205, 0.119),
    "Liverpool, United Kingdom": (53.408, -2.991),
    "Leeds, United Kingdom": (53.801, -1.549),
    "Oxford, United Kingdom": (51.752, -1.258),
    "Newcastle upon Tyne, United Kingdom": (54.978, -1.618),
    "Bremen-West, Germany": (53.09, 8.76),
    "Altstadt, Germany": (53.076, 8.807),                      # ambiguous; Bremen Altstadt, see README
    "Mitte, Germany": (52.52, 13.40),                          # Berlin-Mitte
    "District of Bratislava I, Slovakia": (48.145, 17.107),
    "Copenhagen Municipality, Denmark": (55.676, 12.568),
    "Denmark": (55.676, 12.568),                               # country-only label; placed at Copenhagen
    "Greater Brisbane, Australia": (-27.47, 153.03),
    "Waitematā, New Zealand": (-36.85, 174.76),                # Auckland CBD
    "Queenstown-Lakes District, New Zealand": (-45.03, 168.66),
    "Municipality of Athens, Greece": (37.984, 23.728),
    "Municipality of Hydra, Greece": (37.35, 23.47),
    "Mytilene Municipal Unit, Greece": (39.11, 26.55),
    "Central, Singapore": (1.29, 103.85),
    "Utrechtse Heuvelrug, Netherlands": (52.04, 5.38),
    "Haarlemmermeer, Netherlands": (52.30, 4.69),
    "Meidling, Austria": (48.175, 16.33),
    "Döbling, Austria": (48.25, 16.34),
    "Kane County, Utah": (37.05, -112.53),                     # Kanab
    "Quay County, New Mexico": (35.17, -103.72),               # Tucumcari
    "Coconino National Forest, Arizona": (35.20, -111.65),     # Flagstaff
    "Hawaiʻi County, Hawaii": (19.72, -155.09),                # Hilo
    "Arlington County, Virginia": (38.88, -77.10),
    "Santa Cruz County, California": (36.97, -122.03),
    "Wilder Ranch State Park, California": (36.96, -122.08),
    "Boulder Open Space and Mountain Parks, Colorado": (39.99, -105.29),
    "Pinkham's Grant, New Hampshire": (44.26, -71.25),
    "Washington, District of Columbia": (38.895, -77.036),
    "Cambridge, Massachusetts": (42.373, -71.110),
    # small towns missing from cities1000
    "Bad Schönborn, Germany": (49.205, 8.645),
    "Brookfield, Vermont": (44.04, -72.60),
    "Chilmark, Massachusetts": (41.343, -70.745),
    "Brighton, Vermont": (44.81, -71.88),                      # Island Pond
    "Stowe, Vermont": (44.465, -72.685),
    "Mendon, Vermont": (43.65, -72.92),
    "Lincoln, Vermont": (44.10, -72.99),
    "Westfield, Vermont": (44.88, -72.42),
    "Starksboro, Vermont": (44.23, -73.06),
}


def norm(s):
    s = unicodedata.normalize("NFKD", s.strip().lower())
    return "".join(ch for ch in s if not unicodedata.combining(ch))


def main():
    rows = list(csv.DictReader(open(os.path.join(HERE, "data/activities.csv"), encoding="utf-8")))
    counts = collections.Counter(r["location_summary"].strip() for r in rows)
    counts.pop("", None)

    gaz = collections.defaultdict(list)
    path = os.path.join(os.path.dirname(reverse_geocoder.__file__), "rg_cities1000.csv")
    for g in csv.DictReader(open(path, encoding="utf-8")):
        gaz[norm(g["name"])].append(g)

    out, unresolved = [], []
    for place, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        if place in MANUAL:
            lat, lon = MANUAL[place]
            out.append((place, n, lat, lon, "manual")); continue
        name, _, region = place.rpartition(",")
        name, region = name.strip(), region.strip()
        cands = gaz.get(norm(name), [])
        if region in US_STATES:
            cands = [g for g in cands if g["cc"] == "US" and g["admin1"] == region]
        elif region in COUNTRY:
            cands = [g for g in cands if g["cc"] == COUNTRY[region]]
        else:
            cands = []
        if cands:
            g = cands[0]
            out.append((place, n, float(g["lat"]), float(g["lon"]), "gazetteer"))
        else:
            unresolved.append((place, n))

    with open(os.path.join(HERE, "data/places.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["location_summary", "n", "lat", "lon", "method"]); w.writerows(out)

    print(f"{len(out)} places resolved ({sum(r[1] for r in out)} activities); "
          f"methods: {collections.Counter(r[4] for r in out)}")
    for p, n in unresolved:
        print("UNRESOLVED", n, p)
    sys.exit(1 if unresolved else 0)


if __name__ == "__main__":
    main()
