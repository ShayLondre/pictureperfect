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
SKIP_CODES = {"ADM3", "ADM4", "ADM5", "ADMD", "ADM1H", "ADM2H", "ADM3H", "ADM4H", "PCLH",
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
            if p[2] == "link" and "en.wikipedia.org" in p[3]:
                wiki.add(p[1])
            elif p[2] == "en" and (len(p) < 5 or p[4] == "1") and p[1] not in english:
                english[p[1]] = p[3]
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

n = 0
with zipfile.ZipFile(all_zip) as z, gzip.open(out, "wt", encoding="utf-8", compresslevel=9) as w:
    with z.open("allCountries.txt") as raw:
        for line in io.TextIOWrapper(raw, encoding="utf-8"):
            p = line.rstrip("\n").split("\t")
            if len(p) < 17 or p[6] not in KEEP_CLASSES or p[7] in SKIP_CODES:
                continue
            gid = p[0]
            if gid not in wiki and not (p[6] == "A" and p[7] in ("ADM1", "PCLI", "PCLD", "TERR")):
                continue
            nm = english.get(gid) or p[1]
            alt = p[2] if p[2] != nm else ""
            try:
                lat, lon = round(float(p[4]), 5), round(float(p[5]), 5)
            except ValueError:
                continue
            cc = p[8]
            elev = p[15] or (p[16] if p[16] not in ("", "-9999") else "")
            w.write("\t".join([nm, alt, str(lat), str(lon), p[7], admin1.get(cc + "." + p[10], ""),
                               countries.get(cc, cc), p[14] or "0", elev]) + "\n")
            n += 1
print("places written:", n)
