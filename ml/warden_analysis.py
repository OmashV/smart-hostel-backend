import os
from datetime import timedelta

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from pymongo import MongoClient
from sklearn.cluster import KMeans
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

try:
    from prophet import Prophet
except Exception:
    Prophet = None

load_dotenv()

MONGO_URI = os.getenv("MONGO_URI")
DB_NAME = os.getenv("MONGO_DB", "smart_hostel")

if not MONGO_URI:
    raise SystemExit("MONGO_URI not found in .env")

client = MongoClient(MONGO_URI)
db = client[DB_NAME]

summary_docs = list(db.warden_hourly_summary.find({}, {"_id": 0}))
if len(summary_docs) < 8:
    raise SystemExit("Not enough warden hourly summary data")

df = pd.DataFrame(summary_docs)
df["date"] = pd.to_datetime(df["date"])
df["datetime"] = pd.to_datetime(df["date"].dt.strftime("%Y-%m-%d") + " " + df["hour"].astype(int).astype(str) + ":00:00")
df = df.sort_values(["room_id", "datetime"]).reset_index(drop=True)

feature_cols = [
    "occupied_count",
    "empty_count",
    "sleeping_count",
    "warning_count",
    "violation_count",
    "complaint_count",
    "avg_sound_peak",
    "avg_current",
    "door_open_count",
    "inspection_count",
]

for col in feature_cols:
    if col not in df.columns:
        df[col] = 0
    df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

ml_pipeline = Pipeline([
    ("imputer", SimpleImputer(strategy="median")),
    ("scaler", StandardScaler()),
])
X = ml_pipeline.fit_transform(df[feature_cols])

alert_model = IsolationForest(n_estimators=250, contamination="auto", random_state=42)
df["alert_prediction"] = alert_model.fit_predict(X)
df["alert_score"] = -alert_model.decision_function(X)

alert_rows = df[df["alert_prediction"] == -1].copy().sort_values("alert_score", ascending=False)
if not alert_rows.empty:
    alert_rows["score_rank"] = alert_rows["alert_score"].rank(method="average", pct=True)
else:
    alert_rows["score_rank"] = []

latest_sensor_docs = list(db.sensorreadings.find({}, {"_id": 0, "room_id": 1, "device_id": 1, "captured_at": 1}).sort("captured_at", -1))
latest_device_by_room = {}
for doc in latest_sensor_docs:
    room = doc.get("room_id")
    if room and room not in latest_device_by_room:
        latest_device_by_room[room] = doc.get("device_id", "")

alert_docs = []
for _, row in alert_rows.iterrows():
    rank = float(row.get("score_rank", 0))
    severity = "Critical" if rank >= 0.75 else "Warning"
    doc = {
        "room_id": str(row["room_id"]),
        "device_id": latest_device_by_room.get(row["room_id"], ""),
        "captured_at": row["datetime"].to_pydatetime(),
        "alert_type": "IsolationForest Operational Alert",
        "severity": severity,
        "title": f"{severity} warden ML alert",
        "message": "IsolationForest identified unusual room behaviour from occupancy, door, sound, current, complaint, and inspection signals.",
        "occupancy_stat": "ML-analyzed",
        "door_status": "ML-analyzed",
        "sound_peak": round(float(row["avg_sound_peak"]), 2),
        "current_amp": round(float(row["avg_current"]), 4),
        "anomaly_score": round(float(row["alert_score"]), 6),
        "confidence": round(min(0.99, 0.55 + abs(rank) * 0.44), 4),
        "model_name": "IsolationForest",
        "reason": "Generated from IsolationForest anomaly score across warden operational sensor features.",
        "evidence": [
            f"avg_sound_peak={round(float(row['avg_sound_peak']), 2)}",
            f"avg_current={round(float(row['avg_current']), 4)}",
            f"occupied_count={int(row['occupied_count'])}",
            f"door_open_count={int(row['door_open_count'])}",
            f"inspection_count={int(row['inspection_count'])}",
            f"model_score={round(float(row['alert_score']), 6)}",
        ],
        "status": "Active",
    }
    alert_docs.append(doc)
    db.warden_ml_alerts.update_one(
        {"room_id": doc["room_id"], "captured_at": doc["captured_at"], "alert_type": doc["alert_type"]},
        {"$set": doc},
        upsert=True,
    )

anomaly_model = IsolationForest(n_estimators=250, contamination="auto", random_state=84)
df["anomaly_prediction"] = anomaly_model.fit_predict(X)
df["anomaly_score"] = -anomaly_model.decision_function(X)

anomaly_docs = []
for _, row in df[df["anomaly_prediction"] == -1].sort_values("anomaly_score", ascending=False).iterrows():
    doc = {
        "room_id": str(row["room_id"]),
        "date": row["datetime"].strftime("%Y-%m-%d %H:%M:%S"),
        "status": "Abnormal",
        "reason": "IsolationForest detected an unusual combination of occupancy, sound, door, current, warning, complaint, and inspection signals.",
        "avg_sound_peak": round(float(row["avg_sound_peak"]), 2),
        "avg_current": round(float(row["avg_current"]), 4),
        "violation_count": int(row["violation_count"]),
        "anomaly_score": round(float(row["anomaly_score"]), 6),
        "model_name": "IsolationForest",
    }
    anomaly_docs.append(doc)
    db.warden_anomalies.update_one(
        {"room_id": doc["room_id"], "date": doc["date"]},
        {"$set": doc},
        upsert=True,
    )

def regression_forecast(room_df, target_col, periods=7):
    work = room_df[["datetime", target_col]].dropna().copy()
    work = work.sort_values("datetime")
    if len(work) < 3:
        return []
    if Prophet is not None and len(work) >= 6:
        prophet_df = work.rename(columns={"datetime": "ds", target_col: "y"})
        model = Prophet(daily_seasonality=True, weekly_seasonality=True, yearly_seasonality=False)
        model.fit(prophet_df)
        future = model.make_future_dataframe(periods=periods, freq="D")
        pred = model.predict(future)[["ds", "yhat"]].tail(periods)
        return [(r["ds"].to_pydatetime(), max(0.0, float(r["yhat"])), "Prophet") for _, r in pred.iterrows()]
    base = work["datetime"].min()
    work["x"] = (work["datetime"] - base).dt.total_seconds() / 86400.0
    model = LinearRegression()
    model.fit(work[["x"]], work[target_col])
    last_dt = work["datetime"].max()
    outputs = []
    for step in range(1, periods + 1):
        dt = last_dt + timedelta(days=step)
        x_val = (dt - base).total_seconds() / 86400.0
        y_val = float(model.predict([[x_val]])[0])
        outputs.append((dt, max(0.0, y_val), "LinearRegression"))
    return outputs

daily = (
    df.groupby(["room_id", df["datetime"].dt.date])
    .agg(
        occupied=("occupied_count", "sum"),
        warnings=("warning_count", "sum"),
        violations=("violation_count", "sum"),
    )
    .reset_index()
    .rename(columns={"datetime": "date"})
)
daily["datetime"] = pd.to_datetime(daily["date"])

forecast_docs = []
for room_id, room_df in daily.groupby("room_id"):
    occ_forecast = regression_forecast(room_df, "occupied", periods=7)
    warn_forecast = regression_forecast(room_df, "warnings", periods=7)
    viol_forecast = regression_forecast(room_df, "violations", periods=7)
    for idx in range(min(len(occ_forecast), len(warn_forecast), len(viol_forecast))):
        dt, occ_val, occ_model = occ_forecast[idx]
        _, warn_val, warn_model = warn_forecast[idx]
        _, viol_val, viol_model = viol_forecast[idx]
        doc = {
            "room_id": str(room_id),
            "date": dt.strftime("%Y-%m-%d"),
            "predicted_warning_count": round(float(warn_val), 4),
            "predicted_violation_count": round(float(viol_val), 4),
            "predicted_occupied_count": round(float(occ_val), 4),
            "model_name": occ_model if occ_model == warn_model == viol_model else "RegressionForecast",
        }
        forecast_docs.append(doc)
        db.warden_forecasts.update_one(
            {"room_id": doc["room_id"], "date": doc["date"]},
            {"$set": doc},
            upsert=True,
        )

pattern_base = df.copy()
pattern_base["day"] = pattern_base["datetime"].dt.day_name()
pattern_base["critical_event"] = (pattern_base["violation_count"] + pattern_base["complaint_count"] + pattern_base["inspection_count"]).astype(float)

def build_pattern_rows(source_df, room_id_value):
    rows = []
    grouped = source_df.groupby("day").agg(
        avg_occupancy=("occupied_count", "mean"),
        avg_noise_level=("avg_sound_peak", "mean"),
        avg_warnings=("warning_count", "mean"),
        avg_critical_ratio=("critical_event", "mean"),
    ).reset_index()
    for day in ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]:
        found = grouped[grouped["day"] == day]
        if found.empty:
            rows.append({
                "room_id": room_id_value,
                "day": day,
                "day_type": "Weekend" if day in ["Saturday", "Sunday"] else "Weekday",
                "avg_occupancy": 0.0,
                "avg_noise_level": 0.0,
                "avg_warnings": 0.0,
                "avg_critical_ratio": 0.0,
            })
        else:
            row = found.iloc[0]
            rows.append({
                "room_id": room_id_value,
                "day": day,
                "day_type": "Weekend" if day in ["Saturday", "Sunday"] else "Weekday",
                "avg_occupancy": float(row["avg_occupancy"]),
                "avg_noise_level": float(row["avg_noise_level"]),
                "avg_warnings": float(row["avg_warnings"]),
                "avg_critical_ratio": float(row["avg_critical_ratio"]),
            })
    return rows

pattern_rows = build_pattern_rows(pattern_base, "All")
for room_id, room_df in pattern_base.groupby("room_id"):
    pattern_rows.extend(build_pattern_rows(room_df, str(room_id)))

pattern_frame = pd.DataFrame(pattern_rows)
pattern_features = ["avg_occupancy", "avg_noise_level", "avg_warnings", "avg_critical_ratio"]
pattern_X = Pipeline([
    ("imputer", SimpleImputer(strategy="median")),
    ("scaler", StandardScaler()),
]).fit_transform(pattern_frame[pattern_features])
cluster_count = min(3, max(1, len(pattern_frame)))
pattern_model = KMeans(n_clusters=cluster_count, random_state=42, n_init=10)
pattern_frame["cluster_id"] = pattern_model.fit_predict(pattern_X)

centers = pd.DataFrame(
    pattern_model.cluster_centers_,
    columns=pattern_features,
)
center_strength = centers.abs().sum(axis=1).sort_values().index.tolist()
pattern_names = {}
labels = ["Stable Cleaning Window", "Moderate Monitoring Pattern", "High Attention Pattern"]
for pos, cluster_id in enumerate(center_strength):
    pattern_names[int(cluster_id)] = labels[min(pos, len(labels) - 1)]

pattern_docs = []
for _, row in pattern_frame.iterrows():
    cluster_id = int(row["cluster_id"])
    doc = {
        "room_id": str(row["room_id"]),
        "day": str(row["day"]),
        "day_type": str(row["day_type"]),
        "usual_pattern": pattern_names.get(cluster_id, "KMeans Pattern"),
        "avg_occupancy": round(float(row["avg_occupancy"]), 4),
        "avg_noise_level": round(float(row["avg_noise_level"]), 4),
        "avg_warnings": round(float(row["avg_warnings"]), 4),
        "avg_critical_ratio": round(float(row["avg_critical_ratio"]), 4),
        "cluster_id": cluster_id,
        "model_name": "KMeans",
    }
    pattern_docs.append(doc)
    db.warden_patterns.update_one(
        {"room_id": doc["room_id"], "day": doc["day"]},
        {"$set": doc},
        upsert=True,
    )

print("Warden ML analysis complete")
print("warden_ml_alerts:", len(alert_docs))
print("warden_anomalies:", len(anomaly_docs))
print("warden_forecasts:", len(forecast_docs))
print("warden_patterns:", len(pattern_docs))
