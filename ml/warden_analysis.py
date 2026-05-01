"""Real-data-only Warden analytics pipeline.
Inputs: MongoDB sensorreadings and warden_hourly_summary built from sensorreadings.
Outputs: warden_forecasts, warden_ml_alerts, warden_anomalies, warden_patterns.
"""
import os
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from pymongo import MongoClient
from sklearn.cluster import KMeans
from sklearn.ensemble import IsolationForest, RandomForestRegressor
from sklearn.preprocessing import StandardScaler

try:
    from prophet import Prophet
    PROPHET_AVAILABLE = True
except Exception:
    Prophet = None
    PROPHET_AVAILABLE = False

load_dotenv()
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/smart_hostel")
DB_NAME = os.getenv("MONGO_DB", os.getenv("DB_NAME", "smart_hostel"))
ORDERED_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
client = MongoClient(MONGO_URI)
db = client[DB_NAME]


def ensure_columns(df, defaults):
    for col, val in defaults.items():
        if col not in df.columns:
            df[col] = val
    return df


def safe_float(v, default=0.0):
    try:
        if pd.isna(v):
            return default
        return float(v)
    except Exception:
        return default


def _hourly_dataframe(hourly_docs):
    if not hourly_docs:
        return pd.DataFrame()
    df = pd.DataFrame(hourly_docs)
    df = ensure_columns(df, {
        "room_id": "Unknown", "date": None, "hour": 0,
        "occupied_count": 0, "empty_count": 0, "sleeping_count": 0,
        "warning_count": 0, "violation_count": 0, "complaint_count": 0,
        "avg_sound_peak": 0, "avg_current": 0, "door_open_count": 0,
        "inspection_count": 0,
    })
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["hour"] = pd.to_numeric(df["hour"], errors="coerce").fillna(0).astype(int)
    df["datetime"] = pd.to_datetime(
        df["date"].dt.strftime("%Y-%m-%d") + " " + df["hour"].astype(str) + ":00:00",
        errors="coerce"
    )
    df = df.dropna(subset=["datetime", "room_id"])
    df["source_type"] = "warden_hourly_summary"
    return df


def _sensor_dataframe(sensor_docs):
    if not sensor_docs:
        return pd.DataFrame()
    raw = pd.DataFrame(sensor_docs)
    raw = ensure_columns(raw, {
        "room_id": "Unknown", "captured_at": None, "motion_count": 0,
        "sound_peak": 0, "current_amp": 0, "door_status": "Unknown",
        "occupancy_stat": "Unknown", "noise_stat": "Normal", "needs_inspection": False,
    })
    raw["captured_at"] = pd.to_datetime(raw["captured_at"], errors="coerce")
    raw = raw.dropna(subset=["captured_at", "room_id"])
    raw["date"] = raw["captured_at"].dt.floor("D")
    raw["hour"] = raw["captured_at"].dt.hour
    raw["occupied_flag"] = raw["occupancy_stat"].astype(str).str.lower().str.contains("occupied|sleeping").astype(int)
    raw["empty_flag"] = raw["occupancy_stat"].astype(str).str.lower().str.contains("empty").astype(int)
    raw["sleeping_flag"] = raw["occupancy_stat"].astype(str).str.lower().str.contains("sleeping").astype(int)
    raw["warning_flag"] = raw["noise_stat"].astype(str).str.lower().str.contains("warning|complaint").astype(int)
    raw["violation_flag"] = raw["noise_stat"].astype(str).str.lower().str.contains("violation|critical").astype(int)
    raw["door_open_flag"] = raw["door_status"].astype(str).str.lower().str.contains("open").astype(int)
    raw["inspection_flag"] = raw["needs_inspection"].astype(bool).astype(int)
    df = raw.groupby(["room_id", "date", "hour"]).agg(
        occupied_count=("occupied_flag", "sum"), empty_count=("empty_flag", "sum"), sleeping_count=("sleeping_flag", "sum"),
        avg_sound_peak=("sound_peak", "mean"), avg_current=("current_amp", "mean"), door_open_count=("door_open_flag", "sum"),
        complaint_count=("warning_flag", "sum"), warning_count=("warning_flag", "sum"), violation_count=("violation_flag", "sum"),
        inspection_count=("inspection_flag", "sum"),
    ).reset_index()
    df["datetime"] = pd.to_datetime(df["date"].dt.strftime("%Y-%m-%d") + " " + df["hour"].astype(str) + ":00:00")
    df["source_type"] = "sensorreadings"
    return df


def load_source_dataframe():
    """Load only real Warden data.

    The pipeline uses only sources derived directly from sensorreadings for strict real-data mode.
    warden_hourly_summary is used first because it is generated directly from
    sensorreadings; raw sensorreadings fills any remaining rooms.
    """
    hourly_df = _hourly_dataframe(list(db.warden_hourly_summary.find({}, {"_id": 0})))
    sensor_df = _sensor_dataframe(list(db.sensorreadings.find({}, {"_id": 0})))

    frames = []
    used_rooms = set()

    if not hourly_df.empty:
        frames.append(hourly_df)
        used_rooms.update(hourly_df["room_id"].astype(str).unique())

    if not sensor_df.empty:
        missing_sensor = sensor_df[~sensor_df["room_id"].astype(str).isin(used_rooms)].copy()
        if not missing_sensor.empty:
            frames.append(missing_sensor)

    if not frames:
        return pd.DataFrame()

    merged = pd.concat(frames, ignore_index=True, sort=False)
    merged["source_type"] = merged["source_type"].fillna("real_mongodb")
    return merged

def add_time_features(df):
    df = df.copy()
    df["datetime"] = pd.to_datetime(df["datetime"])
    df["date_only"] = df["datetime"].dt.floor("D")
    df["day_name"] = df["datetime"].dt.day_name()
    df["day_of_week"] = df["datetime"].dt.dayofweek
    df["hour"] = df["datetime"].dt.hour
    for col in ["occupied_count", "empty_count", "sleeping_count", "avg_sound_peak", "avg_current", "door_open_count", "complaint_count", "warning_count", "violation_count", "inspection_count"]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    return df


def train_forecasts(df):
    db.warden_forecasts.delete_many({})
    docs = []
    daily = df.groupby(["room_id", "date_only"]).agg(
        occupied_count=("occupied_count", "sum"), warning_count=("warning_count", "sum"), violation_count=("violation_count", "sum"),
        avg_sound_peak=("avg_sound_peak", "mean"), avg_current=("avg_current", "mean"), inspection_count=("inspection_count", "sum"),
    ).reset_index().sort_values(["room_id", "date_only"])
    if daily.empty:
        return
    daily["day_of_week"] = daily["date_only"].dt.dayofweek
    global_min = daily["date_only"].min()
    daily["day_index"] = (daily["date_only"] - global_min).dt.days
    for room_id, room_daily in daily.groupby("room_id"):
        if len(room_daily) < 2:
            continue
        last_date = room_daily["date_only"].max()
        future_dates = [last_date + timedelta(days=i) for i in range(1, 8)]
        predictions = {}
        if PROPHET_AVAILABLE and len(room_daily) >= 7:
            model_name = "Prophet"
            for target, out in [("occupied_count", "predicted_occupied_count"), ("warning_count", "predicted_warning_count"), ("violation_count", "predicted_violation_count")]:
                model = Prophet(daily_seasonality=False, weekly_seasonality=True, yearly_seasonality=False)
                model.fit(room_daily[["date_only", target]].rename(columns={"date_only": "ds", target: "y"}))
                predictions[out] = model.predict(pd.DataFrame({"ds": future_dates}))["yhat"].clip(lower=0).tolist()
        else:
            model_name = "RandomForestRegressor"
            features = ["day_index", "day_of_week", "avg_sound_peak", "avg_current", "inspection_count"]
            future = pd.DataFrame({
                "day_index": [(d - global_min).days for d in future_dates],
                "day_of_week": [d.dayofweek for d in future_dates],
                "avg_sound_peak": [room_daily["avg_sound_peak"].tail(3).mean()] * 7,
                "avg_current": [room_daily["avg_current"].tail(3).mean()] * 7,
                "inspection_count": [room_daily["inspection_count"].tail(3).mean()] * 7,
            })
            for target, out in [("occupied_count", "predicted_occupied_count"), ("warning_count", "predicted_warning_count"), ("violation_count", "predicted_violation_count")]:
                model = RandomForestRegressor(n_estimators=200, random_state=42)
                model.fit(room_daily[features].fillna(0), room_daily[target].fillna(0))
                predictions[out] = np.clip(model.predict(future[features].fillna(0)), 0, None).tolist()
        for i, d in enumerate(future_dates):
            docs.append({"room_id": str(room_id), "date": d.strftime("%Y-%m-%d"), "predicted_occupied_count": round(float(predictions["predicted_occupied_count"][i]), 4), "predicted_warning_count": round(float(predictions["predicted_warning_count"][i]), 4), "predicted_violation_count": round(float(predictions["predicted_violation_count"][i]), 4), "model_name": model_name, "generated_at": datetime.utcnow()})
    if docs:
        db.warden_forecasts.insert_many(docs)
    print("warden_forecasts:", len(docs))


def train_anomalies_and_alerts(df):
    db.warden_anomalies.delete_many({})
    db.warden_ml_alerts.delete_many({})
    db.warden_feature_importance.delete_many({})
    features = ["occupied_count", "empty_count", "sleeping_count", "avg_sound_peak", "avg_current", "door_open_count", "complaint_count", "warning_count", "violation_count", "inspection_count", "hour", "day_of_week"]
    if len(df) < 8:
        return
    X = df[features].fillna(0)
    scaled = StandardScaler().fit_transform(X)
    model = IsolationForest(contamination="auto", random_state=42)
    flags = model.fit_predict(scaled)
    raw_scores = -model.decision_function(scaled)
    norm = (raw_scores - raw_scores.min()) / (raw_scores.max() - raw_scores.min() + 1e-9)
    df = df.copy()
    df["anomaly_flag"] = flags
    df["anomaly_score"] = norm
    anomalies = df[df["anomaly_flag"] == -1].copy()
    anomaly_docs, alert_docs = [], []
    for _, row in anomalies.iterrows():
        score = safe_float(row["anomaly_score"])
        severity = "Critical"
        captured = pd.to_datetime(row["datetime"]).strftime("%Y-%m-%d %H:%M:%S")
        reason = "IsolationForest detected behavior outside the learned normal room profile"
        anomaly_docs.append({"room_id": str(row["room_id"]), "date": captured, "status": "Abnormal", "reason": reason, "avg_sound_peak": round(safe_float(row["avg_sound_peak"]), 2), "avg_current": round(safe_float(row["avg_current"]), 4), "violation_count": int(safe_float(row["violation_count"])), "anomaly_score": round(score, 4), "model_name": "IsolationForest"})
        alert_docs.append({"room_id": str(row["room_id"]), "captured_at": captured, "evidence_at": captured, "display_at": datetime.utcnow(), "generated_at": datetime.utcnow(), "alert_type": "ML Anomaly Alert", "severity": severity, "confidence": round(score, 4), "model_name": "IsolationForest", "reason": "ML alert generated from learned multi-sensor behavior anomaly score", "source_anomaly_score": round(score, 4)})
    if anomaly_docs:
        db.warden_anomalies.insert_many(anomaly_docs)
    if alert_docs:
        db.warden_ml_alerts.insert_many(alert_docs)
    try:
        y = (df["anomaly_flag"] == -1).astype(int)
        if y.nunique() > 1:
            rf = RandomForestRegressor(n_estimators=200, random_state=42)
            rf.fit(X, y)
            db.warden_feature_importance.insert_many([{"feature": f, "importance": round(float(v), 6), "model_name": "RandomForestRegressor"} for f, v in zip(features, rf.feature_importances_)])
    except Exception as e:
        print("feature importance skipped", e)
    print("warden_anomalies:", len(anomaly_docs), "warden_ml_alerts:", len(alert_docs))


def train_weekly_patterns(df):
    # Older builds created a unique MongoDB index on {room_id, date}.
    # Weekly pattern rows are keyed by {room_id, day}, so remove the old index if it exists.
    try:
        existing_indexes = db.warden_patterns.index_information()
        if "room_id_1_date_1" in existing_indexes:
            db.warden_patterns.drop_index("room_id_1_date_1")
    except Exception as e:
        print("warden_patterns old index cleanup skipped", e)
    db.warden_patterns.delete_many({})
    features = ["occupied_count", "avg_sound_peak", "warning_count", "violation_count", "inspection_count", "avg_current"]
    if len(df) < 8:
        return
    work = df.copy()
    n_clusters = min(4, max(2, len(work) // 5))
    work["cluster_id"] = KMeans(n_clusters=n_clusters, random_state=42, n_init=10).fit_predict(StandardScaler().fit_transform(work[features].fillna(0)))
    profiles = work.groupby("cluster_id")[["avg_sound_peak", "warning_count", "violation_count", "inspection_count"]].mean().reset_index()
    profiles["risk_score"] = profiles[["avg_sound_peak", "warning_count", "violation_count", "inspection_count"]].rank(pct=True).sum(axis=1)
    ordered = profiles.sort_values("risk_score")["cluster_id"].tolist()
    labels = ["Normal Pattern", "Moderate Noise", "Inspection Needed", "High Noise Pattern"]
    cluster_label = {int(cid): labels[min(i, len(labels)-1)] for i, cid in enumerate(ordered)}
    docs = []
    def doc(room_id, day, day_df):
        if day_df.empty:
            return {"room_id": room_id, "day": day, "date": day, "day_type": "Weekend" if day in ["Saturday", "Sunday"] else "Weekday", "usual_pattern": "No Data", "avg_occupancy": 0, "avg_noise_level": 0, "avg_warnings": 0, "avg_critical_ratio": 0, "cluster_id": -1, "record_count": 0, "model_name": "KMeans"}
        cid = int(day_df["cluster_id"].mode().iloc[0])
        return {"room_id": room_id, "day": day, "date": day, "day_type": "Weekend" if day in ["Saturday", "Sunday"] else "Weekday", "usual_pattern": cluster_label.get(cid, "Pattern Detected"), "avg_occupancy": round(float(day_df["occupied_count"].mean()), 2), "avg_noise_level": round(float(day_df["avg_sound_peak"].mean()), 2), "avg_warnings": round(float(day_df["warning_count"].mean()), 2), "avg_critical_ratio": round(float((day_df["violation_count"].fillna(0) > 0).mean() * 100), 2), "cluster_id": cid, "record_count": int(len(day_df)), "model_name": "KMeans"}
    for room_id in sorted(work["room_id"].astype(str).unique()):
        room_df = work[work["room_id"].astype(str) == room_id]
        for day in ORDERED_DAYS:
            docs.append(doc(room_id, day, room_df[room_df["day_name"] == day]))
    for day in ORDERED_DAYS:
        docs.append(doc("All", day, work[work["day_name"] == day]))
    db.warden_patterns.insert_many(docs)
    print("warden_patterns:", len(docs))


def main():
    df = load_source_dataframe()
    if df.empty:
        print("No data found in warden_hourly_summary or sensorreadings")
        return
    df = add_time_features(df).sort_values(["room_id", "datetime"])
    print("Rows:", len(df), "Rooms:", df["room_id"].nunique(), "Sources:", sorted(df["source_type"].astype(str).unique()))
    train_forecasts(df)
    train_anomalies_and_alerts(df)
    train_weekly_patterns(df)
    for name in ["sensorreadings", "warden_hourly_summary", "warden_forecasts", "warden_anomalies", "warden_patterns", "warden_ml_alerts"]:
        print(name + ":", db[name].count_documents({}))
    print("Warden ML analysis complete.")


if __name__ == "__main__":
    main()
