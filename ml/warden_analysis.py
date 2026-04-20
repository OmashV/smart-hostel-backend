import os
import pandas as pd
from pymongo import MongoClient
from sklearn.ensemble import IsolationForest, RandomForestClassifier
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

summary_docs = list(db.warden_hourly_summary.find({}, {"_id": 0}))
print("warden_hourly_summary count:", len(summary_docs))

if len(summary_docs) < 8:
    print("Not enough warden hourly summary data.")
    raise SystemExit

df = pd.DataFrame(summary_docs)
df["date"] = pd.to_datetime(df["date"])
df["datetime"] = pd.to_datetime(df["date"].dt.strftime("%Y-%m-%d") + " " + df["hour"].astype(str) + ":00:00")
df = df.sort_values(["room_id", "datetime"])

print("Columns:", df.columns.tolist())
print(df.head())

# ------------------------------------------------
# 1. TEMPORAL TREND ANALYSIS (PROPHET FORECASTING)
# ------------------------------------------------
forecast_docs = []

rooms = df["room_id"].unique().tolist()

for room_id in rooms:
    room_df = df[df["room_id"] == room_id].copy().sort_values("datetime")

    if len(room_df) < 6:
        continue

    warning_df = room_df[["datetime", "warning_count"]].rename(
        columns={"datetime": "ds", "warning_count": "y"}
    )

    violation_df = room_df[["datetime", "violation_count"]].rename(
        columns={"datetime": "ds", "violation_count": "y"}
    )

    occupancy_df = room_df[["datetime", "occupied_count"]].rename(
        columns={"datetime": "ds", "occupied_count": "y"}
    )

    warning_model = Prophet(
        daily_seasonality=True,
        weekly_seasonality=True,
        yearly_seasonality=False
    )
    warning_model.fit(warning_df)

    violation_model = Prophet(
        daily_seasonality=True,
        weekly_seasonality=True,
        yearly_seasonality=False
    )
    violation_model.fit(violation_df)

    occupancy_model = Prophet(
        daily_seasonality=True,
        weekly_seasonality=True,
        yearly_seasonality=False
    )
    occupancy_model.fit(occupancy_df)

    future_warning = warning_model.make_future_dataframe(periods=5, freq="H")
    future_violation = violation_model.make_future_dataframe(periods=5, freq="H")
    future_occupancy = occupancy_model.make_future_dataframe(periods=5, freq="H")

    warning_forecast = warning_model.predict(future_warning)[["ds", "yhat"]].tail(5)
    violation_forecast = violation_model.predict(future_violation)[["ds", "yhat"]].tail(5)
    occupancy_forecast = occupancy_model.predict(future_occupancy)[["ds", "yhat"]].tail(5)

    warning_forecast["yhat"] = warning_forecast["yhat"].clip(lower=0)
    violation_forecast["yhat"] = violation_forecast["yhat"].clip(lower=0)
    occupancy_forecast["yhat"] = occupancy_forecast["yhat"].clip(lower=0)

    merged = pd.merge(
        warning_forecast,
        violation_forecast,
        on="ds",
        suffixes=("_warning", "_violation")
    )
    merged = pd.merge(
        merged,
        occupancy_forecast.rename(columns={"yhat": "yhat_occupied"}),
        on="ds"
    )

    for _, row in merged.iterrows():
        doc = {
            "room_id": room_id,
            "date": row["ds"].strftime("%Y-%m-%d %H:%M:%S"),
            "predicted_warning_count": round(float(row["yhat_warning"]), 4),
            "predicted_violation_count": round(float(row["yhat_violation"]), 4),
            "predicted_occupied_count": round(float(row["yhat_occupied"]), 4),
            "model_name": "prophet"
        }
        forecast_docs.append(doc)
        db.warden_forecasts.update_one(
            {"room_id": doc["room_id"], "date": doc["date"]},
            {"$set": doc},
            upsert=True
        )

print("Forecast docs processed:", len(forecast_docs))

# ------------------------------------------------
# 2. THRESHOLD-BASED ALERTS / FEATURE IMPORTANCE
# ------------------------------------------------
feature_cols = [
    "occupied_count",
    "empty_count",
    "sleeping_count",
    "avg_sound_peak",
    "avg_current",
    "door_open_count",
    "complaint_count"
]

df["noise_alert_label"] = (
    (df["warning_count"] > 0) | (df["violation_count"] > 0)
).astype(int)

if len(df) >= 8:
    rf = RandomForestClassifier(n_estimators=200, random_state=42)
    rf.fit(df[feature_cols], df["noise_alert_label"])

    db.warden_feature_importance.delete_many({})
    importance_docs = []

    for feature, importance in zip(feature_cols, rf.feature_importances_):
        doc = {
            "feature": feature,
            "importance": round(float(importance), 6)
        }
        importance_docs.append(doc)

    if importance_docs:
        db.warden_feature_importance.insert_many(importance_docs)

    print("Feature importance saved:", len(importance_docs))
else:
    print("Not enough rows for feature importance")

# ------------------------------------------------
# 3. ANOMALY DETECTION
# ------------------------------------------------
anomaly_features = df[
    [
        "avg_sound_peak",
        "avg_current",
        "violation_count",
        "warning_count",
        "complaint_count",
        "occupied_count",
        "empty_count"
    ]
].copy()

anomaly_docs = []

if len(anomaly_features) >= 8:
    iso = IsolationForest(contamination=0.15, random_state=42)
    df["anomaly_flag"] = iso.fit_predict(anomaly_features)
    df["anomaly_score"] = iso.decision_function(anomaly_features)

    for _, row in df.iterrows():
      if row["anomaly_flag"] == -1:
        doc = {
            "room_id": row["room_id"],
            "date": row["datetime"].strftime("%Y-%m-%d %H:%M:%S"),
            "status": "Abnormal",
            "reason": "Unusual noise, occupancy, or inspection behavior compared to learned room pattern",
            "avg_sound_peak": round(float(row["avg_sound_peak"]), 2),
            "avg_current": round(float(row["avg_current"]), 4),
            "violation_count": int(row["violation_count"]),
            "anomaly_score": round(float(row["anomaly_score"]), 4)
        }
        anomaly_docs.append(doc)
        db.warden_anomalies.update_one(
            {"room_id": doc["room_id"], "date": doc["date"]},
            {"$set": doc},
            upsert=True
        )

    print("Anomaly docs processed:", len(anomaly_docs))
else:
    print("Not enough rows for anomaly detection")

# ------------------------------------------------
# 4. USAGE / BEHAVIOR PATTERN ANALYSIS
# ------------------------------------------------
pattern_features = df[
    [
        "occupied_count",
        "empty_count",
        "avg_sound_peak",
        "avg_current",
        "complaint_count",
        "violation_count",
        "inspection_count"
    ]
].copy()

pattern_docs = []

if len(pattern_features) >= 6:
    kmeans = KMeans(n_clusters=3, random_state=42, n_init=10)
    df["cluster_label"] = kmeans.fit_predict(pattern_features)

    cluster_means = (
        df.groupby("cluster_label")["violation_count"]
        .mean()
        .sort_values()
    )

    ordered_clusters = cluster_means.index.tolist()
    cluster_to_pattern = {
        ordered_clusters[0]: "Low Risk Pattern",
        ordered_clusters[1]: "Moderate Monitoring Pattern",
        ordered_clusters[2]: "High Noise / High Inspection Pattern"
    }

    for _, row in df.iterrows():
        doc = {
            "room_id": row["room_id"],
            "date": row["datetime"].strftime("%Y-%m-%d %H:%M:%S"),
            "pattern_name": cluster_to_pattern[int(row["cluster_label"])]
        }
        pattern_docs.append(doc)
        db.warden_patterns.update_one(
            {"room_id": doc["room_id"], "date": doc["date"]},
            {"$set": doc},
            upsert=True
        )

    print("Pattern docs processed:", len(pattern_docs))
else:
    print("Not enough rows for pattern analysis")

print("Final collection counts:")
print("warden_forecasts:", db.warden_forecasts.count_documents({}))
print("warden_anomalies:", db.warden_anomalies.count_documents({}))
print("warden_patterns:", db.warden_patterns.count_documents({}))
print("warden_feature_importance:", db.warden_feature_importance.count_documents({}))

print("Warden ML analysis complete.")
