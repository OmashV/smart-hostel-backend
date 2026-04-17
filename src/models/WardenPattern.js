const mongoose = require("mongoose");

const WardenPatternSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    pattern_name: { type: String, required: true }
  },
  { timestamps: true }
);

WardenPatternSchema.index({ room_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model(
  "WardenPattern",
  WardenPatternSchema,
  "warden_patterns"
);
