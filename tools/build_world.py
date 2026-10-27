# -*- coding: utf-8 -*-
"""构建海外城市目录: web/data/world-cities.json

为什么单独一份、不并进 cities.json：cities.json 里每座城市都挂着中国天气网代码和
气象局站号，省份大盘 / 全城市抽屉 / 预抓名单都按它走；海外城市一个都用不上。
所以照 places.json 的路子，只进搜索和 byId，天气全走 Open-Meteo 按坐标取。

中文名用下面的手写表，**不用** geocoding 的 language=zh —— 实测伦敦返回的是繁体「倫敦」。
坐标 / 时区 / 人口取自 Open-Meteo geocoding（GeoNames 数据），按「英文名 + 国家代码」查，
同国多个同名取人口最多的那个；国家中文名取 /v1/get?language=zh 的 country 字段。

用法:
  python tools/build_world.py          # 全量写盘
  python tools/build_world.py --dry    # 只打印，不写盘
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "data", "world-cities.json")
GEO = "https://geocoding-api.open-meteo.com/v1"

# (中文名, GeoNames 英文名, 国家代码)
CITIES = [
    # 东亚 / 东南亚 / 南亚
    ("东京", "Tokyo", "JP"), ("大阪", "Osaka", "JP"), ("京都", "Kyoto", "JP"),
    ("札幌", "Sapporo", "JP"), ("名古屋", "Nagoya", "JP"), ("福冈", "Fukuoka", "JP"),
    ("那霸", "Naha", "JP"), ("首尔", "Seoul", "KR"), ("釜山", "Busan", "KR"),
    ("济州", "Jeju City", "KR"), ("平壤", "Pyongyang", "KP"), ("乌兰巴托", "Ulaanbaatar", "MN"),
    ("河内", "Hanoi", "VN"), ("胡志明市", "Ho Chi Minh City", "VN"), ("岘港", "Da Nang", "VN"),
    ("曼谷", "Bangkok", "TH"), ("清迈", "Chiang Mai", "TH"), ("普吉", "Phuket", "TH"),
    ("万象", "Vientiane", "LA"), ("金边", "Phnom Penh", "KH"), ("暹粒", "Siem Reap", "KH"),
    ("仰光", "Yangon", "MM"), ("吉隆坡", "Kuala Lumpur", "MY"), ("槟城", "George Town", "MY"),
    ("新加坡", "Singapore", "SG"), ("雅加达", "Jakarta", "ID"), ("登巴萨", "Denpasar", "ID"),
    ("马尼拉", "Manila", "PH"), ("宿务", "Cebu City", "PH"), ("斯里巴加湾", "Bandar Seri Begawan", "BN"),
    ("新德里", "New Delhi", "IN"), ("孟买", "Mumbai", "IN"), ("班加罗尔", "Bengaluru", "IN"),
    ("加尔各答", "Kolkata", "IN"), ("金奈", "Chennai", "IN"), ("加德满都", "Kathmandu", "NP"),
    ("达卡", "Dhaka", "BD"), ("科伦坡", "Colombo", "LK"), ("马累", "Male", "MV"),
    ("伊斯兰堡", "Islamabad", "PK"), ("卡拉奇", "Karachi", "PK"), ("喀布尔", "Kabul", "AF"),
    # 中亚 / 西亚
    ("塔什干", "Tashkent", "UZ"), ("阿拉木图", "Almaty", "KZ"), ("阿斯塔纳", "Astana", "KZ"),
    ("比什凯克", "Bishkek", "KG"), ("杜尚别", "Dushanbe", "TJ"), ("德黑兰", "Tehran", "IR"),
    ("巴格达", "Baghdad", "IQ"), ("利雅得", "Riyadh", "SA"), ("吉达", "Jeddah", "SA"),
    ("迪拜", "Dubai", "AE"), ("阿布扎比", "Abu Dhabi", "AE"), ("多哈", "Doha", "QA"),
    ("科威特城", "Kuwait City", "KW"), ("马斯喀特", "Muscat", "OM"), ("耶路撒冷", "Jerusalem", "IL"),
    ("特拉维夫", "Tel Aviv", "IL"), ("安曼", "Amman", "JO"), ("贝鲁特", "Beirut", "LB"),
    ("伊斯坦布尔", "Istanbul", "TR"), ("安卡拉", "Ankara", "TR"), ("第比利斯", "Tbilisi", "GE"),
    ("埃里温", "Yerevan", "AM"), ("巴库", "Baku", "AZ"),
    # 欧洲
    ("伦敦", "London", "GB"), ("曼彻斯特", "Manchester", "GB"), ("爱丁堡", "Edinburgh", "GB"),
    ("都柏林", "Dublin", "IE"), ("巴黎", "Paris", "FR"), ("马赛", "Marseille", "FR"),
    ("尼斯", "Nice", "FR"), ("里昂", "Lyon", "FR"), ("柏林", "Berlin", "DE"),
    ("慕尼黑", "Munich", "DE"), ("法兰克福", "Frankfurt am Main", "DE"), ("汉堡", "Hamburg", "DE"),
    ("阿姆斯特丹", "Amsterdam", "NL"), ("布鲁塞尔", "Brussels", "BE"), ("卢森堡", "Luxembourg", "LU"),
    ("苏黎世", "Zurich", "CH"), ("日内瓦", "Geneva", "CH"), ("维也纳", "Vienna", "AT"),
    ("布拉格", "Prague", "CZ"), ("华沙", "Warsaw", "PL"), ("布达佩斯", "Budapest", "HU"),
    ("罗马", "Rome", "IT"), ("米兰", "Milan", "IT"), ("威尼斯", "Venice", "IT"),
    ("佛罗伦萨", "Florence", "IT"), ("那不勒斯", "Naples", "IT"), ("马德里", "Madrid", "ES"),
    ("巴塞罗那", "Barcelona", "ES"), ("塞维利亚", "Seville", "ES"), ("里斯本", "Lisbon", "PT"),
    ("雅典", "Athens", "GR"), ("哥本哈根", "Copenhagen", "DK"), ("斯德哥尔摩", "Stockholm", "SE"),
    ("奥斯陆", "Oslo", "NO"), ("赫尔辛基", "Helsinki", "FI"), ("雷克雅未克", "Reykjavik", "IS"),
    ("莫斯科", "Moscow", "RU"), ("圣彼得堡", "Saint Petersburg", "RU"), ("新西伯利亚", "Novosibirsk", "RU"),
    ("伊尔库茨克", "Irkutsk", "RU"), ("符拉迪沃斯托克", "Vladivostok", "RU"), ("摩尔曼斯克", "Murmansk", "RU"),
    ("基辅", "Kyiv", "UA"), ("明斯克", "Minsk", "BY"), ("布加勒斯特", "Bucharest", "RO"),
    ("索非亚", "Sofia", "BG"), ("贝尔格莱德", "Belgrade", "RS"), ("萨格勒布", "Zagreb", "HR"),
    ("维尔纽斯", "Vilnius", "LT"), ("里加", "Riga", "LV"), ("塔林", "Tallinn", "EE"),
    # 非洲
    ("开罗", "Cairo", "EG"), ("卡萨布兰卡", "Casablanca", "MA"), ("突尼斯", "Tunis", "TN"),
    ("阿尔及尔", "Algiers", "DZ"), ("拉各斯", "Lagos", "NG"), ("阿克拉", "Accra", "GH"),
    ("达喀尔", "Dakar", "SN"), ("内罗毕", "Nairobi", "KE"), ("亚的斯亚贝巴", "Addis Ababa", "ET"),
    ("达累斯萨拉姆", "Dar es Salaam", "TZ"), ("喀土穆", "Khartoum", "SD"), ("金沙萨", "Kinshasa", "CD"),
    ("罗安达", "Luanda", "AO"), ("约翰内斯堡", "Johannesburg", "ZA"), ("开普敦", "Cape Town", "ZA"),
    ("塔那那利佛", "Antananarivo", "MG"), ("路易港", "Port Louis", "MU"),
    # 北美
    ("纽约", "New York", "US"), ("洛杉矶", "Los Angeles", "US"), ("旧金山", "San Francisco", "US"),
    ("西雅图", "Seattle", "US"), ("芝加哥", "Chicago", "US"), ("波士顿", "Boston", "US"),
    ("华盛顿", "Washington", "US"), ("迈阿密", "Miami", "US"), ("休斯敦", "Houston", "US"),
    ("达拉斯", "Dallas", "US"), ("丹佛", "Denver", "US"), ("凤凰城", "Phoenix", "US"),
    ("拉斯维加斯", "Las Vegas", "US"), ("亚特兰大", "Atlanta", "US"), ("新奥尔良", "New Orleans", "US"),
    ("檀香山", "Honolulu", "US"), ("安克雷奇", "Anchorage", "US"), ("费尔班克斯", "Fairbanks", "US"),
    ("多伦多", "Toronto", "CA"), ("温哥华", "Vancouver", "CA"), ("蒙特利尔", "Montreal", "CA"),
    ("渥太华", "Ottawa", "CA"), ("卡尔加里", "Calgary", "CA"), ("墨西哥城", "Mexico City", "MX"),
    ("坎昆", "Cancun", "MX"), ("哈瓦那", "Havana", "CU"), ("巴拿马城", "Panama City", "PA"),
    # 南美
    ("圣保罗", "Sao Paulo", "BR"), ("里约热内卢", "Rio de Janeiro", "BR"), ("巴西利亚", "Brasilia", "BR"),
    ("马瑙斯", "Manaus", "BR"), ("布宜诺斯艾利斯", "Buenos Aires", "AR"), ("乌斯怀亚", "Ushuaia", "AR"),
    ("圣地亚哥", "Santiago", "CL"), ("利马", "Lima", "PE"), ("波哥大", "Bogota", "CO"),
    ("基多", "Quito", "EC"), ("拉巴斯", "La Paz", "BO"), ("加拉加斯", "Caracas", "VE"),
    ("蒙得维的亚", "Montevideo", "UY"),
    # 大洋洲
    ("悉尼", "Sydney", "AU"), ("墨尔本", "Melbourne", "AU"), ("布里斯班", "Brisbane", "AU"),
    ("珀斯", "Perth", "AU"), ("阿德莱德", "Adelaide", "AU"), ("达尔文", "Darwin", "AU"),
    ("凯恩斯", "Cairns", "AU"), ("堪培拉", "Canberra", "AU"), ("霍巴特", "Hobart", "AU"),
    ("奥克兰", "Auckland", "NZ"), ("惠灵顿", "Wellington", "NZ"), ("基督城", "Christchurch", "NZ"),
    ("皇后镇", "Queenstown", "NZ"), ("苏瓦", "Suva", "FJ"), ("努美阿", "Noumea", "NC"),
    ("帕皮提", "Papeete", "PF"),
]

# geocoding 的中文国名有过时或缺失的：金沙萨给「扎伊尔」，两个法属地区只给代码
COUNTRY_FIX = {"CD": "刚果（金）", "NC": "新喀里多尼亚", "PF": "法属波利尼西亚"}


def get(path, **q):
    url = GEO + path + "?" + urllib.parse.urlencode(q)
    for i in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - 网络抖动就该重试
            last = e
            time.sleep(1 + i)
    raise last


def resolve(zh, en, cc):
    rs = [r for r in get("/search", name=en, count=20, language="en").get("results") or []
          if r.get("country_code") == cc and str(r.get("feature_code", "")).startswith("PPL")]
    if not rs:
        return None
    r = max(rs, key=lambda r: r.get("population") or 0)
    country = COUNTRY_FIX.get(cc) or get("/get", id=r["id"], language="zh").get("country") or cc
    return {
        "id": "w%d" % r["id"], "name": zh, "en": en, "prov": country, "cc": cc,
        "py": en.lower().replace(" ", ""),
        "lat": round(r["latitude"], 4), "lon": round(r["longitude"], 4),
        "tz": r["timezone"], "pop": r.get("population") or 0,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    out, miss = [], []
    with ThreadPoolExecutor(8) as ex:
        got = list(ex.map(lambda t: resolve(*t), CITIES))
    for (zh, en, cc), c in zip(CITIES, got):
        if c:
            out.append(c)
            print("%-8s %-20s %-6s %-28s %8.4f %9.4f %s" % (zh, en, cc, c["tz"], c["lat"], c["lon"], c["prov"]))
        else:
            miss.append((zh, en, cc))
            print("  ! 查不到: %s %s %s" % (zh, en, cc))
    assert len({c["id"] for c in out}) == len(out), "有两个中文名解析到同一个 GeoNames 地点"
    print("\n共 %d 座，失败 %d：%s" % (len(out), len(miss), miss))
    if a.dry:
        return
    doc = {"updated": time.strftime("%Y-%m-%d"), "source": "Open-Meteo geocoding (GeoNames)",
           "count": len(out), "cities": out}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("-> %s" % OUT)


if __name__ == "__main__":
    main()
