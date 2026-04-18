const mongoose = require("mongoose");

const WardenFeatureImportanceSchema = new mongoose.Schema(
  {
    feature: { type: String, required: true },
    importance: { type: Number, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "WardenFeatureImportance",
  WardenFeatureImportanceSchema,
  "warden_feature_importance"
);
