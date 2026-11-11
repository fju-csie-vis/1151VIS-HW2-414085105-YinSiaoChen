"""
 Reproduce the selected 2025 daily AQI dataset using Python's standard library.
 Validating and processing the bundled official source archives offline by default.
"""

#!/usr/bin/env python3


import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import math
from pathlib import Path
import re
import statistics
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist" / "data"
RAW = OUT / "raw"
START = dt.date(2025, 1, 1)
END = dt.date(2025, 12, 31)
STATIONS = [("15", "松山"), ("24", "新竹"), ("31", "忠明"),
            ("42", "嘉義"), ("56", "前金"), ("63", "花蓮")]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")


def read_archive(source):
    """Verify the stored SHA-256 and the provider's per-CSV MD5 checksums."""
    payload = (RAW / source["filename"]).read_bytes()
    if sha256(payload) != source["sha256"]:
        raise ValueError(f"Source SHA-256 mismatch: {source['filename']}")
    rows, members = [], []
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        hashes = {}
        for line in archive.read("hash.txt").decode("utf-8-sig").splitlines():
            match = re.fullmatch(r"(.+)：([0-9a-f]{32})，演算法：MD5", line.strip())
            if match:
                hashes[match[1]] = match[2]
        for filename in sorted(archive.namelist()):
            if not filename.endswith(".csv"):
                continue
            contents = archive.read(filename)
            if hashlib.md5(contents).hexdigest() != hashes.get(filename):
                raise ValueError(f"Provider MD5 mismatch: {filename}")
            records = list(csv.DictReader(io.StringIO(contents.decode("utf-8-sig"))))
            rows.extend(records)
            members.append({"filename": filename, "rows": len(records),
                            "sha256": sha256(contents),
                            "providerMd5": hashes[filename], "md5Verified": True})
    return rows, members


def parse_aqi(value):
    """Empty, nonnumeric, nonfinite and negative sentinel values are missing."""
    try:
        number = float(value.strip())
    except (ValueError, AttributeError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return int(number) if number.is_integer() else number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true",
                        help="Refresh the public source ZIP files before processing.")
    args = parser.parse_args()
    sources_path = RAW / "sources.json"
    sources = json.loads(sources_path.read_text(encoding="utf-8"))
    if args.download:
        """Refresh those public archives first, recording timestamps and hashes."""
        for source in sources:
            request = urllib.request.Request(
                source["downloadUrl"],
                data=json.dumps(source["request"]).encode("utf-8"),
                headers={"Content-Type": "application/json", "Referer": source["datasetUrl"]},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read()
            if not zipfile.is_zipfile(io.BytesIO(payload)):
                raise ValueError(f"Expected a ZIP archive for {source['datasetId']}")
            (RAW / source["filename"]).write_bytes(payload)
            source.update(sha256=sha256(payload), bytes=len(payload),
                          retrievedAt=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"))
            print(f"Downloaded {source['datasetId']}: {len(payload):,} bytes")
        write_json(sources_path, sources)

    daily_source = next(s for s in sources if s["datasetId"] == "AQX_P_434")
    station_source = next(s for s in sources if s["datasetId"] == "AQX_P_07")
    raw_rows, daily_members = read_archive(daily_source)
    station_rows, station_members = read_archive(station_source)
    station_info = {r["siteid"]: r for r in station_rows}
    wanted = dict(STATIONS)
    dates = [START + dt.timedelta(days=i) for i in range((END - START).days + 1)]
    values = {}
    duplicate_count = invalid_count = selected_count = 0
    for row in raw_rows:
        site_id = row["siteid"].strip()
        if site_id not in wanted:
            continue
        date = dt.date.fromisoformat(row["monitordate"].strip())
        if not START <= date <= END:
            continue
        if row["sitename"].strip() != wanted[site_id]:
            raise ValueError(f"Unexpected station name for {site_id}: {row['sitename']}")
        selected_count += 1
        value = parse_aqi(row["aqi"])
        invalid_count += value is None
        key = (date.isoformat(), site_id)
        if key in values:
            if values[key] != value:
                raise ValueError(f"Conflicting duplicate, manual review required: {key}")
            duplicate_count += 1
        else:
            values[key] = value

    cleaned = []
    absent_count = 0
    for date in dates:
        for site_id, name in STATIONS:
            key = (date.isoformat(), site_id)
            absent_count += key not in values
            value = values.get(key)
            cleaned.append({"date": date.isoformat(), "siteId": site_id,
                            "siteName": name, "aqi": "" if value is None else value})
    output_path = OUT / "aqi-2025.csv"
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["date", "siteId", "siteName", "aqi"],
                                lineterminator="\n")
        writer.writeheader()
        writer.writerows(cleaned)

    stations = []
    for site_id, name in STATIONS:
        info = station_info[site_id]
        if info["sitename"] != name:
            raise ValueError(f"Station metadata mismatch: {site_id}")
        rows = [r for r in cleaned if r["siteId"] == site_id]
        valid = [r["aqi"] for r in rows if r["aqi"] != ""]
        maximum = max(valid) if valid else None
        above = sum(v > 100 for v in valid)
        stations.append({
            "id": site_id, "name": name, "englishName": info["siteengname"],
            "region": info["areaname"], "regionSource": "官方 AQX_P_07 空品區欄位",
            "county": info["county"], "township": info["township"],
            "type": info["sitetype"],
            "longitude": float(info["twd97lon"]), "latitude": float(info["twd97lat"]),
            "coordinateReference": "TWD97（依官方欄位名稱）",
            "validDays": len(valid), "missingDays": len(rows) - len(valid),
            "coverage": len(valid) / len(rows), "coveragePct": round(len(valid) / len(rows) * 100, 4),
            "median": statistics.median(valid) if valid else None,
            "above100Days": above,
            "above100Ratio": above / len(valid) if valid else None,
            "above100Pct": round(above / len(valid) * 100, 4) if valid else None,
            "max": maximum,
            "peakDates": [r["date"] for r in rows if r["aqi"] == maximum],
            "missingDates": [r["date"] for r in rows if r["aqi"] == ""],
        })
    if any(s["coverage"] < 0.9 for s in stations):
        raise ValueError("A selected station has less than 90% valid-day coverage")

    metadata = {
        "title": "2025 年台灣六測站日 AQI",
        "datasetId": "AQX_P_434",
        "sourceUrl": daily_source["datasetUrl"],
        "stationSourceUrl": station_source["datasetUrl"],
        "publisher": "環境部",
        "license": "政府資料開放授權條款第 1 版",
        "licenseUrl": "https://data.gov.tw/license",
        "retrievedAt": max(s["retrievedAt"] for s in sources),
        "period": {"start": START.isoformat(), "end": END.isoformat(), "expectedDays": len(dates)},
        "unit": "AQI（無單位指標）",
        "columns": {"date": "監測日期 YYYY-MM-DD", "siteId": "官方測站編號（字串）",
                    "siteName": "官方測站名稱", "aqi": "官方日 AQI；空欄為缺失"},
        "stations": stations,
        "selectionRationale": "選取北部、竹苗、中部、雲嘉南、高屏、花東各一個一般站，兼顧地理涵蓋與年度資料完整度；非全臺代表性抽樣。",
        "stationMetadataNote": "測站名稱、縣市、空品區、類別與座標為本次下載之 AQX_P_07 快照；不為 2025 年每一天的歷史測站配置。",
        "cleaning": {
            "rawRows": len(raw_rows), "selectedSourceRows": selected_count,
            "outOfScopeRows": len(raw_rows) - selected_count,
            "identicalDuplicatesRemoved": duplicate_count,
            "conflictingDuplicates": 0,
            "selectedInvalidValues": invalid_count,
            "insertedMissingRows": absent_count,
            "outputRows": len(cleaned),
            "validRows": sum(r["aqi"] != "" for r in cleaned),
            "missingRows": sum(r["aqi"] == "" for r in cleaned),
            "allStationsMissingDates": [d.isoformat() for d in dates
                                        if all(values.get((d.isoformat(), sid)) is None for sid, _ in STATIONS)],
            "rules": [
                "直接採用 AQX_P_434 的官方「日 AQI」，不對「小時 AQI」取平均值。",
                "以官方 siteid 篩選六站；以測站編號與日期作為唯一鍵，檢查名稱一致性。",
                "相同鍵且數值相同才去除重複；相同鍵而數值衝突會停止處理並要求人工查核。",
                "空字串、無法解析、非有限數與負值標記視為缺失；不補零、不插值。",
                "建立每站每日的完整日曆格線，來源缺列保留空 AQI。",
                "中位數與 AQI > 100 日數比例只使用有效日；覆蓋率以 365 日為分母。",
            ],
        },
        "outputSha256": sha256(output_path.read_bytes()),
        "sources": [dict(daily_source, members=daily_members),
                    dict(station_source, members=station_members)],
        "limitations": [
            "測站數值描述該測站觀測，不等同於縣市平均或全臺平均。",
            "各站同時升高只是共同變化，不能僅憑 AQI 推論污染來源或因果關係。",
            "本專題為固定歷史資料快照，不提供即時空氣品質。",
            "副指標不是污染物濃度；此清理結果僅使用 AQI，不混用 PM2.5 濃度與副指標。",
        ],
    }
    write_json(OUT / "metadata.json", metadata)
    csv_file = (OUT / "aqi-2025.csv").read_text(encoding="utf-8-sig")
    bundle = json.dumps({'csv': csv_file, 'metadata': metadata}, ensure_ascii=False, separators=(',', ':'))
    (OUT / "aqi-data.js").write_text("// Generated from the verified CSV and metadata. Do not edit.\nwindow.AQI_BUNDLE = " + bundle + ";\n", 
                                     encoding="utf-8")
    print(f"Wrote {len(cleaned):,} rows ({metadata['cleaning']['validRows']:,} valid; "
          f"{metadata['cleaning']['missingRows']} missing). SHA-256: {metadata['outputSha256']}")
    for station in stations:
        print(f"{station['name']} ({station['id']}): median {station['median']}; "
              f">100 {station['above100Days']}/{station['validDays']} "
              f"({station['above100Pct']:.2f}%); peak {station['max']} on {station['peakDates']}")


if __name__ == "__main__":
    main()
