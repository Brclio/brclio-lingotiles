#!/usr/bin/env python3
"""Reproducibly build/validate the bundled 100,000-entry English vocabulary.

No package install or translation service is required. The immutable ECDICT
source is downloaded into the gitignored output/ directory, then hash checked.
Run: python3 scripts/build-vocabulary.py [--check] [--source /path/ecdict.csv]
"""

from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "public/vocabulary"
REVISION = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
SOURCE_SHA256 = "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf"
SOURCE_URL = f"https://raw.githubusercontent.com/skywind3000/ECDICT/{REVISION}/ecdict.csv"
TARGET = 100_000
MAX_CHUNK_BYTES = 880_000
MAX_CHUNK_ROWS = 2_000
STAGES = [
    ("primary", "小学基础"),
    ("junior", "初中进阶"),
    ("senior", "高中提升"),
    ("cet4", "大学四级"),
    ("cet6", "大学六级"),
    ("advanced", "大学拓展"),
]
POS_MAP = {
    "n": "n.", "v": "v.", "vt": "v.", "vi": "v.", "aux": "v.",
    "a": "adj.", "adj": "adj.", "ad": "adv.", "adv": "adv.",
    "pron": "pron.", "prep": "prep.", "conj": "conj.", "num": "num.",
    "art": "art.", "interj": "interj.", "int": "interj.",
}
SENSE = re.compile(r"(?:^|\n)\s*(n|v|vt|vi|aux|a|adj|ad|adv|pron|prep|conj|num|art|interj|int)\.\s*(.*)")
HAN = re.compile(r"[\u4e00-\u9fff]")
UNSUITABLE = re.compile(
    r"人名|姓氏|地名|男子名|女子名|男名|女名|姓名|公司|商标|牌手表|首都|港市|城市|古希腊的一个地方|全名|简称|缩略|缩写|abbr\."
)
INFLECTION = re.compile(r"(?:的|之)(?:复数|名词复数|动词|变形|变体|过去式|过去分词|现在分词|第三人称单数|比较级|最高级)|复数形式|单数形式")

# Editorial starter list of familiar everyday topics, NOT an official syllabus.
# Only spellings actually attested with a suitable POS + Chinese sense survive.
PRIMARY = set("""
I you he she it we they me him her us them my your his its our their mine yours
an the be of once best others including center centre oh yeah
this that these those what who where when why how which whose yes no not all
one two three four five six seven eight nine ten eleven twelve thirteen fourteen
fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty
seventy eighty ninety hundred first second third last next
apple banana orange pear peach grape lemon melon strawberry watermelon fruit
rice bread cake egg milk water tea coffee juice food breakfast lunch dinner
fish meat beef chicken pork potato tomato carrot onion vegetable sugar salt
ice cream sweet hungry thirsty eat drink cook wash cut taste
mother father parent family sister brother baby child son daughter grandma grandpa
grandmother grandfather aunt uncle cousin friend boy girl man woman teacher student
school classroom class lesson homework book notebook pen pencil ruler eraser bag
desk chair board paper picture map letter word sentence story question answer test
read write spell draw sing dance speak talk listen learn study teach ask tell say
name age birthday number morning afternoon evening night day week month year today
tomorrow yesterday time clock watch minute hour now soon early late always often
sometimes never again before after then Monday Tuesday Wednesday Thursday Friday
Saturday Sunday January February March April May June July August September
October November December spring summer autumn winter season sunny rainy windy
cloudy snowy hot warm cool cold weather rain snow wind cloud sun moon star sky
red yellow blue green black white brown pink purple colour color light dark
big small large little long short tall high low fat thin old young new good bad
nice fine great beautiful happy sad angry tired sick well clean dirty busy free
easy difficult right wrong fast slow quick quiet loud kind friendly strong weak
head face hair eye ear nose mouth tooth teeth neck arm hand finger leg foot feet
body heart back nose tooth smile laugh cry sleep wake stand sit walk run jump swim
fly ride drive play stop start go come get give take bring buy sell open close
put make do have has can could may must will would should like love want need help
find look see watch know think understand remember forget try use work live grow
room house home kitchen bedroom bathroom floor wall door window bed table sofa
lamp cup glass plate bowl spoon fork knife bottle box basket ball toy doll kite
car bus train plane bike bicycle boat ship taxi truck road street park zoo garden
shop store market hospital hotel library cinema museum farm town village city
bank station airport bridge school playground office restaurant beach island
mountain river lake sea ocean tree flower grass leaf forest hill rock stone sand
animal cat dog bird duck hen cow pig sheep horse goat rabbit mouse lion tiger bear
elephant monkey panda fox wolf snake frog turtle butterfly bee ant pet tail wing
shirt skirt dress coat jacket sweater shoe sock hat cap trousers pants shorts
clothes umbrella wear bag pocket football basketball tennis sport game team win
lose music art science English Chinese maths math subject history computer phone
camera television radio internet photo picture film movie holiday weekend travel
visit meet welcome thank sorry please hello goodbye hi bye dear enjoy fun party
gift present money dollar price cheap expensive shop buy left right front behind
under over above below beside between near far inside outside here there everywhere
up down in out on off into from to at by for with without about and or but because
if so than as until together alone only also too very really quite more most much
many some any every each both other another same different full empty ready sure
safe careful slowly quickly happily easily loudly quietly usually sometimes
fresh tidy simple useful brave peaceful patient proud calm curious share prepare
protect discover follow corner journey idea hope dream world country people life
""".split())
PRIMARY_LOWER = {word.lower() for word in PRIMARY}

# These introductory senses are explicitly present in their source POS section.
# This avoids teaching a less familiar homonym first (e.g. still = a distillery).
# The builder verifies every preference against the extracted source senses.
PREFERRED_SENSES = {
    "in": ("prep.", "在...之内"), "can": ("v.", "能"),
    "could": ("v.", "可以"), "may": ("v.", "可以"),
    "must": ("v.", "必须"), "will": ("v.", "将"),
    "would": ("v.", "将"), "should": ("v.", "应该"),
    "just": ("adv.", "刚刚"), "even": ("adv.", "甚至"),
    "still": ("adv.", "仍然"), "own": ("adj.", "自己的"),
    "mean": ("v.", "意谓"), "leave": ("v.", "离开"),
    "like": ("v.", "喜欢"), "kind": ("adj.", "亲切的"),
    "right": ("adj.", "正确的"), "well": ("adv.", "很好地"),
    "one": ("num.", "一"), "many": ("adj.", "许多的"),
    "much": ("adj.", "很多的"), "present": ("n.", "礼品"),
}

# The original six chapters must remain searchable without double counting.
CURATED = set("""
apple leaf water grow fresh slowly morning habit prepare share tidy simple often
together corner station bridge explore follow crowded nearby straight joy courage
trust worry proud calm curious grateful gently suddenly idea sketch focus create
improve patient useful unique clearly carefully journey island horizon discover
protect wonder distant brave peaceful finally abroad forward
""".split())


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encoded(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def source_path(requested: str | None) -> Path:
    path = Path(requested) if requested else ROOT / "output/vocabulary-source/ecdict.csv"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading pinned ECDICT revision {REVISION}…", flush=True)
        with urllib.request.urlopen(SOURCE_URL, timeout=90) as response:
            path.write_bytes(response.read())
    actual = digest(path.read_bytes())
    if actual != SOURCE_SHA256:
        raise ValueError(f"Source SHA-256 mismatch: expected {SOURCE_SHA256}, got {actual}")
    return path


def frequency(row: dict[str, str]) -> int:
    ranks = [int(row[key]) for key in ("bnc", "frq") if row[key].isdigit() and int(row[key]) > 0]
    return min(ranks) if ranks else 1_000_000 + len(row["word"]) * 1_000


def selected_sense(translation: str, word: str = "") -> tuple[str, str] | None:
    senses: list[tuple[str, str]] = []
    for match in SENSE.finditer(translation):
        # Drop usage/domain annotations and parenthesized notes, keeping the full
        # unchanged translation separately. Never infer POS from a word ending.
        body = re.sub(r"\[[^\]]*\]|\([^)]*\)|（[^）]*）|【[^】]*】", "", match[2]).strip()
        for clause in re.split(r"[,，;；\n]", body):
            meaning = clause.strip(" .。、；;：:")
            if (
                1 <= len(meaning) <= 20 and HAN.search(meaning)
                and not re.search(r"[A-Za-z]|[<>=]|的(?:复数|过去|第三人称|比较级|最高级)|缩写|变体|异体|的异形|讹", meaning)
            ):
                senses.append((POS_MAP[match[1]], meaning))
    preference = PREFERRED_SENSES.get(word.lower())
    if preference:
        if preference not in senses:
            raise ValueError(f"Preferred sense for {word} is absent from source: {preference}")
        return preference
    return senses[0] if senses else None


def stage_for(word: str, tags: list[str], rank: int) -> str:
    if word.lower() in PRIMARY_LOWER:
        return "primary"
    for tag, stage in (("zk", "junior"), ("gk", "senior"), ("cet4", "cet4"), ("cet6", "cet6")):
        if tag in tags:
            return stage
    # Source exam tags are incomplete. Frequency fallback prevents common,
    # untagged words from appearing only in the university extension stage.
    for threshold, stage in ((1_500, "junior"), (6_000, "senior"), (12_000, "cet4"), (20_000, "cet6")):
        if rank <= threshold:
            return stage
    return "advanced"


def build(path: Path) -> None:
    candidates: dict[str, dict] = {}
    rejected: collections.Counter[str] = collections.Counter()
    with path.open(encoding="utf-8", newline="") as stream:
        for source in csv.DictReader(stream):
            word = source["word"].strip()
            lower = word.lower()
            # No digit strings, acronyms, formulas, suffixes, apostrophes or
            # phrases. Only familiar starter words may retain source capitals.
            if not re.fullmatch(r"[a-z]{2,24}", word) and not (word in PRIMARY and re.fullmatch(r"[A-Za-z]{1,24}", word)):
                rejected["spelling"] += 1
                continue
            if re.fullmatch(r"(.)\1{2,}", lower) or re.search(r"[^aeiouy]{5}", lower) or lower in {"john", "peter"}:
                rejected["malformed"] += 1
                continue
            translation = source["translation"].replace("\\n", "\n").replace("\\r", "").strip()
            if not translation or len(translation) > 1_200 or UNSUITABLE.search(translation) or (lower not in PRIMARY_LOWER and INFLECTION.search(translation)):
                rejected["definition_quality"] += 1
                continue
            sense = selected_sense(translation, word)
            if not sense:
                rejected["no_attested_short_sense"] += 1
                continue
            tags = source["tag"].split()
            phonetic = source["phonetic"].strip()
            rank = frequency(source)
            record = {
                "id": f"dict:{lower}", "word": word, "pos": sense[0], "meaning": sense[1],
                "phonetic": f"/{phonetic}/" if phonetic else "", "definition": translation,
                "tags": tags, "stageId": stage_for(word, tags, rank), "rank": rank,
                "example": "", "exampleZh": "",
            }
            existing = candidates.get(lower)
            if existing is None or (record["rank"], word) < (existing["rank"], existing["word"]):
                candidates[lower] = record
    if CURATED - candidates.keys():
        raise ValueError(f"Missing preserved original words: {sorted(CURATED - candidates.keys())}")
    if len(candidates) < TARGET:
        raise ValueError(f"Only {len(candidates)} eligible records; refusing to fabricate entries")
    # Preserve all school-tagged/starter/original words before selecting the most
    # frequent (or shortest if unranked) remaining extension entries.
    ordered = sorted(candidates.values(), key=lambda r: (
        0 if r["word"].lower() in CURATED or r["stageId"] != "advanced" else 1,
        r["rank"], r["word"].lower(),
    ))[:TARGET]
    DEST.mkdir(parents=True, exist_ok=True)
    # Only generated JSON files inside this dedicated directory are replaced.
    for existing in DEST.glob("*.json"):
        existing.unlink()
    manifest: dict = {
        "version": 1, "total": TARGET, "curatedWordCount": len(CURATED),
        "source": {
            "name": "ECDICT", "url": "https://github.com/skywind3000/ECDICT",
            "revision": REVISION, "csvSha256": SOURCE_SHA256, "license": "MIT",
        },
        "stages": [], "lookupFiles": {},
    }
    lookup: dict[str, dict[str, list[int]]] = collections.defaultdict(dict)
    for stage_index, (stage_id, title) in enumerate(STAGES):
        records = sorted((r for r in ordered if r["stageId"] == stage_id), key=lambda r: (r["rank"], r["word"].lower()))
        chunks: list[dict] = []
        start = 0
        while start < len(records):
            end, byte_count = start, 3
            while end < len(records) and end - start < MAX_CHUNK_ROWS:
                row_bytes = len(encoded(records[end])) + 1
                if end > start and byte_count + row_bytes > MAX_CHUNK_BYTES:
                    break
                byte_count += row_bytes
                end += 1
            chunk_rows = records[start:end]
            filename = f"{stage_id}-{len(chunks) + 1:03}.json"
            payload = encoded(chunk_rows)
            (DEST / filename).write_bytes(payload)
            for row_index, row in enumerate(chunk_rows):
                spelling = row["word"].lower()
                lookup[spelling[0]][spelling] = [stage_index, len(chunks), row_index]
            chunks.append({"path": f"/vocabulary/{filename}", "count": len(chunk_rows), "start": start, "bytes": len(payload), "sha256": digest(payload)})
            start = end
        manifest["stages"].append({"id": stage_id, "title": title, "count": len(records), "chunks": chunks})
    for initial, entries in sorted(lookup.items()):
        filename = f"lookup-{initial}.json"
        (DEST / filename).write_bytes(encoded(dict(sorted(entries.items()))))
        manifest["lookupFiles"][initial] = f"/vocabulary/{filename}"
    manifest["statistics"] = {
        "partsOfSpeech": {pos: sum(r["pos"] == pos for r in ordered) for pos in dict.fromkeys(POS_MAP.values())},
        "spellings": {"singleWord": TARGET, "hyphenated": 0, "phrase": 0},
        "withPhonetic": sum(bool(r["phonetic"]) for r in ordered),
        "withFrequency": sum(r["rank"] < 1_000_000 for r in ordered),
        "eligibleSourceEntries": len(candidates),
    }
    (DEST / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"stages": {s["id"]: s["count"] for s in manifest["stages"]}, "statistics": manifest["statistics"], "rejected": rejected}, ensure_ascii=False, indent=2))
    verify()


def verify() -> None:
    manifest = json.loads((DEST / "manifest.json").read_text(encoding="utf-8"))
    ids: set[str] = set()
    spellings: set[str] = set()
    positions: dict[str, list[int]] = {}
    counts: collections.Counter[str] = collections.Counter()
    for stage_index, stage in enumerate(manifest["stages"]):
        stage_count = 0
        previous_rank = -1
        for chunk_index, chunk in enumerate(stage["chunks"]):
            payload = (ROOT / "public" / chunk["path"].lstrip("/")).read_bytes()
            assert digest(payload) == chunk["sha256"], chunk["path"]
            assert len(payload) == chunk["bytes"] < MAX_CHUNK_BYTES
            rows = json.loads(payload)
            assert len(rows) == chunk["count"] and chunk["start"] == stage_count
            for row_index, row in enumerate(rows):
                spelling = row["word"].lower()
                assert row["id"] == f"dict:{spelling}" and row["id"] not in ids
                assert spelling not in spellings and re.fullmatch(r"[A-Za-z]{1,24}", row["word"])
                assert row["pos"] in POS_MAP.values() and HAN.search(row["meaning"])
                assert selected_sense(row["definition"], row["word"]) == (row["pos"], row["meaning"])
                assert row["stageId"] == stage["id"] and row["rank"] >= previous_rank
                assert isinstance(row["tags"], list) and row["example"] == row["exampleZh"] == ""
                previous_rank = row["rank"]
                ids.add(row["id"])
                spellings.add(spelling)
                counts[row["pos"]] += 1
                positions[spelling] = [stage_index, chunk_index, row_index]
            stage_count += len(rows)
        assert stage_count == stage["count"] and stage_count > 0
    lookup_count = 0
    for initial, filename in manifest["lookupFiles"].items():
        entries = json.loads((ROOT / "public" / filename.lstrip("/")).read_text(encoding="utf-8"))
        for spelling, location in entries.items():
            assert spelling[0] == initial and positions[spelling] == location
        lookup_count += len(entries)
    assert len(ids) == len(spellings) == lookup_count == manifest["total"] == TARGET
    assert CURATED <= spellings and manifest["curatedWordCount"] == len(CURATED) == 54
    assert dict(counts) == {pos: count for pos, count in manifest["statistics"]["partsOfSpeech"].items() if count}
    print(f"Verified {TARGET:,} unique, source-attested records; all 54 original words, chunk checksums, stage counts and lookup locations pass.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="Path to the pinned source CSV (must match the expected SHA-256)")
    parser.add_argument("--check", action="store_true", help="Validate bundled data without downloading or rewriting anything")
    args = parser.parse_args()
    verify() if args.check else build(source_path(args.source))
