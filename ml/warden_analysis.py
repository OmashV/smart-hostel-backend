"""
Final Warden ML pipeline for Smart Hostel Assignment 02.

Run from backend root:
  python ml/warden_analysis.py
"""

import os
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from pymongo import MongoClient, ASCENDING
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

ORDERED_DAYS = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday"
]

client = MongoClient(MONGO_URI)
db = client[DB_NAME]


def now_utc():
    return datetime.now(timezone.utc)


def safe_number(value, default=0.0):
    try:
        if pd.isna(value):
            return default
        return float(value)
    except Exception:
        return default


def ensure_columns(frame, defaults):
    for column, default in defaults.items():
        if column not in frame.columns:
            frame[column] = default
    return frame


def load_source_dataframe():
    hourly_docs = list(db.warden_hourly_summary.find({}, {"_id": 0}))

    if hourly_docs:
        df = pd.DataFrame(hourly_docs)

        df = ensure_columns(df, {
            "room_id": "Unknown",
            "date": None,
            "hour": 0,
            "occupied_count": 0,
            "empty_count": 0,
            "sleeping_count": 0,
            "avg_sound_peak": 0,
            "avg_current": 0,
            "door_open_count": 0,
            "complaint_count": 0,
            "warning_count": 0,
            "violation_count": 0,
            "inspection_count": 0,
        })

        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df["hour"] = pd.to_numeric(df["hour"], errors="coerce").fillna(0).astype(int)

        df["datetime"] = pd.to_datetime(
            df["date"].dt.strftime("%Y-%m-%d") + " " + df["hour"].astype(str) + ":00:00",
            errors="coerce"
        )

        df = df.dropna(subset=["datetime"])
        df["source_type"] = "warden_hourly_summary"
        return df

    sensor_docs = list(db.sensorreadings.find({}, {"_id": 0}))

    if not sensor_docs:
        return pd.DataFrame()

    raw = pd.DataFrame(sensor_docs)

    raw = ensure_columns(raw, {
        "room_id": "Unknown",
        "captured_at": None,
        "motion_count": 0,
        "sound_peak": 0,
        "current_amp": 0,
        "door_status": "Unknown",
        "occupancy_stat": "Unknown",
        "noise_stat": "Normal",
        "waste_stat": "Normal",
        "needs_inspection": False,
    })

    raw["captured_at"] = pd.to_datetime(raw["captured_at"], errors="coerce")
    raw = raw.dropna(subset=["captured_at"])

    raw["date"] = raw["captured_at"].dt.floor("D")
    raw["hour"] = raw["captured_at"].dt.hour

    raw["occupied_flag"] = (
        raw["occupancy_stat"].astype(str).str.lower()
        .str.contains("occupied|sleeping")
        .astype(int)
    )
    raw["empty_flag"] = (
        raw["occupancy_stat"].astype(str).str.lower()
        .str.contains("empty")
        .astype(int)
    )
    raw["sleeping_flag"] = (
        raw["occupancy_stat"].astype(str).str.lower()
        .str.contains("sleeping")
        .astype(int)
    )
    raw["warning_flag"] = (
        raw["noise_stat"].astype(str).str.lower()
        .str.contains("warning|complaint")
        .astype(int)
    )
    raw["violation_flag"] = (
        raw["noise_stat"].astype(str).str.lower()
        .str.contains("violation|critical")
        .astype(int)
    )
    raw["door_open_flag"] = (
        raw["door_status"].astype(str).str.lower()
        .str.contains("open")
        .astype(int)
    )
    raw["inspection_flag"] = raw["needs_inspection"].astype(bool).astype(int)

    df = (
        raw.groupby(["room_id", "date", "hour"])
        .agg(
            occupied_count=("occupied_flag", "sum"),
            empty_count=("empty_flag", "sum"),
            sleeping_count=("sleeping_flag", "sum"),
            avg_sound_peak=("sound_peak", "mean"),
            avg_current=("current_amp", "mean"),
            door_open_count=("door_open_flag", "sum"),
            complaint_count=("warning_flag", "sum"),
            warning_count=("warning_flag", "sum"),
            violation_count=("violation_flag", "sum"),
            inspection_count=("inspection_flag", "sum"),
        )
        .reset_index()
    )

    df["datetime"] = pd.to_datetime(
        df["date"].dt.strftime("%Y-%m-%d") + " " + df["hour"].astype(str) + ":00:00",
        errors="coerce"
    )

    df = df.dropna(subset=["datetime"])
    df["source_type"] = "sensorreadings"

    return df


def add_time_features(df):
    df = df.copy()
    df["date_only"] = pd.to_datetime(df["datetime"]).dt.date
    df["day_name"] = pd.to_datetime(df["datetime"]).dt.day_name()
    df["day_of_week"] = pd.to_datetime(df["datetime"]).dt.dayofweek
    df["hour"] = pd.to_datetime(df["datetime"]).dt.hour
    return df


def train_forecasts(df):
    db.warden_forecasts.delete_many({})
    docs = []

    daily = (
        df.groupby(["room_id", "date_only"])
        .agg(
            occupied_count=("occupied_count", "sum"),
            warning_count=("warning_count", "sum"),
            violation_count=("violation_count", "sum"),
            avg_sound_peak=("avg_sound_peak", "mean"),
            avg_current=("avg_current", "mean"),
            inspection_count=("inspection_count", "sum"),
        )
        .reset_index()
    )

    daily["date_only"] = pd.to_datetime(daily["date_only"])
    daily["day_of_week"] = daily["date_only"].dt.dayofweek
    daily["day_index"] = (daily["date_only"] - daily["date_only"].min()).dt.days

    for room_id, room_daily in daily.groupby("room_id"):
        room_daily = room_daily.sort_values("date_only")

        if len(room_daily) < 3:
            continue

        last_date = room_daily["date_only"].max()
        future_dates = [last_date + timedelta(days=i) for i in range(1, 8)]

        if PROPHET_AVAILABLE and len(room_daily) >= 7:
            model_name = "Prophet"
            predictions = {}

            for target, output_name in [
                ("occupied_count", "predicted_occupied_count"),
                ("warning_count", "predicted_warning_count"),
                ("violation_count", "predicted_violation_count"),
            ]:
                train_df = room_daily[["date_only", target]].rename(
                    columns={"date_only": "ds", target: "y"}
                )

                model = Prophet(
                    daily_seasonality=False,
                    weekly_seasonality=True,
                    yearly_seasonality=False
                )

                model.fit(train_df)

                forecast = model.predict(
                    pd.DataFrame({"ds": future_dates})
                )[["ds", "yhat"]]

                predictions[output_name] = forecast["yhat"].clip(lower=0).tolist()

        else:
            model_name = "RandomForestRegressor"
            predictions = {}

            feature_cols = [
                "day_index",
                "day_of_week",
                "avg_sound_peak",
                "avg_current",
                "inspection_count",
            ]

            future_frame = pd.DataFrame({
                "date_only": future_dates,
                "day_of_week": [d.dayofweek for d in future_dates],
                "day_index": [(d - daily["date_only"].min()).days for d in future_dates],
                "avg_sound_peak": [room_daily["avg_sound_peak"].tail(3).mean()] * 7,
                "avg_current": [room_daily["avg_current"].tail(3).mean()] * 7,
                "inspection_count": [room_daily["inspection_count"].tail(3).mean()] * 7,
            })

            for target, output_name in [
                ("occupied_count", "predicted_occupied_count"),
                ("warning_count", "predicted_warning_count"),
                ("violation_count", "predicted_violation_count"),
            ]:
                model = RandomForestRegressor(n_estimators=200, random_state=42)
                model.fit(
                    room_daily[feature_cols].fillna(0),
                    room_daily[target].fillna(0)
                )

                predictions[output_name] = np.clip(
                    model.predict(future_frame[feature_cols].fillna(0)),
                    0,
                    None
                ).tolist()

        for idx, forecast_date in enumerate(future_dates):
            docs.append({
                "room_id": str(room_id),
                "date": forecast_date.strftime("%Y-%m-%d"),
                "predicted_occupied_count": round(float(predictions["predicted_occupied_count"][idx]), 4),
                "predicted_warning_count": round(float(predictions["predicted_warning_count"][idx]), 4),
                "predicted_violation_count": round(float(predictions["predicted_violation_count"][idx]), 4),
                "model_name": model_name,
                "generated_at": now_utc(),
            })

    if docs:
        db.warden_forecasts.insert_many(docs)

    print("warden_forecasts:", len(docs))


def train_anomalies_and_alerts(df):
    db.warden_anomalies.delete_many({})
    db.warden_ml_alerts.delete_many({})
    db.warden_feature_importance.delete_many({})

    feature_cols = [
        "occupied_count",
        "empty_count",
        "sleeping_count",
        "avg_sound_peak",
        "avg_current",
        "door_open_count",
        "complaint_count",
        "warning_count",
        "violation_count",
        "inspection_count",
        "hour",
        "day_of_week",
    ]

    data = df[feature_cols].fillna(0)

    if len(data) < 8:
        print("Not enough data for anomaly/alert models")
        return

    scaler = StandardScaler()
    scaled = scaler.fit_transform(data)

    iso = IsolationForest(contamination="auto", random_state=42)
    anomaly_flags = iso.fit_predict(scaled)

    raw_scores = -iso.decision_function(scaled)
    score_min = float(np.min(raw_scores))
    score_max = float(np.max(raw_scores))
    normalized_scores = (raw_scores - score_min) / (score_max - score_min + 1e-9)

    df = df.copy()
    df["anomaly_flag"] = anomaly_flags
    df["anomaly_score"] = normalized_scores

    anomaly_rows = df[df["anomaly_flag"] == -1].copy()

    if not anomaly_rows.empty:
        critical_cutoff = float(anomaly_rows["anomaly_score"].quantile(0.75))
    else:
        critical_cutoff = 1.0

    try:
        explanation_target = (df["anomaly_flag"] == -1).astype(int)

        if explanation_target.nunique() > 1:
            rf = RandomForestRegressor(n_estimators=200, random_state=42)
            rf.fit(data, explanation_target)

            feature_docs = [
                {
                    "feature": feature,
                    "importance": round(float(importance), 6),
                    "model_name": "RandomForestRegressor",
                    "generated_at": now_utc(),
                }
                for feature, importance in zip(feature_cols, rf.feature_importances_)
            ]

            if feature_docs:
                db.warden_feature_importance.insert_many(feature_docs)

    except Exception as error:
        print("Feature importance skipped:", error)

    anomaly_docs = []
    alert_docs = []

    for _, row in df.iterrows():
        if int(row["anomaly_flag"]) != -1:
            continue

        captured = pd.to_datetime(row["datetime"]).strftime("%Y-%m-%d %H:%M:%S")
        score = safe_number(row["anomaly_score"])
        severity = "Critical" if score >= critical_cutoff else "Warning"

        anomaly_docs.append({
            "room_id": str(row["room_id"]),
            "date": captured,
            "status": "Abnormal",
            "reason": "IsolationForest detected behavior outside the learned normal room profile",
            "avg_sound_peak": round(safe_number(row["avg_sound_peak"]), 2),
            "avg_current": round(safe_number(row["avg_current"]), 4),
            "violation_count": int(safe_number(row["violation_count"])),
            "anomaly_score": round(score, 4),
            "model_name": "IsolationForest",
            "generated_at": now_utc(),
        })

        alert_docs.append({
            "room_id": str(row["room_id"]),
            "captured_at": captured,
            "alert_type": "ML Anomaly Alert",
            "severity": severity,
            "confidence": round(score, 4),
            "model_name": "IsolationForest",
            "reason": (
                "ML alert generated from IsolationForest anomaly score "
                "learned from multi-sensor room behavior"
            ),
            "source_anomaly_score": round(score, 4),
            "source_alert_probability": round(score, 4),
            "generated_at": now_utc(),
        })

    if anomaly_docs:
        db.warden_anomalies.insert_many(anomaly_docs)

    if alert_docs:
        db.warden_ml_alerts.insert_many(alert_docs)

    print("warden_anomalies:", len(anomaly_docs))
    print("warden_ml_alerts:", len(alert_docs))


def train_weekly_patterns(df):
    db.warden_patterns.drop_indexes()
    db.warden_patterns.delete_many({})

    db.warden_patterns.create_index(
        [("room_id", ASCENDING), ("day", ASCENDING)],
        unique=True
    )

    feature_cols = [
        "occupied_count",
        "avg_sound_peak",
        "warning_count",
        "violation_count",
        "inspection_count",
        "avg_current",
    ]

    if len(df) < 8:
        print("Not enough data for KMeans weekly patterns")
        return

    scaler = StandardScaler()
    scaled = scaler.fit_transform(df[feature_cols].fillna(0))

    n_clusters = min(4, max(2, len(df) // 5))

    kmeans = KMeans(
        n_clusters=n_clusters,
        random_state=42,
        n_init=10
    )

    df = df.copy()
    df["cluster_id"] = kmeans.fit_predict(scaled)

    cluster_profile = (
        df.groupby("cluster_id")[[
            "avg_sound_peak",
            "warning_count",
            "violation_count",
            "inspection_count",
        ]]
        .mean()
        .reset_index()
    )

    cluster_profile["risk_score"] = (
        cluster_profile["avg_sound_peak"] * 0.35
        + cluster_profile["warning_count"] * 8
        + cluster_profile["violation_count"] * 14
        + cluster_profile["inspection_count"] * 5
    )

    ordered = cluster_profile.sort_values("risk_score")["cluster_id"].tolist()

    labels = [
        "Normal Pattern",
        "Moderate Noise",
        "Inspection Needed",
        "High Noise Pattern",
    ]

    cluster_to_pattern = {}

    for idx, cluster_id in enumerate(ordered):
        cluster_to_pattern[int(cluster_id)] = labels[min(idx, len(labels) - 1)]

    def build_day_doc(room_id, day, day_df):
        if day_df.empty:
            return {
                "room_id": str(room_id),
                "day": day,
                "day_type": "Weekend" if day in ["Saturday", "Sunday"] else "Weekday",
                "cluster_id": -1,
                "usual_pattern": "No Data",
                "avg_occupancy": 0,
                "avg_noise_level": 0,
                "avg_warnings": 0,
                "avg_critical_ratio": 0,
                "record_count": 0,
                "model_name": "KMeans",
                "generated_at": now_utc(),
            }

        cluster_id = int(day_df["cluster_id"].mode().iloc[0])
        critical_ratio = float((day_df["violation_count"].fillna(0) > 0).mean() * 100)

        return {
            "room_id": str(room_id),
            "day": day,
            "day_type": "Weekend" if day in ["Saturday", "Sunday"] else "Weekday",
            "cluster_id": cluster_id,
            "usual_pattern": cluster_to_pattern.get(cluster_id, "Pattern Detected"),
            "avg_occupancy": round(float(day_df["occupied_count"].mean()), 2),
            "avg_noise_level": round(float(day_df["avg_sound_peak"].mean()), 2),
            "avg_warnings": round(float(day_df["warning_count"].mean()), 2),
            "avg_critical_ratio": round(critical_ratio, 2),
            "record_count": int(len(day_df)),
            "model_name": "KMeans",
            "generated_at": now_utc(),
        }

    docs = []
    all_room_ids = sorted(df["room_id"].astype(str).unique())

    for room_id in all_room_ids:
        room_df = df[df["room_id"].astype(str) == room_id]

        for day in ORDERED_DAYS:
            day_df = room_df[room_df["day_name"] == day]
            docs.append(build_day_doc(room_id, day, day_df))

    for day in ORDERED_DAYS:
        day_df = df[df["day_name"] == day]
        docs.append(build_day_doc("All", day, day_df))

    if docs:
        db.warden_patterns.insert_many(docs)

    print("warden_patterns:", len(docs))


def main():
    print("Loading data...")

    df = load_source_dataframe()

    if df.empty:
        print("No warden_hourly_summary or sensorreadings data found.")
        print("Run your data generator/backfill script first.")
        return

    df = add_time_features(df)
    df = df.sort_values(["room_id", "datetime"])

    numeric_cols = [
        "occupied_count",
        "empty_count",
        "sleeping_count",
        "avg_sound_peak",
        "avg_current",
        "door_open_count",
        "complaint_count",
        "warning_count",
        "violation_count",
        "inspection_count",
    ]

    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    print(
        f"Rows: {len(df)}  "
        f"Rooms: {df['room_id'].nunique()}  "
        f"Source: {df['source_type'].iloc[0]}"
    )

    print("Room IDs:", sorted(df["room_id"].astype(str).unique()))

    train_forecasts(df)
    train_anomalies_and_alerts(df)
    train_weekly_patterns(df)

    print("\nFinal collection counts:")

    for name in [
        "sensorreadings",
        "warden_hourly_summary",
        "warden_forecasts",
        "warden_anomalies",
        "warden_patterns",
        "warden_ml_alerts",
        "warden_feature_importance",
    ]:
        print(f"  {name}: {db[name].count_documents({})}")

    print("\nWarden ML analysis complete.")


if __name__ == "__main__":
    main()