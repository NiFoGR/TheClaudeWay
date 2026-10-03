"""Count paid Google calls per run, so the Control Room's Money page can show what lead finding costs.

SKU names match Google's price list. The Control Room turns counts into pounds (functions/_lib/money.js),
including each SKU's free monthly allowance.
"""

import threading
from collections import Counter

TEXT_SEARCH_ENTERPRISE = "text_search_enterprise"  # lead search: phone, website, rating fields
TEXT_SEARCH_PRO = "text_search_pro"                # finding a town's centre (location field)
TEXT_SEARCH_IDS = "text_search_ids"                # Map Rank grid points: IDs only, free
PLACE_DETAILS_ENTERPRISE = "place_details_enterprise"  # competitor names + ratings on a heatmap

calls: Counter[str] = Counter()
_lock = threading.Lock()  # Map Rank searches grid points in parallel threads


def count(sku: str, n: int = 1) -> None:
    with _lock:
        calls[sku] += n


def reset() -> None:
    calls.clear()
