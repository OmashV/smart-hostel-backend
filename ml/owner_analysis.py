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
df = df.sort_values(["room_id", "date"]).reset_index(drop=True)

print("Columns:", df.columns.tolist())
print(df.head())

# ---------------------------
# Helpers
# ---------------------------
weekday_names = {
    0: "Monday",
    1: "Tuesday",
    2: "Wednesday",
    3: "Thursday",
    4: "Friday",
    5: "Saturday",
    6: "Sunday"
}

df["day_of_week"] = df["date"].dt.dayofweek
df["weekday_name"] = df["day_of_week"].map(weekday_names)
df["day_type"] = df["day_of_week"].apply(lambda x: "Weekend" if x >= 5 else "Weekday")

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


# 2. ANOMALY DETECTION

anomaly_features = df[
    [
        "total_energy_kwh",
        "wasted_energy_kwh",
        "waste_ratio_percent",
        "avg_current"
    ]
].copy()

anomaly_docs = []

if len(anomaly_features) >= 5:
    iso = IsolationForest(contamination=0.15, random_state=42)
    df["anomaly_flag"] = iso.fit_predict(anomaly_features)
    df["anomaly_score"] = iso.decision_function(anomaly_features)

    energy_mean = df["total_energy_kwh"].mean()
    energy_std = df["total_energy_kwh"].std(ddof=0) or 1e-6

    waste_mean = df["wasted_energy_kwh"].mean()
    waste_std = df["wasted_energy_kwh"].std(ddof=0) or 1e-6

    current_mean = df["avg_current"].mean()
    current_std = df["avg_current"].std(ddof=0) or 1e-6

    for _, row in df.iterrows():
        if row["anomaly_flag"] == -1:
            reason = "abnormal energy/current pattern"

            if row["wasted_energy_kwh"] > waste_mean + waste_std:
                reason = "unusually high wasted energy"
            elif row["total_energy_kwh"] > energy_mean + energy_std:
                reason = "unusually high total energy usage"
            elif row["avg_current"] > current_mean + current_std:
                reason = "unusually high current draw"
            elif row["avg_current"] < max(0, current_mean - current_std):
                reason = "unusually low current draw"

            doc = {
                "room_id": row["room_id"],
                "date": row["date"].strftime("%Y-%m-%d"),
                "status": "Abnormal",
                "reason": reason,
                "total_energy_kwh": round(float(row["total_energy_kwh"]), 4),
                "wasted_energy_kwh": round(float(row["wasted_energy_kwh"]), 4),
                "waste_ratio_percent": round(float(row["waste_ratio_percent"]), 2),
                "avg_current": round(float(row["avg_current"]), 4),
                "anomaly_score": round(float(row["anomaly_score"]), 4)
            }

            anomaly_docs.append(doc)
            db.owner_anomalies.update_one(
                {"room_id": doc["room_id"], "date": doc["date"]},
                {"$set": doc},
                upsert=True
            )

            alert_doc = {
                "room_id": doc["room_id"],
                "date": doc["date"],
                "severity": "Critical" if doc["reason"] in [
                    "unusually high wasted energy",
                    "unusually high total energy usage"
                ] else "Warning",
                "title": (
                    "High Wasted Energy" if doc["reason"] == "unusually high wasted energy"
                    else "High Energy Usage" if doc["reason"] == "unusually high total energy usage"
                    else "High Current Draw" if doc["reason"] == "unusually high current draw"
                    else "Low Current Draw" if doc["reason"] == "unusually low current draw"
                    else "Abnormal Energy Pattern"
                ),
                "message": (
                    "Room shows unusually high wasted energy compared to learned normal behavior."
                    if doc["reason"] == "unusually high wasted energy"
                    else "Room shows unusually high total energy usage compared to learned normal behavior."
                    if doc["reason"] == "unusually high total energy usage"
                    else "Room shows unusually high current draw compared to learned normal behavior."
                    if doc["reason"] == "unusually high current draw"
                    else "Room shows unusually low current draw compared to learned normal behavior."
                    if doc["reason"] == "unusually low current draw"
                    else "Room shows abnormal energy/current behavior."
                ),
                "reason": doc["reason"],
                "source": "anomaly",
                "status": "active",
                "is_deleted": False
            }

            db.owner_alerts.update_one(
                {
                    "room_id": alert_doc["room_id"],
                    "date": alert_doc["date"],
                    "title": alert_doc["title"]
                },
                {"$set": alert_doc},
                upsert=True
            )

    print("Anomaly docs processed:", len(anomaly_docs))
else:
    print("Not enough rows for anomaly detection")


# 3. UNSUPERVISED PATTERN DISCOVERY


pattern_features = df[
    [
        "total_energy_kwh",
        "wasted_energy_kwh",
        "waste_ratio_percent",
        "avg_current"
    ]
].copy()

pattern_docs = []
weekday_pattern_docs = []

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

    # Per-date pattern results
    for _, row in df.iterrows():
        doc = {
            "room_id": row["room_id"],
            "date": row["date"].strftime("%Y-%m-%d"),
            "weekday_name": row["weekday_name"],
            "day_type": row["day_type"],
            "pattern_name": cluster_to_pattern[int(row["cluster_label"])]
        }
        pattern_docs.append(doc)
        db.owner_patterns.update_one(
            {"room_id": doc["room_id"], "date": doc["date"]},
            {"$set": doc},
            upsert=True
        )

    print("Pattern docs processed:", len(pattern_docs))

    # Weekday/weekend pattern discovery
    db.owner_weekday_patterns.delete_many({})

    for room_id in rooms:
        room_df = df[df["room_id"] == room_id].copy()
        room_df["pattern_name"] = room_df["cluster_label"].map(cluster_to_pattern)

        grouped = (
            room_df.groupby(["weekday_name", "day_type", "pattern_name"])
            .size()
            .reset_index(name="count")
        )

        weekday_groups = grouped.groupby(["weekday_name", "day_type"])

        for (weekday_name, day_type), sub in weekday_groups:
            top_row = sub.sort_values("count", ascending=False).iloc[0]

            docs_for_day = room_df[room_df["weekday_name"] == weekday_name]

            weekday_doc = {
                "room_id": room_id,
                "weekday_name": weekday_name,
                "day_type": day_type,
                "usual_pattern": top_row["pattern_name"],
                "days_count": int(len(docs_for_day)),
                "avg_total_energy_kwh": round(float(docs_for_day["total_energy_kwh"].mean()), 4),
                "avg_wasted_energy_kwh": round(float(docs_for_day["wasted_energy_kwh"].mean()), 4),
                "avg_waste_ratio_percent": round(float(docs_for_day["waste_ratio_percent"].mean()), 2)
            }

            weekday_pattern_docs.append(weekday_doc)
            db.owner_weekday_patterns.update_one(
                {
                    "room_id": weekday_doc["room_id"],
                    "weekday_name": weekday_doc["weekday_name"]
                },
                {"$set": weekday_doc},
                upsert=True
            )

    print("Weekday pattern docs processed:", len(weekday_pattern_docs))
else:
    print("Not enough rows for pattern analysis")

print("Final collection counts:")
print("owner_forecasts:", db.owner_forecasts.count_documents({}))
print("owner_anomalies:", db.owner_anomalies.count_documents({}))
print("owner_patterns:", db.owner_patterns.count_documents({}))
print("owner_weekday_patterns:", db.owner_weekday_patterns.count_documents({}))
print("owner_alerts:", db.owner_alerts.count_documents({}))

print("Owner Prophet analysis complete.")
