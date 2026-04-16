import pandas as pd
from pymongo import MongoClient
from sklearn.ensemble import RandomForestRegressor, IsolationForest
from sklearn.cluster import KMeans

MONGO_URI = "YOUR_MONGO_URI"
DB_NAME = "smart_hostel"

client = MongoClient(MONGO_URI)
db = client[DB_NAME]

summary_docs = list(db.daily_room_summary.find({}, {"_id": 0}))
df = pd.DataFrame(summary_docs)

if df.empty or len(df) < 5:
    print("Not enough daily summary data.")
    exit()

df["date"] = pd.to_datetime(df["date"])
df = df.sort_values(["room_id", "date"])

# -------- Feature engineering --------
df["prev_day_waste"] = df.groupby("room_id")["wasted_energy_kwh"].shift(1)
df["prev_day_energy"] = df.groupby("room_id")["total_energy_kwh"].shift(1)
df["day_of_week"] = df["date"].dt.dayofweek

train_df = df.dropna().copy()

feature_cols = [
    "prev_day_waste",
    "prev_day_energy",
    "avg_current",
    "total_motion_count",
    "avg_sound_peak",
    "door_open_count",
    "day_of_week"
]

target_col = "wasted_energy_kwh"

X = train_df[feature_cols]
y = train_df[target_col]

# -------- 1. Forecasting + Feature Importance --------
rf = RandomForestRegressor(n_estimators=100, random_state=42)
rf.fit(X, y)

# store feature importance
db.owner_feature_importance.delete_many({})
feature_importance_docs = [
    {"feature": feature, "importance": float(importance)}
    for feature, importance in zip(feature_cols, rf.feature_importances_)
]
if feature_importance_docs:
    db.owner_feature_importance.insert_many(feature_importance_docs)

# forecast next 5 days per room using last known row
db.owner_forecasts.delete_many({})
forecast_docs = []

for room_id, group in train_df.groupby("room_id"):
    latest = group.sort_values("date").iloc[-1].copy()
    current_date = latest["date"]

    for i in range(1, 6):
        future_date = current_date + pd.Timedelta(days=i)
        latest["day_of_week"] = future_date.dayofweek

        X_future = pd.DataFrame([latest[feature_cols]])
        pred_waste = float(rf.predict(X_future)[0])

        pred_total = max(
            float(latest["prev_day_energy"]),
            pred_waste + 0.5
        )

        forecast_docs.append({
            "room_id": room_id,
            "date": future_date.strftime("%Y-%m-%d"),
            "predicted_total_energy_kwh": round(pred_total, 4),
            "predicted_wasted_energy_kwh": round(max(pred_waste, 0), 4),
            "model_name": "random_forest"
        })

if forecast_docs:
    db.owner_forecasts.insert_many(forecast_docs)

# -------- 2. Anomaly Detection --------
anomaly_features = train_df[[
    "total_energy_kwh",
    "wasted_energy_kwh",
    "waste_ratio_percent",
    "avg_current",
    "door_open_count"
]]

iso = IsolationForest(contamination=0.15, random_state=42)
train_df["anomaly_flag"] = iso.fit_predict(anomaly_features)
train_df["anomaly_score"] = iso.decision_function(anomaly_features)

db.owner_anomalies.delete_many({})
anomaly_docs = []
for _, row in train_df.iterrows():
    anomaly_docs.append({
        "room_id": row["room_id"],
        "date": row["date"].strftime("%Y-%m-%d"),
        "anomaly_score": float(row["anomaly_score"]),
        "is_anomaly": bool(row["anomaly_flag"] == -1),
        "total_energy_kwh": float(row["total_energy_kwh"]),
        "wasted_energy_kwh": float(row["wasted_energy_kwh"])
    })
if anomaly_docs:
    db.owner_anomalies.insert_many(anomaly_docs)

# -------- 3. Behavior Pattern Analysis --------
cluster_features = train_df[[
    "total_energy_kwh",
    "wasted_energy_kwh",
    "waste_ratio_percent",
    "avg_current",
    "door_open_count"
]]

kmeans = KMeans(n_clusters=3, random_state=42, n_init=10)
train_df["cluster_label"] = kmeans.fit_predict(cluster_features)

pattern_names = {
    0: "Efficient Usage",
    1: "Moderate Waste",
    2: "High Waste Pattern"
}

db.owner_patterns.delete_many({})
pattern_docs = []
for _, row in train_df.iterrows():
    pattern_docs.append({
        "room_id": row["room_id"],
        "date": row["date"].strftime("%Y-%m-%d"),
        "cluster_label": int(row["cluster_label"]),
        "pattern_name": pattern_names.get(int(row["cluster_label"]), "Unknown")
    })
if pattern_docs:
    db.owner_patterns.insert_many(pattern_docs)

print("Owner ML analysis complete.")