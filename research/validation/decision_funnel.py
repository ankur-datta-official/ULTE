"""Stream paired replay observations and count actual analysis/decision gates."""

from collections import Counter
import json
from pathlib import Path


def observations(path: Path):
    with path.open("rb") as handle:
        marker = b'"observations":['
        tail = b""
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                raise ValueError("Missing observations array")
            found = (tail + chunk).find(marker)
            if found >= 0:
                # Seek back to the first byte after the marker. JSON prefix is ASCII.
                handle.seek(handle.tell() - len(chunk) - len(tail) + found + len(marker))
                break
            tail = chunk[-len(marker):]
        depth = 0
        quoted = escaped = False
        item = []
        while chunk := handle.read(1024 * 1024):
            for char in chunk:
                if depth == 0:
                    if char == ord("]"):
                        return
                    if char != ord("{"):
                        continue
                item.append(char)
                if quoted:
                    if escaped:
                        escaped = False
                    elif char == ord("\\"):
                        escaped = True
                    elif char == ord('"'):
                        quoted = False
                elif char == ord('"'):
                    quoted = True
                elif char == ord("{"):
                    depth += 1
                elif char == ord("}"):
                    depth -= 1
                    if depth == 0:
                        yield json.loads(bytes(item))
                        item = []
        raise ValueError("Unterminated observations array")


def summarize(path: Path):
    counts = Counter()
    reasons = Counter()
    family = Counter()
    for item in observations(path):
        a, d = item["analysis"], item["decision"]
        counts["TOTAL_CYCLES"] += 1
        counts[f"analysis:{a['status']}"] += 1
        counts[f"decision:{d['status']}"] += 1
        if a["status"] != "INSUFFICIENT_HISTORY":
            counts[f"regime:{a['regime']['status']}"] += 1
            counts[f"structure:{a['structure']['status']}"] += 1
            counts[f"setup:{a['setup']['status']}"] += 1
            candidates = a["setup"].get("candidates", [])
            counts["candidate_count"] += len(candidates)
            if candidates:
                counts["candidate_cycles"] += 1
            for c in candidates:
                family[(c["family"], c["stage"])] += 1
                if c["stage"] == "CONFIRMED":
                    counts["confirmed_candidates"] += 1
            if a["setup"]["status"] != "READY":
                reasons[("setup", a["setup"].get("reason", ""))] += 1
        if d["status"] == "NO_DECISION":
            reasons[("noDecision", d["reason"])] += 1
        elif d["status"] == "DECISION_REJECTED":
            stage = d["blockingStage"]
            details = (d.get("structuralRiskResult") if stage == "STRUCTURAL_RISK" else
                       d.get("portfolioRiskResult") if stage == "PORTFOLIO_RISK" else
                       d.get("positionSizingResult") if stage == "POSITION_SIZING" else
                       d.get("tradeIntentResult") if stage == "TRADE_INTENT" else d)
            reasons[(stage, details.get("reason", ""))] += 1
            if d.get("structuralRiskResult", {}).get("status") == "QUALIFIED":
                counts["signal_eligible"] += 1
            if stage in ("PORTFOLIO_RISK", "POSITION_SIZING"):
                counts["risk_account_blocked"] += 1
        elif d["status"] == "TRADE_INTENT_CREATED":
            counts["signal_eligible"] += 1
    for key in ("signal_eligible", "risk_account_blocked", "decision:TRADE_INTENT_CREATED",
                "decision:DECISION_REJECTED"):
        counts.setdefault(key, 0)
    funnel = {
        "TOTAL_CYCLES": counts["TOTAL_CYCLES"],
        "ANALYSIS_CANDIDATE_CREATED_CYCLES": counts["candidate_cycles"],
        "SETUP_DETECTED_CANDIDATES": counts["candidate_count"],
        "CONFIRMED_CANDIDATES": counts["confirmed_candidates"],
        "STRUCTURAL_RISK_REJECTED": sum(v for (stage, _), v in reasons.items()
                                        if stage == "STRUCTURAL_RISK"),
        "REJECTED_BY_RISK_ACCOUNT_CONTEXT": counts["risk_account_blocked"],
        "SIGNAL_ELIGIBLE": counts["signal_eligible"],
        "TRADE_INTENT_CREATED": counts["decision:TRADE_INTENT_CREATED"],
    }
    return {"funnel": funnel, "counts": dict(counts), "reasons": {str(k): v for k, v in reasons.items()},
            "familyStage": {str(k): v for k, v in family.items()},
            "unpublishedGateCounters": ["regime family allowlist", "structure event/level evidence",
                                        "liquidity evidence", "volatility classification", "MTF context"],
            "note": "The shared setup evaluator does not publish per-gate rejection reasons for these internal checks."}


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1] / "data" / "binance_btcusdt_v1"
    summary = summarize(root / "replay.json")
    (root / "exploratory_funnel.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
