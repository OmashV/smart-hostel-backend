const mongoose = require("mongoose");
require("dotenv").config();

const DailyRoomSummary = require("../src/models/DailyRoomSummary");
const { getFloorIdFromRoomId } = require("../src/utils/floor");

const START_DATE = "2026-04-13";
const END_DATE = "2026-04-25";

const ROOM_PROFILES = {
  A102: {
    energyMultiplier: 0.82,
    wasteMultiplier: 0.45,
    currentMultiplier: 0.85,
    motionMultiplier: 0.95,
    soundMultiplier: 0.95,
    doorMultiplier: 0.90
  },
  A103: {
    energyMultiplier: 0.96,
    wasteMultiplier: 0.72,
    currentMultiplier: 0.95,
    motionMultiplier: 1.02,
    soundMultiplier: 1.00,
    doorMultiplier: 1.00
  },
  A201: {
    energyMultiplier: 1.18,
    wasteMultiplier: 0.88,
    currentMultiplier: 1.12,
    motionMultiplier: 1.08,
    soundMultiplier: 1.03,
    doorMultiplier: 1.05
  },
  A202: {
    energyMultiplier: 1.30,
    wasteMultiplier: 1.22,
    currentMultiplier: 1.20,
    motionMultiplier: 0.88,
    soundMultiplier: 0.95,
    doorMultiplier: 1.08
  },
  A203: {
    energyMultiplier: 0.92,
    wasteMultiplier: 0.40,
    currentMultiplier: 0.90,
    motionMultiplier: 1.18,
    soundMultiplier: 1.08,
    doorMultiplier: 1.00
  }
};

function round(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function addSmallVariation(base, seedFactor) {
  return base * seedFactor;
}

function buildStatusCounts(wasteRatio) {
  if (wasteRatio >= 30) return { critical_count: 1, warning_count: 0 };
  if (wasteRatio >= 15) return { critical_count: 0, warning_count: 1 };
  return { critical_count: 0, warning_count: 0 };
}

async function run() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected.");

    const baseRows = await DailyRoomSummary.find({
      room_id: "A101",
      date: { $gte: START_DATE, $lte: END_DATE }
    })
      .sort({ date: 1 })
      .lean();

    if (!baseRows.length) {
      console.log("No A101 daily summary rows found in requested date range.");
      process.exit(1);
    }

    console.log(`Using ${baseRows.length} A101 rows as real baseline.`);

    for (const [roomId, profile] of Object.entries(ROOM_PROFILES)) {
      const floorId = getFloorIdFromRoomId(roomId);

      for (let i = 0; i < baseRows.length; i++) {
        const row = baseRows[i];
        const dayFactor = 0.96 + (i % 5) * 0.025;

        const totalEnergy = addSmallVariation(
          row.total_energy_kwh * profile.energyMultiplier,
          dayFactor
        );

        const wastedEnergy = addSmallVariation(
          row.wasted_energy_kwh * profile.wasteMultiplier,
          1.02 - (i % 3) * 0.03
        );

        const wasteRatio = totalEnergy > 0 ? (wastedEnergy / totalEnergy) * 100 : 0;

        const avgCurrent = addSmallVariation(
          (row.avg_current || 0) * profile.currentMultiplier,
          0.98 + (i % 4) * 0.02
        );

        const motionCount = Math.max(
          0,
          Math.round((row.total_motion_count || 0) * profile.motionMultiplier)
        );

        const avgSoundPeak = addSmallVariation(
          (row.avg_sound_peak || 0) * profile.soundMultiplier,
          0.98 + (i % 3) * 0.01
        );

        const doorOpenCount = Math.max(
          0,
          Math.round((row.door_open_count || 0) * profile.doorMultiplier)
        );

        const statusCounts = buildStatusCounts(wasteRatio);

        const doc = {
          room_id: roomId,
          floor_id: floorId,
          date: row.date,

          total_energy_kwh: round(totalEnergy),
          wasted_energy_kwh: round(wastedEnergy),
          waste_ratio_percent: round(wasteRatio, 2),

          avg_current: round(avgCurrent),
          total_motion_count: motionCount,
          avg_sound_peak: round(avgSoundPeak, 2),
          door_open_count: doorOpenCount,

          critical_count: statusCounts.critical_count,
          warning_count: statusCounts.warning_count
        };

        await DailyRoomSummary.updateOne(
          { room_id: doc.room_id, date: doc.date },
          { $set: doc },
          { upsert: true }
        );
      }

      console.log(`Synthetic daily summary generated for ${roomId}`);
    }

    console.log(
      "Final daily_room_summary count:",
      await DailyRoomSummary.countDocuments()
    );

    await mongoose.disconnect();
    console.log("Synthetic daily room generation complete.");
  } catch (error) {
    console.error("Error generating synthetic daily room data:", error);
    process.exit(1);
  }
}

run();
