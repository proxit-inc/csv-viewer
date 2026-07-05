import csv
import os
import random
import string


def gen(filename, rows, encoding="utf-8", delimiter=",", cities=None):
    os.makedirs(os.path.dirname(filename) or ".", exist_ok=True)
    headers = ["id", "name", "city", "category", "value", "date"]
    cities = cities or ["Tokyo", "Osaka", "Nagoya", "Fukuoka", "Sapporo"]
    cats = ["A", "B", "C", "D"]

    with open(filename, "w", newline="", encoding=encoding) as f:
        w = csv.writer(f, delimiter=delimiter)
        w.writerow(headers)
        for i in range(1, rows + 1):
            w.writerow(
                [
                    i,
                    "".join(random.choices(string.ascii_letters, k=8)),
                    random.choice(cities),
                    random.choice(cats),
                    round(random.uniform(100, 10000), 2),
                    f"2024-{random.randint(1, 12):02d}-{random.randint(1, 28):02d}",
                ]
            )
    print(f"✓ {filename}: {rows} rows, {encoding}, delimiter={repr(delimiter)}")


if __name__ == "__main__":
    gen("test-data/utf8_100k.csv", 100_000)
    gen(
        "test-data/sjis_sample.csv",
        10_000,
        encoding="shift_jis",
        cities=["東京", "大阪", "名古屋", "福岡", "札幌"],
    )
    gen("test-data/tab_delimited.tsv", 10_000, delimiter="\t")
    gen("test-data/small.csv", 100)
