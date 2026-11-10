# fetch_sign_art.py - collect pictures of the Norwegian road signs for MapNG's Norwegian sign plates.
#
# Sources, in this order for each sign number:
#   1. Statens vegvesen, NVDB Datakatalog: object type 96 (Skiltplate), property 5530 (Skiltnummer). Its list of
#      allowed values is the list of sign numbers; a value's picture is taken where the catalogue gives one.
#   2. Skiltforskriften on Lovdata (FOR-2005-10-07-1219): the pictures in the regulation, matched to sign numbers.
#
# Or, with --from <folder>, from a folder already downloaded ("norske_skilt_komplett": skilt_komplett.json with
# its bilder_nvdb and bilder_lovdata folders).
#
# The pictures are saved as they come (PNG, GIF, JPEG, SVG, WebP) to public/norway_signs/<number>.<ext>, with an
# index.json the app reads (services/norway/norwaySigns.js turns them into plate textures).
#
# The script says what it is in its User-Agent and X-Client, and reads Lovdata only if Lovdata's robots.txt
# allows that page. Standard library only.
#
#   python scripts/norway/fetch_sign_art.py                       fetch from NVDB and Lovdata
#   python scripts/norway/fetch_sign_art.py --from <folder>       import a folder already downloaded
#   python scripts/norway/fetch_sign_art.py --no-lovdata          NVDB only
import argparse
import html.parser
import json
import os
import re
import shutil
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

UA = "MapNG-Norway-signs/1.0 (BeamNG map tool; fetches Norwegian road sign pictures once)"
X_CLIENT = "MapNG-Norway-signs"
LOVDATA_URL = "https://lovdata.no/dokument/SF/forskrift/2005-10-07-1219"
NVDB_ENDPOINTS = [
    "https://nvdbapiles.atlas.vegvesen.no/datakatalog/api/v1/vegobjekttyper/96?inkluder=alle",
    "https://nvdbapiles.atlas.vegvesen.no/datakatalog/api/v1/vegobjekttyper/96",
]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "norway_signs"))
EXTENSIONS = (".png", ".gif", ".jpg", ".jpeg", ".svg", ".webp")
CODE = r"[1-9]\d{2}(?:\.\d+)*[A-Za-z]?"
# Sign numbers seen in NVDB (central Trondheim), to report how many have a picture.
WANTED = ["202", "204", "206", "302", "330.1", "362", "366", "368", "372", "376.1", "376.2", "378.1", "378.2",
          "402.3", "402.4", "404.1", "508.2", "516", "520", "521", "522", "526.1", "526.2", "527.3", "552",
          "701.1", "751", "753", "755", "806", "807.3", "807.6", "807.8", "808", "828.1", "906V", "108", "110"]


def get(url, accept="*/*", binary=False, referer=None):
    headers = {"User-Agent": UA, "X-Client": X_CLIENT, "Accept": accept}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


# ---- picture files -------------------------------------------------------------------------------------------

def picture_size(data):
    """(width, height) of a PNG, GIF, JPEG or SVG, or None."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", data[16:24])
        if data[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", data[6:10])
        if data[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return (w, h)
                i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
            return None
        head = data[:4000].decode("utf-8", "replace")
        if "<svg" in head:
            box = re.search(r'viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)', head)
            if box:
                return (float(box.group(1)), float(box.group(2)))
            w = re.search(r'<svg[^>]*\swidth="([\d.]+)', head)
            h = re.search(r'<svg[^>]*\sheight="([\d.]+)', head)
            if w and h:
                return (float(w.group(1)), float(h.group(1)))
    except Exception:
        return None
    return None


def extension_of(name_or_url, data=b""):
    ext = os.path.splitext(urllib.parse.urlparse(name_or_url).path)[1].lower()
    if ext in EXTENSIONS:
        return ".jpg" if ext == ".jpeg" else ext
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"GIF":
        return ".gif"
    if data[:2] == b"\xff\xd8":
        return ".jpg"
    if b"<svg" in data[:4000]:
        return ".svg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def normal_code(code):
    """'100-1', '100_1', ' 906v ' -> '100.1', '906V'; None when it is not a sign number."""
    c = str(code or "").strip().replace("_", ".").replace("-", ".")
    m = re.match(rf"^({CODE})$", c)
    if not m:
        return None
    return re.sub(r"[a-z]$", lambda x: x.group(0).upper(), c)


# ---- 1. NVDB Datakatalog ---------------------------------------------------------------------------------------

def nvdb_signs():
    """{ code: { name, description, enum_id, picture_url } } from the catalogue's allowed values of Skiltnummer."""
    data = None
    for url in NVDB_ENDPOINTS:
        try:
            data = json.loads(get(url, accept="application/json"))
            print(f"[NVDB] Read {url}")
            break
        except Exception as e:
            print(f"[NVDB] {url}: {e}")
    if not isinstance(data, dict):
        return {}
    props = data.get("egenskapstyper") or []
    prop = next((p for p in props if p.get("id") == 5530), None) or next((p for p in props if "skiltnummer" in str(p.get("navn", "")).lower()), None)
    if not prop:
        print("[NVDB] No property 5530 (Skiltnummer) in the answer.")
        return {}
    out = {}
    for v in prop.get("tillatte_verdier") or []:
        name = str(v.get("navn") or "").strip()
        short = str(v.get("kortverdi") or "").strip()
        code = normal_code(short) or normal_code(name.split(" - ")[0]) or normal_code((re.match(rf"^({CODE})", name) or [None, None])[1])
        if not code:
            continue
        picture = v.get("bilde")
        url = None
        if isinstance(picture, dict):
            url = picture.get("url") or picture.get("href")
        elif isinstance(picture, str) and picture.startswith("http"):
            url = picture
        out[code] = {"name": re.sub(r"^[^-]*-\s*", "", name), "description": str(v.get("beskrivelse") or "").strip(), "enum_id": v.get("id"), "picture_url": url}
    print(f"[NVDB] Sign numbers in the catalogue: {len(out)}; with a picture there: {sum(1 for s in out.values() if s['picture_url'])}")
    return out


# ---- 2. Skiltforskriften on Lovdata --------------------------------------------------------------------------------

class RegulationPictures(html.parser.HTMLParser):
    """Every <img> with the text of the element it sits in (table cell, figure, paragraph, list item)."""
    HOLDERS = {"td", "tr", "figure", "p", "li", "article", "div"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.found = []     # [(src, alt/title, the elements it sits in, nearest first)]

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "img":
            src = a.get("src") or a.get("data-src")
            if src:
                self.found.append((src, (a.get("alt") or a.get("title") or "").strip(), self.stack[-3:][::-1]))
        elif tag in self.HOLDERS:
            self.stack.append({"tag": tag, "text": []})

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]["tag"] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        # (text counts for the nearest few holders only: a page-wide <div> says nothing about one picture)
        for holder in self.stack[-3:]:
            if len(holder["text"]) < 400:
                holder["text"].append(data)


def lovdata_signs(known):
    """{ code: { title, picture_url } } from the regulation's pictures. `known`: the sign numbers NVDB lists (may be empty)."""
    robots = urllib.robotparser.RobotFileParser()
    try:
        robots.parse(get("https://lovdata.no/robots.txt").splitlines())
        if not robots.can_fetch(UA, LOVDATA_URL):
            print("[LOVDATA] Lovdata's robots.txt does not allow this page for a script. Skipped.")
            print("          Pictures saved from a browser, or a folder downloaded another way, can be imported with --from.")
            return {}
    except Exception as e:
        print(f"[LOVDATA] robots.txt could not be read ({e}). Skipped.")
        return {}
    try:
        page = get(LOVDATA_URL, accept="text/html")
    except Exception as e:
        print(f"[LOVDATA] The regulation could not be read: {e}")
        print("          A folder downloaded another way can be imported with --from.")
        return {}
    parser = RegulationPictures()
    parser.feed(page)
    print(f"[LOVDATA] Pictures in the regulation: {len(parser.found)}")
    code_re = re.compile(rf"(?<![\d.])({CODE})(?![\d])")
    out = {}
    for src, alt, holders in parser.found:
        url = urllib.parse.urljoin(LOVDATA_URL, src)
        # the text beside the picture: its own cell or paragraph, else the table row around it
        context = ""
        for holder in holders:
            text = " ".join(" ".join(holder["text"]).split())
            if text and len(text) <= 400:
                context = text
                break
        candidates = [normal_code(c) for c in code_re.findall(f"{alt} {context}")]
        from_name = re.search(r"([1-9]\d{2}(?:[._-]\d+)*[A-Za-z]?)", os.path.basename(urllib.parse.urlparse(url).path))
        if from_name:
            candidates.insert(0, normal_code(from_name.group(1)))
        candidates = [c for c in candidates if c]
        # (a number the catalogue knows, when the catalogue was read: "150 m" in a sign's text is not a sign)
        if known:
            candidates = [c for c in candidates if c in known]
        if candidates and candidates[0] not in out:
            out[candidates[0]] = {"title": alt or context[:120], "picture_url": url}
    print(f"[LOVDATA] Sign numbers with a picture: {len(out)}")
    return out


# ---- a folder already downloaded ------------------------------------------------------------------------------------

def imported(folder):
    """[(code, name, source, path)] from a "norske_skilt_komplett" folder: its list, else its picture file names."""
    folder = os.path.abspath(folder)
    rows = []
    listing = os.path.join(folder, "skilt_komplett.json")

    def locate(p):
        if not p:
            return None
        for candidate in (p, os.path.join(folder, p), os.path.join(os.path.dirname(folder), p), os.path.join(folder, os.path.basename(os.path.dirname(p)), os.path.basename(p))):
            if os.path.isfile(candidate):
                return candidate
        return None

    if os.path.isfile(listing):
        for post in json.load(open(listing, encoding="utf-8")):
            code = normal_code(post.get("skiltkode"))
            if not code:
                continue
            name = re.sub(r"^[^-]*-\s*", "", str(post.get("navn_nvdb") or post.get("tittel_lovdata") or ""))
            for source, key in (("NVDB Datakatalog", "lokal_bildefil_nvdb"), ("Skiltforskriften (Lovdata)", "lokal_bildefil_lovdata")):
                path = locate(post.get(key))
                if path:
                    rows.append((code, name, source, path))
    if not rows:
        for sub, source, prefix in (("bilder_nvdb", "NVDB Datakatalog", "nvdb_"), ("bilder_lovdata", "Skiltforskriften (Lovdata)", "lovdata_")):
            d = os.path.join(folder, sub)
            for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
                stem, ext = os.path.splitext(name)
                code = normal_code(stem[len(prefix):] if stem.startswith(prefix) else stem)
                if code and ext.lower() in EXTENSIONS:
                    rows.append((code, "", source, os.path.join(d, name)))
    return rows


# ---- main ------------------------------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Collect Norwegian road sign pictures for MapNG.")
    ap.add_argument("--from", dest="folder", help='a folder already downloaded ("norske_skilt_komplett")')
    ap.add_argument("--no-lovdata", action="store_true", help="do not read Skiltforskriften on Lovdata")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    print(f"Saving to {out_dir}")

    signs = {}
    names = {}

    def keep(code, data, source, origin, name=""):
        if code in signs or not data:
            return False
        ext = extension_of(origin, data)
        if not ext:
            return False
        file = re.sub(r"[^0-9A-Za-z.]", "_", code) + ext
        with open(os.path.join(out_dir, file), "wb") as f:
            f.write(data)
        size = picture_size(data)
        signs[code] = {"file": file, **({"w": size[0], "h": size[1]} if size and size[0] > 0 and size[1] > 0 else {}), "source": source, "name": name or names.get(code, "")}
        return True

    if args.folder:
        rows = imported(args.folder)
        print(f"[IMPORT] Pictures found in {os.path.abspath(args.folder)}: {len(rows)}")
        for code, name, source, path in rows:      # (NVDB's picture of a sign before the regulation's)
            keep(code, open(path, "rb").read(), source, path, name)
    else:
        catalogue = nvdb_signs()
        names.update({c: s["name"] for c, s in catalogue.items()})
        failed = 0
        for code, s in sorted(catalogue.items()):
            if not s["picture_url"]:
                continue
            try:
                keep(code, get(s["picture_url"], accept="image/*", binary=True), "NVDB Datakatalog", s["picture_url"], s["name"])
                time.sleep(0.1)
            except Exception as e:
                failed += 1
                if failed <= 3:
                    print(f"[NVDB] picture of {code}: {e}")
        if not args.no_lovdata:
            regulation = lovdata_signs(set(catalogue))
            for i, (code, s) in enumerate(sorted(regulation.items())):
                if code in signs:
                    continue
                try:
                    keep(code, get(s["picture_url"], accept="image/*", binary=True, referer=LOVDATA_URL), "Skiltforskriften (Lovdata)", s["picture_url"], s["title"])
                    time.sleep(0.3)
                except Exception as e:
                    failed += 1
                    if failed <= 6:
                        print(f"[LOVDATA] picture of {code}: {e}")
                if (i + 1) % 50 == 0:
                    print(f"  {i + 1}/{len(regulation)} ...", file=sys.stderr)
        # the catalogue's own list of sign numbers and names, for reference
        with open(os.path.join(out_dir, "sign_numbers.json"), "w", encoding="utf-8") as f:
            json.dump({c: s["name"] for c, s in sorted(catalogue.items())}, f, ensure_ascii=False, indent=1)

    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"sources": sorted({s["source"] for s in signs.values()}), "signs": dict(sorted(signs.items()))}, f, ensure_ascii=False, indent=1)

    by_source, by_ext = {}, {}
    for s in signs.values():
        by_source[s["source"]] = by_source.get(s["source"], 0) + 1
        ext = os.path.splitext(s["file"])[1]
        by_ext[ext] = by_ext.get(ext, 0) + 1
    print(f"\nPictures saved: {len(signs)}")
    print("  by source: " + ("; ".join(f"{k} {n}" for k, n in by_source.items()) or "none"))
    print("  by format: " + ("; ".join(f"{k} {n}" for k, n in by_ext.items()) or "none"))
    print(f"  without a known size: {sum(1 for s in signs.values() if 'w' not in s)}")

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
    print(f"Of {len(WANTED)} sign numbers seen on the road in NVDB, with a picture: {sum(1 for _, k in have if k)}")
    print("  without: " + (", ".join(c for c, k in have if not k) or "none"))
    print("  through a plainer number: " + (", ".join(f"{c}->{k}" for c, k in have if k and k != c) or "none"))
    print("Sample of sign numbers: " + ", ".join(sorted(signs)[:50]))
    print("Speed limits (362...): " + (", ".join(sorted(k for k in signs if k.startswith("362"))) or "none"))
    if not signs:
        print("\nNo pictures. Paste this output back.")
        return 1
    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
