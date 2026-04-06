function round2(value) {
  return Math.round(value * 100) / 100;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function weightedAverage(values) {
  if (!values.length) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 0; i < values.length; i++) {
    const weight = i + 1;
    weightedSum += values[i] * weight;
    totalWeight += weight;
  }

  return weightedSum / totalWeight;
}

function averageTrend(values) {
  if (values.length < 2) return 0;

  const diffs = [];
  for (let i = 1; i < values.length; i++) {
    diffs.push(values[i] - values[i - 1]);
  }

  return diffs.reduce((a, b) => a + b, 0) / diffs.length;
}

function buildForecast(history, forecastDays = 5) {
  if (!history.length) return [];

  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));

  const totalSeries = sorted.map((d) => d.total_energy_kwh);
  const wasteSeries = sorted.map((d) => d.wasted_energy_kwh);

  const totalBase = weightedAverage(totalSeries.slice(-7));
  const wasteBase = weightedAverage(wasteSeries.slice(-7));

  const totalTrend = averageTrend(totalSeries.slice(-7));
  const wasteTrend = averageTrend(wasteSeries.slice(-7));

  const lastDate = new Date(sorted[sorted.length - 1].date);
  const predictions = [];

  for (let i = 1; i <= forecastDays; i++) {
    const nextDate = new Date(lastDate);
    nextDate.setDate(lastDate.getDate() + i);

    const predictedTotal = Math.max(0, totalBase + totalTrend * i);
    const predictedWaste = Math.max(0, wasteBase + wasteTrend * i);

    predictions.push({
      date: formatDate(nextDate),
      predicted_total_energy_kwh: round2(predictedTotal),
      predicted_wasted_energy_kwh: round2(predictedWaste)
    });
  }

  return predictions;
}

module.exports = {
  buildForecast
};