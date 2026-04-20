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

summary_docs = list(db.daily_room_summary.find({}, {"_id": 0}))
print("daily_room_summary count:", len(summary_docs))

if len(summary_docs) < 5:
    print("Not enough daily summary data.")
    raise SystemExit

df = pd.DataFrame(summary_docs)
df["date"] = pd.to_datetime(df["date"])
df = df.sort_values(["room_id", "date"])

print("Columns:", df.columns.tolist())
print(df.head())

# ---------------------------
# 1. FORECASTS USING PROPHET
# ---------------------------
forecast_docs = []

rooms = df["room_id"].unique().tolist()
print("Rooms found:", rooms)

for room_id in rooms:
    room_df = df[df["room_id"] == room_id].copy().sort_values("date")

    if len(room_df) < 4:
        print(f"Skipping forecast for {room_id} - not enough rows")
        continue

    total_df = room_df[["date", "total_energy_kwh"]].rename(
        columns={"date": "ds", "total_energy_kwh": "y"}
    )

    total_model = Prophet(
        daily_seasonality=False,
        weekly_seasonality=True,
        yearly_seasonality=False
    )
    total_model.fit(total_df)

    total_future = total_model.make_future_dataframe(periods=5, freq="D")
    total_forecast = total_model.predict(total_future)[["ds", "yhat"]].tail(5)
    total_forecast["yhat"] = total_forecast["yhat"].clip(lower=0)

    waste_df = room_df[["date", "wasted_energy_kwh"]].rename(
        columns={"date": "ds", "wasted_energy_kwh": "y"}
    )

    waste_model = Prophet(
        daily_seasonality=False,
        weekly_seasonality=True,
        yearly_seasonality=False
    )
    waste_model.fit(waste_df)

    waste_future = waste_model.make_future_dataframe(periods=5, freq="D")
    waste_forecast = waste_model.predict(waste_future)[["ds", "yhat"]].tail(5)
    waste_forecast["yhat"] = waste_forecast["yhat"].clip(lower=0)

    merged = pd.merge(
        total_forecast,
        waste_forecast,
        on="ds",
        suffixes=("_total", "_waste")
    )

    for _, row in merged.iterrows():
        doc = {
            "room_id": room_id,
            "date": row["ds"].strftime("%Y-%m-%d"),
            "predicted_total_energy_kwh": round(float(row["yhat_total"]), 4),
            "predicted_wasted_energy_kwh": round(float(row["yhat_waste"]), 4),
            "model_name": "prophet"
        }
        forecast_docs.append(doc)
        db.owner_forecasts.update_one(
            {"room_id": doc["room_id"], "date": doc["date"]},
            {"$set": doc},
            upsert=True
        )

print("Forecast docs processed:", len(forecast_docs))

# ---------------------------
# 2. ANOMALY DETECTION
# ---------------------------
anomaly_features = df[
    [
        "total_energy_kwh",
        "wasted_energy_kwh",
        "waste_ratio_percent",
        "avg_current",
        "door_open_count"
    ]
].copy()

anomaly_docs = []

if len(anomaly_features) >= 5:
    iso = IsolationForest(contamination=0.15, random_state=42)
    df["anomaly_flag"] = iso.fit_predict(anomaly_features)
    df["anomaly_score"] = iso.decision_function(anomaly_features)

    for _, row in df.iterrows():
        if row["anomaly_flag"] == -1:
            doc = {
                "room_id": row["room_id"],
                "date": row["date"].strftime("%Y-%m-%d"),
                "status": "Abnormal",
                "reason": "Unusually high waste or abnormal room usage compared to learned pattern",
                "total_energy_kwh": round(float(row["total_energy_kwh"]), 4),
                "wasted_energy_kwh": round(float(row["wasted_energy_kwh"]), 4),
                "anomaly_score": round(float(row["anomaly_score"]), 4)
            }
            anomaly_docs.append(doc)
            db.owner_anomalies.update_one(
                {"room_id": doc["room_id"], "date": doc["date"]},
                {"$set": doc},
                upsert=True
            )

    print("Anomaly docs processed:", len(anomaly_docs))
else:
    print("Not enough rows for anomaly detection")

# ---------------------------
# 3. BEHAVIOR PATTERNS
# ---------------------------
pattern_features = df[
    [
        "total_energy_kwh",
        "wasted_energy_kwh",
        "waste_ratio_percent",
        "avg_current",
        "door_open_count"
    ]
].copy()

pattern_docs = []

if len(pattern_features) >= 3:
    kmeans = KMeans(n_clusters=3, random_state=42, n_init=10)
    df["cluster_label"] = kmeans.fit_predict(pattern_features)

    cluster_means = (
        df.groupby("cluster_label")["waste_ratio_percent"]
        .mean()
        .sort_values()
    )

    ordered_clusters = cluster_means.index.tolist()
    cluster_to_pattern = {
        ordered_clusters[0]: "Efficient Usage",
        ordered_clusters[1]: "Moderate Waste",
        ordered_clusters[2]: "High Waste Pattern"
    }

    for _, row in df.iterrows():
        doc = {
            "room_id": row["room_id"],
            "date": row["date"].strftime("%Y-%m-%d"),
            "pattern_name": cluster_to_pattern[int(row["cluster_label"])]
        }
        pattern_docs.append(doc)
        db.owner_patterns.update_one(
            {"room_id": doc["room_id"], "date": doc["date"]},
            {"$set": doc},
            upsert=True
        )

    print("Pattern docs processed:", len(pattern_docs))
else:
    print("Not enough rows for pattern analysis")

print("Final collection counts:")
print("owner_forecasts:", db.owner_forecasts.count_documents({}))
print("owner_anomalies:", db.owner_anomalies.count_documents({}))
print("owner_patterns:", db.owner_patterns.count_documents({}))

print("Owner Prophet analysis complete.")
