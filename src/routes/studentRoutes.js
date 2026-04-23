const express = require("express");
const {
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentNoiseHistory,
  getStudentAlerts,
  getStudentAlertsSummary,
  getStudentEnergyComparison,
  getStudentEnergyForecast,
  getStudentRecommendations
} = require("../controllers/studentController");

const router = express.Router();

router.get("/:roomId/overview", getStudentOverview);
router.get("/:roomId/energy/history", getStudentEnergyHistory);
router.get("/:roomId/noise/history", getStudentNoiseHistory);
router.get("/:roomId/alerts", getStudentAlerts);
router.get("/:roomId/alerts/summary", getStudentAlertsSummary);
router.get("/:roomId/energy/comparison", getStudentEnergyComparison);
router.get("/:roomId/energy/forecast", getStudentEnergyForecast);
router.get("/:roomId/recommendations", getStudentRecommendations);

module.exports = router;

