# generate_synthetic_ml_results.py
import os
import random
from datetime import datetime, timedelta
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()

client = MongoClient(os.getenv("MONGO_URI"))
db = client["smart_hostel"]

ROOMS = ["A102", "A103", "B101", "B102", "B103", "C101", "C102"]

# B102 and A103 are the "suspicious" rooms — will have more anomalies
ROOM_RISK = {
    "A102": "low",
    "A103": "medium",
    "B101": "low",
    "B102": "high",
    "B103": "low",
    "C101": "low",
    "C102": "medium",
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. SECURITY FORECASTS
# One entry per room per hour (0–23)
# ─────────────────────────────────────────────────────────────────────────────
print("Generating security_forecasts...")

forecast_docs = []
today = datetime.utcnow().strftime("%Y-%m-%d")

# Typical expected door duration by hour — mimics real human patterns
HOURLY_BASELINE_MS = {
    0:  60000,   1:  45000,   2:  40000,   3:  40000,
    4:  45000,   5:  60000,   6:  90000,   7: 180000,
    8: 240000,   9: 300000,  10: 280000,  11: 260000,
   12: 300000,  13: 280000,  14: 260000,  15: 270000,
   16: 290000,  17: 310000,  18: 280000,  19: 240000,
   20: 200000,  21: 160000,  22: 120000,  23:  80000,
}

for room_id in ROOMS:
    risk = ROOM_RISK[room_id]

    # High risk rooms have slightly higher baselines
    multiplier = 1.4 if risk == "high" else 1.1 if risk == "medium" else 1.0

    for hour in range(24):
        base = HOURLY_BASELINE_MS[hour] * multiplier
        noise = random.uniform(0.85, 1.15)
        expected = round(base * noise)

        # Confidence band — wider at night (less data = more uncertainty)
        band_width = 0.4 if (hour >= 22 or hour <= 6) else 0.25
        lower = round(expected * (1 - band_width))
        upper = round(expected * (1 + band_width))

        doc = {
            "room_id":                  room_id,
            "hour":                     hour,
            "hour_label":               f"{hour}:00",
            "date":                     today,
            "expected_door_stable_ms":  expected,
            "expected_door_stable_min": round(expected / 60000, 4),
            "lower_bound_ms":           max(0, lower),
            "upper_bound_ms":           upper,
            "model_name":               "prophet"
        }

        forecast_docs.append(doc)
        db.security_forecasts.update_one(
            {"room_id": room_id, "hour": hour},
            {"$set": doc},
            upsert=True
        )

print(f"  security_forecasts: {len(forecast_docs)} docs")


# ─────────────────────────────────────────────────────────────────────────────
# 2. SECURITY ANOMALIES
# Spread across past 7 days — more anomalies for high/medium risk rooms
# ─────────────────────────────────────────────────────────────────────────────
print("Generating security_anomalies...")

ANOMALY_COUNT = {
    "low":    random.randint(1, 3),
    "medium": random.randint(4, 7),
    "high":   random.randint(8, 14),
}

REASONS = {
    "Critical": [
        "door open unusually long in empty room",
        "after-hours access in empty room",
        "door open unusually long",
    ],
    "Warning": [
        "after-hours activity with low motion",
        "door open moderately longer than expected",
        "abnormal door/sensor pattern",
    ]
}

anomaly_docs = []

for room_id in ROOMS:
    risk = ROOM_RISK[room_id]
    count = ANOMALY_COUNT[risk]

    for _ in range(count):
        days_ago = random.randint(0, 6)
        hour = random.choice(
            list(range(0, 6)) + list(range(22, 24))
            if risk == "high"
            else list(range(0, 24))
        )
        captured_at = datetime.utcnow() - timedelta(
            days=days_ago,
            hours=random.randint(0, 2),
            minutes=random.randint(0, 59)
        )

        is_after_hours = hour >= 23 or hour <= 5
        severity = (
            "Critical"
            if risk == "high" or (risk == "medium" and random.random() > 0.5)
            else "Warning"
        )
        reason = random.choice(REASONS[severity])

        # Anomaly score — more negative = more anomalous
        score = round(random.uniform(-0.45, -0.05), 4)
        if severity == "Critical":
            score = round(random.uniform(-0.45, -0.20), 4)

        # Actual duration — anomalously long
        expected_ms = HOURLY_BASELINE_MS.get(hour, 120000)
        door_stable_ms = random.randint(
            int(expected_ms * 2),
            int(expected_ms * 6)
        )

        forecast = db.security_forecasts.find_one({"room_id": room_id, "hour": hour})

        doc = {
            "room_id":         room_id,
            "captured_at":     captured_at.isoformat(),
            "hour":            hour,
            "status":          "Abnormal",
            "reason":          reason,
            "severity":        severity,
            "anomaly_score":   score,
            "door_stable_ms":  door_stable_ms,
            "door_stable_min": round(door_stable_ms / 60000, 4),
            "motion_count":    random.randint(0, 2),
            "is_after_hours":  is_after_hours,
            "is_empty":        random.random() > 0.3,
            "model_name":      "isolation_forest"
        }

        anomaly_docs.append(doc)
        db.security_anomalies.update_one(
            {"room_id": doc["room_id"], "captured_at": doc["captured_at"]},
            {"$set": doc},
            upsert=True
        )

print(f"  security_anomalies: {len(anomaly_docs)} docs")


# ─────────────────────────────────────────────────────────────────────────────
# 3. SECURITY PATTERNS
# One behavior profile entry per room per day for past 7 days
# ─────────────────────────────────────────────────────────────────────────────
print("Generating security_patterns...")

PROFILES = ["Normal Activity", "Elevated Activity", "High Risk Pattern"]

PROFILE_WEIGHTS = {
    "low":    [0.85, 0.12, 0.03],
    "medium": [0.60, 0.30, 0.10],
    "high":   [0.30, 0.40, 0.30],
}

pattern_docs = []

for room_id in ROOMS:
    risk = ROOM_RISK[room_id]

    for days_ago in range(7):
        for hour in range(0, 24, 4):  # one entry per 4-hour block
            captured_at = datetime.utcnow() - timedelta(
                days=days_ago, hours=hour
            )

            profile = random.choices(
                PROFILES,
                weights=PROFILE_WEIGHTS[risk]
            )[0]

            doc = {
                "room_id":          room_id,
                "captured_at":      captured_at.isoformat(),
                "hour":             hour,
                "behavior_profile": profile,
                "door_stable_min":  round(random.uniform(1, 90), 4),
                "motion_count":     random.randint(0, 12),
                "is_after_hours":   hour >= 23 or hour <= 5,
                "model_name":       "kmeans"
            }

            pattern_docs.append(doc)
            db.security_patterns.update_one(
                {"room_id": doc["room_id"], "captured_at": doc["captured_at"]},
                {"$set": doc},
                upsert=True
            )

print(f"  security_patterns: {len(pattern_docs)} docs")


# ─────────────────────────────────────────────────────────────────────────────
print("\nFinal counts:")
print("  security_forecasts:", db.security_forecasts.count_documents({}))
print("  security_anomalies:", db.security_anomalies.count_documents({}))
print("  security_patterns: ", db.security_patterns.count_documents({}))
print("\nDone. No sensorreadings were touched.")