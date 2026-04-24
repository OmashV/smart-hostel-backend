const studentAnalyticsService = require("./studentAnalyticsService");

function getRoomId(args = {}) {
  return args.roomId || args.room_id || args.dashboardState?.roomId || "A101";
}

function getRange(args = {}, fallback = "7d") {
  return (
    args.range ||
    args.dashboardState?.selectedFilters?.range ||
    args.dashboardState?.filters?.range ||
    fallback
  );
}

async function getStudentOverview({ roomId, range, dashboardState } = {}) {
  return studentAnalyticsService.getStudentOverview(getRoomId({ roomId, dashboardState }), {
    range: getRange({ range, dashboardState }, "24h")
  });
}

async function getStudentEnergyHistory({ roomId, range, groupBy = "day", dashboardState } = {}) {
  return studentAnalyticsService.getStudentEnergyHistory(getRoomId({ roomId, dashboardState }), {
    range: getRange({ range, dashboardState }, "7d"),
    groupBy
  });
}

async function getStudentNoiseHistory({ roomId, range, groupBy = "day", dashboardState } = {}) {
  return studentAnalyticsService.getStudentNoiseHistory(getRoomId({ roomId, dashboardState }), {
    range: getRange({ range, dashboardState }, "7d"),
    groupBy
  });
}

async function getStudentAlerts({
  roomId,
  range,
  severity,
  type,
  limit = 20,
  dashboardState
} = {}) {
  return studentAnalyticsService.getStudentAlerts(getRoomId({ roomId, dashboardState }), {
    range: getRange({ range, dashboardState }, "7d"),
    severity,
    type,
    limit
  });
}

async function getStudentAlertsSummary({ roomId, range, dashboardState } = {}) {
  return studentAnalyticsService.getStudentAlertsSummary(getRoomId({ roomId, dashboardState }), {
    range: getRange({ range, dashboardState }, "7d")
  });
}

async function getStudentEnergyComparison({ roomId, range, dashboardState } = {}) {
  return studentAnalyticsService.getStudentEnergyComparison(getRoomId({ roomId, dashboardState }), {
    range: getRange({ range, dashboardState }, "30d")
  });
}

async function getStudentEnergyForecast({ roomId, range, groupBy = "day", limit = 5, dashboardState } = {}) {
  return studentAnalyticsService.getStudentEnergyForecastPreview(
    getRoomId({ roomId, dashboardState }),
    {
      range: getRange({ range, dashboardState }, "30d"),
      groupBy,
      limit
    }
  );
}

async function getStudentRecommendations({ roomId, range, dashboardState } = {}) {
  return studentAnalyticsService.getStudentRecommendations(getRoomId({ roomId, dashboardState }), {
    range: getRange({ range, dashboardState }, "7d")
  });
}

async function getStudentVisualExplanationContext({ visualId, visualTitle, dashboardState } = {}) {
  const roomId = getRoomId({ dashboardState });
  const range = getRange({ dashboardState }, "7d");
  const selectedVisual = dashboardState?.selectedVisual || null;

  return {
    dashboard: "student",
    roomId,
    range,
    visualId: visualId || selectedVisual?.id || null,
    visualTitle: visualTitle || selectedVisual?.title || selectedVisual?.name || null,
    selectedVisual,
    selectedFilters: dashboardState?.selectedFilters || dashboardState?.filters || {}
  };
}

module.exports = {
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentNoiseHistory,
  getStudentAlerts,
  getStudentAlertsSummary,
  getStudentEnergyComparison,
  getStudentEnergyForecast,
  getStudentRecommendations,
  getStudentVisualExplanationContext
};