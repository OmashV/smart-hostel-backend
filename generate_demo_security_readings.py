# generate_demo_security_readings.py
import os
import random
from datetime import datetime, timedelta
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()

client = MongoClient(os.getenv("MONGO_URI"))
db = client["smart_hostel"]
collection = db["demo_security_readings"]   # separate collection

# A101 is excluded — it uses real sensorreadings
ROOMS = ["A102", "A103", "B101", "B102", "B103", "C101", "C102"]
DAYS_BACK = 30
READINGS_PER_HOUR = 4

ROOM_PROFILES = {
    "A102": { "activity": "low",    "after_hours_risk": 0.02 },
    "A103": { "activity": "medium", "after_hours_risk": 0.10 },
    "B101": { "activity": "high",   "after_hours_risk": 0.03 },
    "B102": { "activity": "medium", "after_hours_risk": 0.20 },
    "B103": { "activity": "low",    "after_hours_risk": 0.02 },
    "C101": { "activity": "high",   "after_hours_risk": 0.04 },
    "C102": { "activity": "medium", "after_hours_risk": 0.08 },
}

ACTIVITY_DOOR_DURATION = {
    "high":   { "mean": 300000,  "std": 120000 },
    "medium": { "mean": 180000,  "std": 80000  },
    "low":    { "mean": 90000,   "std": 40000  },
}

def get_occupancy(hour, activity):
    if 0 <= hour <= 5:
        return random.choices(["Empty", "Sleeping", "Occupied"], weights=[0.6, 0.35, 0.05])[0]
    elif 6 <= hour <= 8:
        return random.choices(["Empty", "Occupied"], weights=[0.3, 0.7])[0]
    elif 9 <= hour <= 17:
        w = {"high": [0.8, 0.2], "medium": [0.6, 0.4], "low": [0.4, 0.6]}[activity]
        return random.choices(["Occupied", "Empty"], weights=w)[0]
    elif 18 <= hour <= 22:
        return random.choices(["Occupied", "Empty"], weights=[0.7, 0.3])[0]
    else:
        return random.choices(["Empty", "Sleeping"], weights=[0.5, 0.5])[0]

def get_door_stable_ms(hour, profile, occupancy):
    activity   = profile["activity"]
    durations  = ACTIVITY_DOOR_DURATION[activity]
    is_after_hours = hour >= 23 or hour <= 5

    if is_after_hours and random.random() < profile["after_hours_risk"]:
        return random.randint(1800000, 5400000)

    if occupancy == "Empty" and random.random() < 0.1:
        return random.randint(600000, 3600000)

    return max(10000, int(random.gauss(durations["mean"], durations["std"])))

def get_door_status(hour, occupancy, profile):
    is_after_hours = hour >= 23 or hour <= 5
    if is_after_hours:
        return "Open" if random.random() < profile["after_hours_risk"] * 2 else "Closed"
    if occupancy == "Occupied":
        return "Open" if random.random() < 0.4 else "Closed"
    elif occupancy == "Sleeping":
        return "Open" if random.random() < 0.05 else "Closed"
    else:
        return "Open" if random.random() < 0.15 else "Closed"

def get_motion_count(hour, occupancy, door_status):
    is_after_hours = hour >= 23 or hour <= 5
    if occupancy == "Occupied":    return random.randint(2, 15)
    elif occupancy == "Sleeping":  return random.randint(0, 2)
    elif door_status == "Open" and is_after_hours: return random.randint(0, 3)
    else: return random.randint(0, 1)

def get_current_amp(occupancy, hour):
    if occupancy == "Occupied":   base = random.uniform(0.5, 2.0)
    elif occupancy == "Sleeping": base = random.uniform(0.2, 0.6)
    else:                         base = random.uniform(0.05, 0.3)
    if 8 <= hour <= 22:           base *= random.uniform(1.0, 1.5)
    return round(base, 2)

def generate():
    docs = []
    now  = datetime.utcnow()

    for room_id in ROOMS:
        profile = ROOM_PROFILES[room_id]
        print(f"  Generating {room_id}...")

        for day_offset in range(DAYS_BACK, -1, -1):
            day = now - timedelta(days=day_offset)

            for hour in range(24):
                for n in range(READINGS_PER_HOUR):
                    minute = (n * 15) + random.randint(0, 5)
                    second = random.randint(0, 59)

                    captured_at_utc = day.replace(
                        hour=hour,
                        minute=min(minute, 59),
                        second=second,
                        microsecond=0
                    ) - timedelta(hours=5.5)

                    occupancy      = get_occupancy(hour, profile["activity"])
                    door_status    = get_door_status(hour, occupancy, profile)
                    door_stable_ms = get_door_stable_ms(hour, profile, occupancy) if door_status == "Open" else random.randint(0, 5000)
                    motion_count   = get_motion_count(hour, occupancy, door_status)
                    current_amp    = get_current_amp(occupancy, hour)

                    interval_energy_kwh        = round(current_amp * 0.22 * (15/60) / 1000, 8)
                    interval_wasted_energy_kwh = round(interval_energy_kwh * (0.8 if occupancy == "Empty" else 0.1), 8)
                    waste_ratio = (interval_wasted_energy_kwh / interval_energy_kwh * 100) if interval_energy_kwh > 0 else 0
                    waste_stat  = "Critical" if waste_ratio >= 30 else "Warning" if waste_ratio >= 15 else "Normal"

                    docs.append({
                        "room_id":     room_id,
                        "device_id":   f"esp32_{room_id}",
                        "captured_at": captured_at_utc,
                        "captured_at_epoch": int(captured_at_utc.timestamp()),
                        "time_valid":  True,
                        "hour":        hour,
                        "minute":      min(minute, 59),
                        "second":      second,
                        "door_status":    door_status,
                        "door_stable_ms": door_stable_ms,
                        "motion_count":   motion_count,
                        "last_motion_ms_ago": random.randint(0, 300000),
                        "current_amp":  current_amp,
                        "sound_peak":   random.randint(40, 120),
                        "wifi_rssi":    random.randint(-80, -40),
                        "occupancy_stat": occupancy,
                        "noise_stat":   random.choices(["Compliant", "Warning", "Violation"], weights=[0.85, 0.12, 0.03])[0],
                        "waste_stat":   waste_stat,
                        "sensor_health":  { "pir": True, "door": True, "sound": True, "current": True },
                        "sensor_faults":  { "pir": False, "door": False, "sound": False, "current": False },
                        "interval_energy_kwh":        interval_energy_kwh,
                        "interval_wasted_energy_kwh": interval_wasted_energy_kwh,
                        "buffered": False,
                        "buffer_queue_size": 0,
                        "dropped_messages":  0,
                        "source": "demo"
                    })

    return docs

docs = generate()
print(f"\nInserting {len(docs)} documents...")
for i in range(0, len(docs), 1000):
    collection.insert_many(docs[i:i+1000], ordered=False)
    print(f"  {min(i+1000, len(docs))} / {len(docs)}")

print("\nDone.")
print("demo_security_readings count:", collection.count_documents({}))