import os
import pandas as pd
from pymongo import MongoClient
from sklearn.ensemble import IsolationForest
from sklearn.cluster import KMeans
from dotenv import load_dotenv
from prophet import Prophet

load_dotenv()

MONGO_URI = os.getenv("MONGO_URI")
DB_NAME = "smart_hostel"

if not MONGO_URI:
    print("MONGO_URI not found in .env")
    raise SystemExit

print("Connecting to MongoDB...")
client = MongoClient(MONGO_URI)
db = client[DB_NAME]
print("Connected DB:", db.name)

# ---------------------------
# Load raw sensor readings
# ---------------------------
docs = list(db.sensorreadings.find(
    {
        "door_status": "Open",
        "door_stable_ms": {"$gt": 0, "$lt": 3600000},
        "time_valid": True,
        "sensor_faults.door": False,
        "sensor_health.door": True
    },
    {
        "_id": 0,
        "room_id": 1,
        "captured_at": 1,
        "door_stable_ms": 1,
        "motion_count": 1,
        "occupancy_stat": 1,
        "hour": 1
    }
))

print("Sensor readings loaded:", len(docs))

if len(docs) < 10:
    print("Not enough data.")
    raise SystemExit

df = pd.DataFrame(docs)
df["captured_at"] = pd.to_datetime(df["captured_at"])
df["door_stable_min"] = df["door_stable_ms"] / 60000
df["is_after_hours"] = df["hour"].apply(lambda h: 1 if h >= 23 or h <= 5 else 0)
df["is_empty"] = df["occupancy_stat"].apply(lambda x: 1 if x == "Empty" else 0)

rooms = df["room_id"].unique().tolist()
print("Rooms found:", rooms)


# ---------------------------
# 1. PROPHET FORECASTING
# Expected door open duration per hour per room
# ---------------------------
print("\n--- Prophet Forecasting ---")
forecast_docs = []

for room_id in rooms:
    room_df = df[df["room_id"] == room_id].copy().sort_values("captured_at")

    if len(room_df) < 10:
        print(f"Skipping {room_id} - not enough rows")
        continue

    prophet_df = room_df[["captured_at", "door_stable_ms"]].rename(
        columns={"captured_at": "ds", "door_stable_ms": "y"}
    )

    model = Prophet(
        daily_seasonality=True,
        weekly_seasonality=True,
        yearly_seasonality=False,
        interval_width=0.95          # 95% confidence band
    )
    model.fit(prophet_df)

    future = model.make_future_dataframe(periods=24, freq="h")
    forecast = model.predict(future)[["ds", "yhat", "yhat_lower", "yhat_upper"]].tail(24)
    forecast["yhat"] = forecast["yhat"].clip(lower=0)
    forecast["yhat_lower"] = forecast["yhat_lower"].clip(lower=0)

    for _, row in forecast.iterrows():
        doc = {
            "room_id": room_id,
            "hour": int(row["ds"].hour),
            "hour_label": f"{row['ds'].hour}:00",
            "date": row["ds"].strftime("%Y-%m-%d"),
            "expected_door_stable_ms": round(float(row["yhat"]), 2),
            "lower_bound_ms": round(float(row["yhat_lower"]), 2),
            "upper_bound_ms": round(float(row["yhat_upper"]), 2),
            "expected_door_stable_min": round(float(row["yhat"]) / 60000, 4),
            "model_name": "prophet"
        }
        forecast_docs.append(doc)
        db.security_forecasts.update_one(
            {"room_id": doc["room_id"], "hour": doc["hour"], "date": doc["date"]},
            {"$set": doc},
            upsert=True
        )

print("Forecast docs saved:", len(forecast_docs))


# ---------------------------
# 2. ISOLATION FOREST ANOMALY DETECTION
# Detects abnormal door/motion/occupancy behavior
# ---------------------------
print("\n--- Isolation Forest Anomaly Detection ---")

anomaly_features = df[[
    "door_stable_ms",
    "motion_count",
    "is_after_hours",
    "is_empty"
]].copy()

anomaly_docs = []

if len(anomaly_features) >= 10:
    iso = IsolationForest(contamination=0.1, random_state=42)
    df["anomaly_flag"] = iso.fit_predict(anomaly_features)
    df["anomaly_score"] = iso.decision_function(anomaly_features)

    # Learn thresholds from data (not hardcoded)
    duration_mean = df["door_stable_ms"].mean()
    duration_std = df["door_stable_ms"].std(ddof=0) or 1e-6
    motion_mean = df["motion_count"].mean()

    for _, row in df.iterrows():
        if row["anomaly_flag"] == -1:

            # Reason derived from data distribution
            reason = "abnormal door/sensor pattern"

            if row["door_stable_ms"] > duration_mean + duration_std and row["is_empty"]:
                reason = "door open unusually long in empty room"
            elif row["door_stable_ms"] > duration_mean + duration_std:
                reason = "door open unusually long"
            elif row["motion_count"] < motion_mean and row["is_after_hours"]:
                reason = "after-hours activity with low motion"
            elif row["is_after_hours"] and row["is_empty"]:
                reason = "after-hours access in empty room"

            severity = "Critical" if row["anomaly_score"] < -0.1 else "Warning"

            doc = {
                "room_id": row["room_id"],
                "captured_at": row["captured_at"].isoformat(),
                "hour": int(row["hour"]),
                "status": "Abnormal",
                "reason": reason,
                "severity": severity,
                "door_stable_ms": round(float(row["door_stable_ms"]), 2),
                "door_stable_min": round(float(row["door_stable_min"]), 4),
                "motion_count": int(row["motion_count"]),
                "is_after_hours": bool(row["is_after_hours"]),
                "is_empty": bool(row["is_empty"]),
                "anomaly_score": round(float(row["anomaly_score"]), 4),
                "model_name": "isolation_forest"
            }

            anomaly_docs.append(doc)
            db.security_anomalies.update_one(
                {"room_id": doc["room_id"], "captured_at": doc["captured_at"]},
                {"$set": doc},
                upsert=True
            )

    print("Anomaly docs saved:", len(anomaly_docs))
else:
    print("Not enough rows for anomaly detection")


# ---------------------------
# 3. K-MEANS BEHAVIOR CLUSTERING
# Discovers room behavior profiles 
# ---------------------------
print("\n--- K-Means Behavior Clustering ---")

cluster_features = df[[
    "door_stable_ms",
    "motion_count",
    "is_after_hours",
    "is_empty"
]].copy()

pattern_docs = []

if len(cluster_features) >= 3:
    kmeans = KMeans(n_clusters=3, random_state=42, n_init=10)
    df["cluster_label"] = kmeans.fit_predict(cluster_features)

    # Rank clusters by door duration (learned, not hardcoded)
    cluster_means = (
        df.groupby("cluster_label")["door_stable_ms"]
        .mean()
        .sort_values()
    )

    ordered = cluster_means.index.tolist()
    cluster_to_profile = {
        ordered[0]: "Normal Activity",
        ordered[1]: "Elevated Activity",
        ordered[2]: "High Risk Pattern"
    }

    for _, row in df.iterrows():
        doc = {
            "room_id": row["room_id"],
            "captured_at": row["captured_at"].isoformat(),
            "hour": int(row["hour"]),
            "behavior_profile": cluster_to_profile[int(row["cluster_label"])],
            "cluster_label": int(row["cluster_label"]),
            "door_stable_min": round(float(row["door_stable_min"]), 4),
            "motion_count": int(row["motion_count"]),
            "is_after_hours": bool(row["is_after_hours"]),
            "model_name": "kmeans"
        }
        pattern_docs.append(doc)
        db.security_patterns.update_one(
            {"room_id": doc["room_id"], "captured_at": doc["captured_at"]},
            {"$set": doc},
            upsert=True
        )

    print("Pattern docs saved:", len(pattern_docs))
else:
    print("Not enough rows for clustering")


# ---------------------------
# Summary
# ---------------------------
print("\nFinal collection counts:")
print("security_forecasts:", db.security_forecasts.count_documents({}))
print("security_anomalies:", db.security_anomalies.count_documents({}))
print("security_patterns:", db.security_patterns.count_documents({}))
print("\nSecurity ML analysis complete.")