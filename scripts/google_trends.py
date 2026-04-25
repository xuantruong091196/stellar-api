#!/usr/bin/env python3
"""Fetch rising queries from Google Trends. Called as subprocess from Node."""
import json
import sys

try:
    from pytrends.request import TrendReq
except ImportError:
    print(json.dumps({"error": "pytrends-modern not installed"}))
    sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: google_trends.py <keyword>"}))
        sys.exit(1)

    keyword = sys.argv[1]
    try:
        pytrends = TrendReq(hl='en-US', tz=360, retries=2, backoff_factor=0.5)
        pytrends.build_payload([keyword], cat=0, timeframe='now 7-d', geo='US')
        related = pytrends.related_queries()
        rising = related.get(keyword, {}).get('rising')
        items = []
        if rising is not None:
            for _, row in rising.iterrows():
                items.append({"query": row['query'], "value": int(row['value'])})
        print(json.dumps({"keyword": keyword, "rising": items}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
