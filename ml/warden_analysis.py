"""Real-data-only Warden analytics pipeline.

Inputs:
- sensorreadings
- warden_hourly_summary built from sensorreadings
- daily_room_summary built from sensorreadings

Outputs:
- warden_forecasts
- warden_ml_alerts
- warden_anomalies
- warden_patterns
"""

import os
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.errors import BulkWriteError
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


def utc_now():
    return datetime.utcnow()


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


def safe_insert_many(collection, docs):
    if not docs:
        return

    try:
        collection.insert_many(docs, ordered=False)
    except BulkWriteError as e:
        inserted = e.details.get("nInserted", 0)
        print(f"{collection.name}: duplicate rows skipped, inserted {inserted}")


def cleanup_old_indexes():
    for collection_name in ["warden_anomalies", "warden_ml_alerts", "warden_patterns"]:
        try:
            indexes = db[collection_name].index_information()

            if "room_id_1_date_1" in indexes:
                db[collection_name].drop_index("room_id_1_date_1")

            if "room_id_1_captured_at_1" in indexes:
                db[collection_name].drop_index("room_id_1_captured_at_1")

        except Exception as e:
            print(f"{collection_name} index cleanup skipped:", e)


def _hourly_dataframe(hourly_docs):
    if not hourly_docs:
        return pd.DataFrame()

    df = pd.DataFrame(hourly_docs)

    df = ensure_columns(df, {
        "room_id": "Unknown",
        "date": None,
        "hour": 0,
        "occupied_count": 0,
        "empty_count": 0,
        "sleeping_count": 0,
        "warning_count": 0,
        "violation_count": 0,
        "complaint_count": 0,
        "avg_sound_peak": 0,
        "avg_current": 0,
        "door_open_count": 0,
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
        "room_id": "Unknown",
        "captured_at": None,
        "motion_count": 0,
        "sound_peak": 0,
        "current_amp": 0,
        "door_status": "Unknown",
        "occupancy_stat": "Unknown",
        "noise_stat": "Normal",
        "needs_inspection": False,
    })

    raw["captured_at"] = pd.to_datetime(raw["captured_at"], errors="coerce")
    raw = raw.dropna(subset=["captured_at", "room_id"])

    raw["date"] = raw["captured_at"].dt.floor("D")
    raw["hour"] = raw["captured_at"].dt.hour

    status = raw["occupancy_stat"].astype(str).str.lower()
    noise = raw["noise_stat"].astype(str).str.lower()
    door = raw["door_status"].astype(str).str.lower()

    raw["occupied_flag"] = status.str.contains("occupied|sleeping", regex=True).astype(int)
    raw["empty_flag"] = status.str.contains("empty", regex=True).astype(int)
    raw["sleeping_flag"] = status.str.contains("sleeping", regex=True).astype(int)

    raw["warning_flag"] = noise.str.contains("warning|complaint", regex=True).astype(int)
    raw["violation_flag"] = noise.str.contains("violation|critical", regex=True).astype(int)

    raw["door_open_flag"] = door.str.contains("open", regex=True).astype(int)
    raw["inspection_flag"] = raw["needs_inspection"].astype(bool).astype(int)

    df = raw.groupby(["room_id", "date", "hour"]).agg(
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
    ).reset_index()

    df["datetime"] = pd.to_datetime(
        df["date"].dt.strftime("%Y-%m-%d") + " " + df["hour"].astype(str) + ":00:00",
        errors="coerce"
    )

    df["source_type"] = "sensorreadings"

    return df


def _daily_dataframe(daily_docs):
    if not daily_docs:
        return pd.DataFrame()

    df = pd.DataFrame(daily_docs)

    df = ensure_columns(df, {
        "room_id": "Unknown",
        "date": None,
        "occupied_count": 0,
        "empty_count": 0,
        "sleeping_count": 0,
        "warning_count": 0,
        "violation_count": 0,
        "complaint_count": 0,
        "avg_sound_peak": 0,
        "avg_current": 0,
        "door_open_count": 0,
        "inspection_count": 0,
        "total_motion_count": 0,
        "critical_count": 0,
        "avg_noise_level": 0,
    })

    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date", "room_id"])

    df["hour"] = 12
    df["datetime"] = pd.to_datetime(
        df["date"].dt.strftime("%Y-%m-%d") + " 12:00:00",
        errors="coerce"
    )

    df["occupied_count"] = pd.to_numeric(df["occupied_count"], errors="coerce").fillna(0)

    if df["occupied_count"].sum() == 0:
        df["occupied_count"] = pd.to_numeric(
            df["total_motion_count"],
            errors="coerce"
        ).fillna(0)

    df["avg_sound_peak"] = pd.to_numeric(
        df["avg_sound_peak"],
        errors="coerce"
    ).fillna(0)

    fallback_noise = pd.to_numeric(
        df["avg_noise_level"],
        errors="coerce"
    ).fillna(0)

    df.loc[df["avg_sound_peak"] == 0, "avg_sound_peak"] = fallback_noise

    df["violation_count"] = (
        pd.to_numeric(df["violation_count"], errors="coerce").fillna(0) +
        pd.to_numeric(df["critical_count"], errors="coerce").fillna(0)
    )

    df["source_type"] = "daily_room_summary"

    return df


def load_source_dataframe():
    daily_df = _daily_dataframe(list(db.daily_room_summary.find({}, {"_id": 0})))
    hourly_df = _hourly_dataframe(list(db.warden_hourly_summary.find({}, {"_id": 0})))
    sensor_df = _sensor_dataframe(list(db.sensorreadings.find({}, {"_id": 0})))

    frames = []

    if not daily_df.empty:
        frames.append(daily_df)

    if not hourly_df.empty:
        frames.append(hourly_df)

    if not sensor_df.empty:
        frames.append(sensor_df)

    if not frames:
        return pd.DataFrame()

    merged = pd.concat(frames, ignore_index=True, sort=False)
    merged = merged.dropna(subset=["room_id", "datetime"])
    merged["source_type"] = merged["source_type"].fillna("real_mongodb")

    return merged


def add_time_features(df):
    df = df.copy()

    df["datetime"] = pd.to_datetime(df["datetime"], errors="coerce")
    df = df.dropna(subset=["datetime", "room_id"])

    df["date_only"] = df["datetime"].dt.floor("D")
    df["day_name"] = df["datetime"].dt.day_name()
    df["day_of_week"] = df["datetime"].dt.dayofweek
    df["hour"] = df["datetime"].dt.hour

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
        "inspection_count"
    ]

    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    return df


def train_forecasts(df):
    db.warden_forecasts.delete_many({})

    docs = []

    daily = df.groupby(["room_id", "date_only"]).agg(
        occupied_count=("occupied_count", "sum"),
        warning_count=("warning_count", "sum"),
        violation_count=("violation_count", "sum"),
        avg_sound_peak=("avg_sound_peak", "mean"),
        avg_current=("avg_current", "mean"),
        inspection_count=("inspection_count", "sum"),
    ).reset_index().sort_values(["room_id", "date_only"])

    if daily.empty:
        print("warden_forecasts: 0")
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

            for target, out in [
                ("occupied_count", "predicted_occupied_count"),
                ("warning_count", "predicted_warning_count"),
                ("violation_count", "predicted_violation_count")
            ]:
                model = Prophet(
                    daily_seasonality=False,
                    weekly_seasonality=True,
                    yearly_seasonality=False
                )

                model.fit(
                    room_daily[["date_only", target]]
                    .rename(columns={"date_only": "ds", target: "y"})
                )

                predictions[out] = (
                    model.predict(pd.DataFrame({"ds": future_dates}))["yhat"]
                    .clip(lower=0)
                    .tolist()
                )
        else:
            model_name = "RandomForestRegressor"
            features = [
                "day_index",
                "day_of_week",
                "avg_sound_peak",
                "avg_current",
                "inspection_count"
            ]

            future = pd.DataFrame({
                "day_index": [(d - global_min).days for d in future_dates],
                "day_of_week": [d.dayofweek for d in future_dates],
                "avg_sound_peak": [room_daily["avg_sound_peak"].tail(3).mean()] * 7,
                "avg_current": [room_daily["avg_current"].tail(3).mean()] * 7,
                "inspection_count": [room_daily["inspection_count"].tail(3).mean()] * 7,
            })

            for target, out in [
                ("occupied_count", "predicted_occupied_count"),
                ("warning_count", "predicted_warning_count"),
                ("violation_count", "predicted_violation_count")
            ]:
                model = RandomForestRegressor(
                    n_estimators=200,
                    random_state=42
                )

                model.fit(
                    room_daily[features].fillna(0),
                    room_daily[target].fillna(0)
                )

                predictions[out] = np.clip(
                    model.predict(future[features].fillna(0)),
                    0,
                    None
                ).tolist()

        for i, d in enumerate(future_dates):
            docs.append({
                "room_id": str(room_id),
                "date": d.strftime("%Y-%m-%d"),
                "predicted_occupied_count": round(float(predictions["predicted_occupied_count"][i]), 4),
                "predicted_warning_count": round(float(predictions["predicted_warning_count"][i]), 4),
                "predicted_violation_count": round(float(predictions["predicted_violation_count"][i]), 4),
                "model_name": model_name,
                "generated_at": utc_now()
            })

    safe_insert_many(db.warden_forecasts, docs)
    print("warden_forecasts:", len(docs))


def build_reason(row):
    reasons = []

    if safe_float(row.get("violation_count")) > 0:
        reasons.append("very loud noise")
    elif safe_float(row.get("warning_count")) > 0 or safe_float(row.get("complaint_count")) > 0:
        reasons.append("noise warning")

    if safe_float(row.get("door_open_count")) > 0:
        reasons.append("door left open")

    if safe_float(row.get("inspection_count")) > 0:
        reasons.append("inspection needed")

    if safe_float(row.get("avg_current")) > 1:
        reasons.append("high power use")

    if reasons:
        return "Please check this room: " + ", ".join(reasons)

    return "Please check this room. Something unusual was detected."


def train_anomalies_and_alerts(df):
    cleanup_old_indexes()

    db.warden_anomalies.delete_many({})
    db.warden_ml_alerts.delete_many({})
    db.warden_feature_importance.delete_many({})

    features = [
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
        "day_of_week"
    ]

    if len(df) < 8:
        print("warden_anomalies: 0 warden_ml_alerts: 0")
        return

    work = df.copy()

    X = work[features].fillna(0)

    scaled = StandardScaler().fit_transform(X)

    model = IsolationForest(
        contamination="auto",
        random_state=42
    )

    flags = model.fit_predict(scaled)
    raw_scores = -model.decision_function(scaled)

    norm = (
        (raw_scores - raw_scores.min()) /
        (raw_scores.max() - raw_scores.min() + 1e-9)
    )

    work["anomaly_flag"] = flags
    work["anomaly_score"] = norm

    anomaly_rows = work[work["anomaly_flag"] == -1].copy()

    evidence_rows = work[
        (work["violation_count"].fillna(0) > 0) |
        (work["warning_count"].fillna(0) > 0) |
        (work["complaint_count"].fillna(0) > 0) |
        (work["inspection_count"].fillna(0) > 0) |
        (work["door_open_count"].fillna(0) > 0)
    ].copy()

    if not evidence_rows.empty:
        evidence_rows = (
            evidence_rows
            .sort_values(["room_id", "anomaly_score"], ascending=[True, False])
            .groupby("room_id", as_index=False)
            .head(1)
        )

    selected = pd.concat([anomaly_rows, evidence_rows], ignore_index=True)
    selected["datetime_key"] = pd.to_datetime(
        selected["datetime"],
        errors="coerce"
    ).dt.strftime("%Y-%m-%d %H:%M:%S")

    selected = selected.dropna(subset=["room_id", "datetime_key"])
    selected = selected.drop_duplicates(subset=["room_id", "datetime_key"])

    anomaly_docs = []
    alert_docs = []

    for _, row in selected.iterrows():
        score = safe_float(row["anomaly_score"])
        captured = row["datetime_key"]
        reason = build_reason(row)

        anomaly_docs.append({
            "room_id": str(row["room_id"]),
            "date": captured,
            "status": "Abnormal",
            "reason": reason,
            "avg_sound_peak": round(safe_float(row["avg_sound_peak"]), 2),
            "avg_current": round(safe_float(row["avg_current"]), 4),
            "warning_count": int(safe_float(row["warning_count"])),
            "violation_count": int(safe_float(row["violation_count"])),
            "inspection_count": int(safe_float(row["inspection_count"])),
            "anomaly_score": round(score, 4),
            "model_name": "IsolationForest"
        })

        alert_docs.append({
            "room_id": str(row["room_id"]),
            "captured_at": captured,
            "evidence_at": captured,
            "display_at": utc_now(),
            "generated_at": utc_now(),
            "alert_type": "ML Anomaly Alert",
            "severity": "Critical",
            "confidence": round(float(score), 4),
            "model_name": "IsolationForest",
            "reason": reason,
            "source_anomaly_score": round(score, 4)
        })

    safe_insert_many(db.warden_anomalies, anomaly_docs)
    safe_insert_many(db.warden_ml_alerts, alert_docs)

    try:
        y = (work["anomaly_flag"] == -1).astype(int)

        if y.nunique() > 1:
            rf = RandomForestRegressor(
                n_estimators=200,
                random_state=42
            )

            rf.fit(X, y)

            feature_docs = [
                {
                    "feature": f,
                    "importance": round(float(v), 6),
                    "model_name": "RandomForestRegressor"
                }
                for f, v in zip(features, rf.feature_importances_)
            ]

            safe_insert_many(db.warden_feature_importance, feature_docs)

    except Exception as e:
        print("feature importance skipped", e)

    print("warden_anomalies:", len(anomaly_docs), "warden_ml_alerts:", len(alert_docs))


def train_weekly_patterns(df):
    cleanup_old_indexes()

    db.warden_patterns.delete_many({})

    features = [
        "occupied_count",
        "avg_sound_peak",
        "warning_count",
        "violation_count",
        "inspection_count",
        "avg_current"
    ]

    if len(df) < 8:
        print("warden_patterns: 0")
        return

    work = df.copy()

    n_clusters = min(4, max(2, len(work) // 5))

    scaled = StandardScaler().fit_transform(work[features].fillna(0))

    work["cluster_id"] = KMeans(
        n_clusters=n_clusters,
        random_state=42,
        n_init=10
    ).fit_predict(scaled)

    profiles = (
        work.groupby("cluster_id")[
            ["avg_sound_peak", "warning_count", "violation_count", "inspection_count"]
        ]
        .mean()
        .reset_index()
    )

    profiles["risk_score"] = profiles[
        ["avg_sound_peak", "warning_count", "violation_count", "inspection_count"]
    ].rank(pct=True).sum(axis=1)

    ordered = profiles.sort_values("risk_score")["cluster_id"].tolist()

    labels = [
        "Normal Pattern",
        "Moderate Noise",
        "Inspection Needed",
        "High Noise Pattern"
    ]

    cluster_label = {
        int(cid): labels[min(i, len(labels) - 1)]
        for i, cid in enumerate(ordered)
    }

    docs = []

    def make_doc(room_id, day, day_df):
        if day_df.empty:
            return {
                "room_id": str(room_id),
                "day": day,
                "date": day,
                "day_type": "Weekend" if day in ["Saturday", "Sunday"] else "Weekday",
                "usual_pattern": "No Data",
                "avg_occupancy": 0,
                "avg_noise_level": 0,
                "avg_warnings": 0,
                "avg_critical_ratio": 0,
                "cluster_id": -1,
                "record_count": 0,
                "model_name": "KMeans"
            }

        cid = int(day_df["cluster_id"].mode().iloc[0])

        return {
            "room_id": str(room_id),
            "day": day,
            "date": day,
            "day_type": "Weekend" if day in ["Saturday", "Sunday"] else "Weekday",
            "usual_pattern": cluster_label.get(cid, "Pattern Detected"),
            "avg_occupancy": round(float(day_df["occupied_count"].mean()), 2),
            "avg_noise_level": round(float(day_df["avg_sound_peak"].mean()), 2),
            "avg_warnings": round(float(day_df["warning_count"].mean()), 2),
            "avg_critical_ratio": round(
                float((day_df["violation_count"].fillna(0) > 0).mean() * 100),
                2
            ),
            "cluster_id": cid,
            "record_count": int(len(day_df)),
            "model_name": "KMeans"
        }

    for room_id in sorted(work["room_id"].astype(str).unique()):
        room_df = work[work["room_id"].astype(str) == room_id]

        for day in ORDERED_DAYS:
            docs.append(
                make_doc(
                    room_id,
                    day,
                    room_df[room_df["day_name"] == day]
                )
            )

    for day in ORDERED_DAYS:
        docs.append(
            make_doc(
                "All",
                day,
                work[work["day_name"] == day]
            )
        )

    safe_insert_many(db.warden_patterns, docs)

    print("warden_patterns:", len(docs))


def main():
    df = load_source_dataframe()

    if df.empty:
        print("No data found in daily_room_summary, warden_hourly_summary, or sensorreadings")
        return

    df = add_time_features(df).sort_values(["room_id", "datetime"])

    print(
        "Rows:",
        len(df),
        "Rooms:",
        df["room_id"].nunique(),
        "Sources:",
        sorted(df["source_type"].astype(str).unique())
    )

    train_forecasts(df)
    train_anomalies_and_alerts(df)
    train_weekly_patterns(df)

    for name in [
        "sensorreadings",
        "daily_room_summary",
        "warden_hourly_summary",
        "warden_forecasts",
        "warden_anomalies",
        "warden_patterns",
        "warden_ml_alerts"
    ]:
        print(name + ":", db[name].count_documents({}))

    print("Warden ML analysis complete.")


if __name__ == "__main__":
    main()