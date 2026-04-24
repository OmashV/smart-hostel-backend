const mongoose = require("mongoose");
require("dotenv").config();

const DailyRoomSummary = require("../src/models/DailyRoomSummary");
const { getFloorIdFromRoomId } = require("../src/utils/floor");

async function run() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected.");

    const rows = await DailyRoomSummary.find({}).lean();
    console.log(`Rows found: ${rows.length}`);

    let updatedCount = 0;

    for (const row of rows) {
      const floorId = getFloorIdFromRoomId(row.room_id);

      await DailyRoomSummary.updateOne(
        { _id: row._id },
        { $set: { floor_id: floorId } }
      );

      updatedCount++;
    }

    console.log(`Updated rows with floor_id: ${updatedCount}`);

    await mongoose.disconnect();
    console.log("Backfill complete.");
  } catch (error) {
    console.error("Backfill failed:", error);
    process.exit(1);
  }
}

run();
