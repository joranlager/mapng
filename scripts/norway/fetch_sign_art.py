# fetch_sign_art.py - fetch pictures of the Norwegian road signs for MapNG's Norwegian sign plates.
#
# The pictures come from Wikimedia Commons (files named "Norwegian-road-sign-<number>..."), as 256 px PNGs.
# They are saved to public/norway_signs/<number>.png with an index.json the app reads
# (services/norway/norwaySigns.js). Each file's licence, as Commons states it, is recorded in the index.
#
# Standard library only. Run from anywhere: python scripts/norway/fetch_sign_art.py
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
UA = "MapNG-Norway-signs/1.0 (BeamNG map tool; fetches road sign pictures once)"
PREFIX = "Norwegian-road-sign-"
WIDTH = 256
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "norway_signs"))
# Sign numbers seen in NVDB (central Trondheim), to report how many have a picture.
WANTED = ["202", "204", "206", "302", "306.1", "330.1", "362", "366", "368", "372", "376.1", "376.2", "378.1", "378.2",
          "402.3", "402.4", "404.1", "508.2", "516", "520", "521", "522", "526.1", "526.2", "527.3", "552",
          "701.1", "751", "753", "755", "806", "807.3", "807.6", "807.8", "808", "828.1", "906V", "108", "110"]


def get(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def list_files():
    """Every Commons file whose name starts with the prefix: [(title, thumb url, w, h, licence)]."""
    out = []
    params = {
        "action": "query", "format": "json", "generator": "allimages", "gaiprefix": PREFIX, "gailimit": "200",
        "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": str(WIDTH),
        "iiextmetadatafilter": "LicenseShortName",
    }
    cont = {}
    for _ in range(40):
        data = json.loads(get(f"{API}?{urllib.parse.urlencode({**params, **cont})}"))
        for page in (data.get("query", {}).get("pages", {}) or {}).values():
            info = (page.get("imageinfo") or [{}])[0]
            thumb = info.get("thumburl")
            if not thumb:
                continue
            licence = ((info.get("extmetadata") or {}).get("LicenseShortName") or {}).get("value", "")
            out.append((page.get("title", ""), thumb, info.get("thumbwidth"), info.get("thumbheight"), licence))
        cont = data.get("continue") or {}
        if not cont:
            break
        time.sleep(0.2)
    return out


def code_of(title):
    """'File:Norwegian-road-sign-526.2.svg' -> ('526.2', rest). A '.0' sub-number means the plain sign."""
    name = re.sub(r"^File:", "", title)
    name = re.sub(r"\.(svg|png|gif|jpe?g)$", "", name, flags=re.I)
    if not name.startswith(PREFIX):
        return None, name
    rest = name[len(PREFIX):]
    m = re.match(r"^(\d{3})(?:\.(\d+))?([A-Za-z])?(?:[-_ .]+(.*))?$", rest)
    if not m:
        return None, rest
    main, sub, letter, tail = m.group(1), m.group(2), m.group(3) or "", (m.group(4) or "").strip()
    code = main if sub in (None, "0") else f"{main}.{sub}"
    code += letter.upper()
    # a number after the sign's own (a speed limit's value, a variant): kept as a further sub-number
    if tail:
        t = re.match(r"^(\d{1,3})$", tail)
        code = f"{code}.{t.group(1)}" if t else None
    return code, rest


def png_size(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", data[16:24])


def main():
    os.makedirs(OUT, exist_ok=True)
    print(f"Saving to {OUT}")
    try:
        files = list_files()
    except Exception as e:
        print(f"Could not list the files on Wikimedia Commons: {e}")
        return 1
    print(f"Files on Commons starting with '{PREFIX}': {len(files)}")
    if not files:
        print("None found. Paste this output back.")
        return 1

    chosen = {}
    skipped = []
    for title, thumb, w, h, licence in sorted(files):
        code, rest = code_of(title)
        if not code:
            skipped.append(rest)
            continue
        # (the plain SVG wins over other files of the same number)
        if code in chosen and not title.lower().endswith(".svg"):
            continue
        chosen[code] = (title, thumb, licence)
    print(f"Sign numbers recognised: {len(chosen)}; file names not understood: {len(skipped)}")
    if skipped:
        print("  not understood (first 40): " + "; ".join(skipped[:40]))

    signs = {}
    failed = 0
    for i, (code, (title, thumb, licence)) in enumerate(sorted(chosen.items())):
        name = re.sub(r"[^0-9A-Za-z.]", "_", code) + ".png"
        path = os.path.join(OUT, name)
        try:
            if os.path.exists(path) and os.path.getsize(path) > 100:
                data = open(path, "rb").read()
            else:
                data = get(thumb, binary=True)
                with open(path, "wb") as f:
                    f.write(data)
                time.sleep(0.15)
            size = png_size(data)
            if not size:
                failed += 1
                os.remove(path)
                continue
            signs[code] = {"file": name, "w": size[0], "h": size[1], "source": title, "licence": licence}
        except Exception as e:
            failed += 1
            if failed <= 5:
                print(f"  failed: {title}: {e}")
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(chosen)} ...", file=sys.stderr)

    index = {"source": "Wikimedia Commons", "prefix": PREFIX, "width": WIDTH, "signs": signs}
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)

    print(f"Pictures saved: {len(signs)}; failed: {failed}")
    licences = {}
    for s in signs.values():
        licences[s["licence"] or "(not stated)"] = licences.get(s["licence"] or "(not stated)", 0) + 1
    print("Licences as Commons states them: " + "; ".join(f"{k} x{n}" for k, n in sorted(licences.items(), key=lambda kv: -kv[1])))

    def resolves(code):
        key = code
        for _ in range(6):
            if key in signs:
                return key
            if re.search(r"[A-Za-z]$", key):
                key = key[:-1]
            elif "." in key:
                key = key[:key.rindex(".")]
            else:
                return None
        return None

    have = [(c, resolves(c)) for c in WANTED]
    print(f"Of {len(WANTED)} sign numbers seen in NVDB, with a picture: {sum(1 for _, k in have if k)}")
    print("  without: " + (", ".join(c for c, k in have if not k) or "none"))
    print("  through a plainer number: " + (", ".join(f"{c}->{k}" for c, k in have if k and k != c) or "none"))
    print("Sample of sign numbers found: " + ", ".join(sorted(signs)[:60]))
    print("Sample of file names: " + "; ".join(v["source"] for _, v in sorted(signs.items())[:12]))
    speed = sorted(k for k in signs if k.startswith("362"))
    print("Speed limit pictures (362...): " + (", ".join(speed) or "none"))
    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
