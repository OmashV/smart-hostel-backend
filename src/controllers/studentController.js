const studentAnalyticsService = require("../services/studentAnalyticsService");
const { HttpError } = require("../utils/dateRange");

function sendError(res, error) {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details || null
      }
    });
  }

  return res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to process student analytics request."
    }
  });
}

async function handleStudentRequest(req, res, action) {
  try {
    const payload = await action();
    return res.json(payload);
  } catch (error) {
    return sendError(res, error);
  }
}

async function getStudentOverview(req, res) {
  return handleStudentRequest(req, res, () =>
    studentAnalyticsService.getStudentOverview(req.params.roomId, req.query)
  );
}

async function getStudentEnergyHistory(req, res) {
  return handleStudentRequest(req, res, () =>
    studentAnalyticsService.getStudentEnergyHistory(req.params.roomId, req.query)
  );
}

async function getStudentNoiseHistory(req, res) {
  return handleStudentRequest(req, res, () =>
    studentAnalyticsService.getStudentNoiseHistory(req.params.roomId, req.query)
  );
}

async function getStudentAlerts(req, res) {
  return handleStudentRequest(req, res, () =>
    studentAnalyticsService.getStudentAlerts(req.params.roomId, req.query)
  );
}

async function getStudentAlertsSummary(req, res) {
  return handleStudentRequest(req, res, () =>
    studentAnalyticsService.getStudentAlertsSummary(req.params.roomId, req.query)
  );
}

async function getStudentEnergyComparison(req, res) {
  return handleStudentRequest(req, res, () =>
    studentAnalyticsService.getStudentEnergyComparison(req.params.roomId, req.query)
  );
}

async function getStudentEnergyForecast(req, res) {
  return handleStudentRequest(req, res, () =>
    studentAnalyticsService.getStudentEnergyForecastPreview(req.params.roomId, req.query)
  );
}

async function getStudentRecommendations(req, res) {
  return handleStudentRequest(req, res, () =>
    studentAnalyticsService.getStudentRecommendations(req.params.roomId, req.query)
  );
}

module.exports = {
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentNoiseHistory,
  getStudentAlerts,
  getStudentAlertsSummary,
  getStudentEnergyComparison,
  getStudentEnergyForecast,
  getStudentRecommendations
};

