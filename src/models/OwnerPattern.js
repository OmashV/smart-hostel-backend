const mongoose = require("mongoose");

const OwnerPatternSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    cluster_label: { type: Number, required: true },
    pattern_name: { type: String, default: "Unknown" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("OwnerPattern", OwnerPatternSchema, "owner_patterns");