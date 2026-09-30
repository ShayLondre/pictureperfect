"""Build the offline place-search list from GeoNames: lakes, bays, islands, anchorages,
mountains, parks, regions, landmarks … — every one that has an English Wikipedia page,
so the list stays small but covers everything people actually search for.

usage: build_places.py allCountries.zip alternateNamesV2.zip admin1CodesASCII.txt countryInfo.txt out.tsv.gz
"""
import gzip
import io
import sys
import zipfile

all_zip, alt_zip, admin1_txt, country_txt, out = sys.argv[1:6]

KEEP_CLASSES = set("HLTSVA")
# for sailors and travellers: every one of these, even without a Wikipedia page
ALWAYS = {"ISL", "ISLS", "ISLET", "ATOL", "ANCH", "BAY", "BAYS", "COVE", "HBR", "MAR", "BCH", "BCHS", "LGN", "RF",
          "CAPE", "STRT", "CHN", "SD"}
WEIGHT = {"PCLI": 5000000, "PCLD": 3000000, "TERR": 2000000, "ADM1": 1000000, "SEA": 800000, "RGN": 400000,
          "ISLS": 150000, "LK": 120000, "ISL": 100000, "MTS": 90000, "BAY": 80000, "GULF": 80000, "ADM2": 60000,
          "PRK": 60000, "MT": 50000, "PK": 50000, "VLC": 50000, "ANCH": 40000, "MAR": 30000, "HBR": 30000}
SKIP_CODES = {"SCH", "SCHC", "SCHT", "TOWR", "RSTN", "RSTP", "HSP", "HSPC", "PO", "BUSTN", "MTRO", "RDJCT","ADM3", "ADM4", "ADM5", "ADMD", "ADM1H", "ADM2H", "ADM3H", "ADM4H", "PCLH",
              "STMI", "WLL", "WLLS", "SPNG", "RSV", "CNL", "DTCH", "DTCHI", "BLDG", "HSE", "FRM", "CMTY"}

wiki = set()
english = {}
with zipfile.ZipFile(alt_zip) as z:
    name = [n for n in z.namelist() if n.startswith("alternateNamesV2") and n.endswith(".txt")][0]
    with z.open(name) as raw:
        for line in io.TextIOWrapper(raw, encoding="utf-8"):
            p = line.rstrip("\n").split("\t")
            if len(p) < 4:
                continue
            if p[2] == "link" and "wikipedia.org" in p[3]:
                wiki.add(p[1])
            elif p[2] == "en" and not (len(p) > 7 and p[7] == "1"):   # English names, not historic ones
                names = english.setdefault(p[1], [])
                if len(p) > 4 and p[4] == "1":
                    names.insert(0, p[3])
                elif len(names) < 4:
                    names.append(p[3])
print("wikipedia-linked places:", len(wiki))

admin1 = {}
with open(admin1_txt, encoding="utf-8") as f:
    for line in f:
        p = line.rstrip("\n").split("\t")
        if len(p) > 1:
            admin1[p[0]] = p[1]
countries = {}
with open(country_txt, encoding="utf-8") as f:
    for line in f:
        if not line.startswith("#"):
            p = line.rstrip("\n").split("\t")
            if len(p) > 4:
                countries[p[0]] = p[4]

rows = []
with zipfile.ZipFile(all_zip) as z:
    with z.open("allCountries.txt") as raw:
        for line in io.TextIOWrapper(raw, encoding="utf-8"):
            p = line.rstrip("\n").split("\t")
            if len(p) < 17 or p[6] not in KEEP_CLASSES or p[7] in SKIP_CODES:
                continue
            gid = p[0]
            if gid not in wiki and p[7] not in ALWAYS and not (p[6] == "A" and p[7] in ("ADM1", "PCLI", "PCLD", "TERR")):
                continue
            en = english.get(gid) or []
            nm = en[0] if en else p[1]
            alts = []
            for a in [p[1], p[2]] + en:
                if a and a != nm and a not in alts:
                    alts.append(a)
            alt = "|".join(alts[:5])
            try:
                lat, lon = round(float(p[4]), 5), round(float(p[5]), 5)
            except ValueError:
                continue
            cc = p[8]
            elev = p[15] or (p[16] if p[16] not in ("", "-9999") else "")
            pop = int(p[14] or 0)
            imp = pop + WEIGHT.get(p[7], 20000 if gid in wiki else 0)
            rows.append((imp, "\t".join([nm, alt, str(lat), str(lon), p[7], admin1.get(cc + "." + p[10], ""),
                                          countries.get(cc, cc), str(pop), elev])))
rows.sort(key=lambda r: -r[0])   # most important first, so a search finds them first
with gzip.open(out, "wt", encoding="utf-8", compresslevel=9) as w:
    for _, line in rows:
        w.write(line + "\n")
print("places written:", len(rows))
