const groq = require("./groqClient");
const {
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentNoiseHistory,
  getStudentAlerts,
  getStudentAlertsSummary,
  getStudentEnergyComparison,
  getStudentEnergyForecast,
  getStudentRecommendations,
  getStudentVisualExplanationContext
} = require("./studentChatTools");

const TOOL_IMPL = {
  get_student_overview: getStudentOverview,
  get_student_energy_history: getStudentEnergyHistory,
  get_student_noise_history: getStudentNoiseHistory,
  get_student_alerts: getStudentAlerts,
  get_student_alerts_summary: getStudentAlertsSummary,
  get_student_energy_comparison: getStudentEnergyComparison,
  get_student_energy_forecast: getStudentEnergyForecast,
  get_student_recommendations: getStudentRecommendations,
  get_student_visual_explanation_context: getStudentVisualExplanationContext
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_student_overview",
      description: "Get latest student room overview, KPIs, status, recent alerts, and recommendations.",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string", description: "Room id like A101" },
          range: { type: "string", description: "Range like 24h, 7d, 30d" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_student_energy_history",
      description: "Get energy and wasted energy trend history for the student's room.",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string" },
          range: { type: "string" },
          groupBy: { type: "string", description: "hour, day, or week" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_student_noise_history",
      description: "Get noise trend, warnings, violations, and quiet-hour issues for the student's room.",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string" },
          range: { type: "string" },
          groupBy: { type: "string", description: "hour, day, or week" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_student_alerts",
      description: "Get active derived alerts for energy, noise, security, and occupancy.",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string" },
          range: { type: "string" },
          severity: { type: "string", description: "Critical, Warning, Info" },
          type: { type: "string", description: "energy, noise, security, occupancy" },
          limit: { type: "number" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_student_alerts_summary",
      description: "Get alert counts grouped by severity and type.",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string" },
          range: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_student_energy_comparison",
      description: "Compare the student's room energy usage with peer rooms and hostel average.",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string" },
          range: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_student_energy_forecast",
      description: "Get a short forecast preview for room energy and wasted energy.",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string" },
          range: { type: "string" },
          groupBy: { type: "string" },
          limit: { type: "number" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_student_recommendations",
      description: "Get practical decision-oriented recommendations for the student.",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string" },
          range: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_student_visual_explanation_context",
      description: "Get selected student dashboard visual context for chart/card explanation.",
      parameters: {
        type: "object",
        properties: {
          visualId: { type: "string" },
          visualTitle: { type: "string" }
        }
      }
    }
  }
];

function systemPrompt() {
  return `
You are a friendly Smart Hostel dashboard assistant for the STUDENT role.

You are an LLM-powered visual analytics assistant, not only a normal chatbot.

You help students:
1. Answer natural language questions related to their room dataset
2. Guide users in exploring the student dashboard
3. Explain energy trends, wasted energy, noise patterns, alerts, and anomalies
4. Support decision questions like "What should I fix first?" or "What factors affect my room energy usage?"
5. Explain selected visuals using the current dashboard context

Rules:
- Use tools whenever real dashboard data is needed.
- Use actual tool data only. Never invent numbers.
- Focus on student room-level insight.
- Keep explanations simple, practical, and decision-oriented.
- If explaining a visual, explain what it shows, what stands out, why it matters, and what action the student can take.
- If data is missing or empty, say that clearly and suggest what the user can check next.
- Only include ACTION lines if the user explicitly asks to navigate, open, show, or switch pages.
`;
}

function cleanupParsedArgs(parsedArgs) {
  const cleaned = { ...parsedArgs };

  Object.keys(cleaned).forEach((key) => {
    if (cleaned[key] === "" || cleaned[key] === null) {
      delete cleaned[key];
    }
  });

  return cleaned;
}

function userExplicitlyWantsNavigation(message = "") {
  const text = String(message).toLowerCase();

  return (
    text.includes("open ") ||
    text.includes("go to ") ||
    text.includes("switch to ") ||
    text.includes("take me to ") ||
    text.includes("show me ")
  );
}

async function generateStudentReply({ message, dashboardState }) {
  const roomId = dashboardState?.roomId || dashboardState?.room_id || "A101";
  const range =
    dashboardState?.selectedFilters?.range ||
    dashboardState?.filters?.range ||
    dashboardState?.range ||
    "7d";

  const selectedVisual = dashboardState?.selectedVisual || null;

  const messages = [
    {
      role: "system",
      content: systemPrompt()
    },
    {
      role: "user",
      content: `Current dashboard state:
dashboard=student
roomId=${roomId}
range=${range}
selectedVisual=${JSON.stringify(selectedVisual)}

User question:
${message}`
    }
  ];

  const firstResponse = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    temperature: 0.1,
    messages,
    tools: TOOLS,
    tool_choice: "auto"
  });

  const assistantMessage = firstResponse.choices?.[0]?.message;

  if (!assistantMessage) {
    return {
      reply: "Sorry, I couldn’t generate a response just now.",
      context_used: {}
    };
  }

  if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
    return {
      reply: assistantMessage.content || "Sorry, I couldn’t generate a response just now.",
      context_used: {}
    };
  }

  messages.push(assistantMessage);

  const toolResults = {};

  for (const toolCall of assistantMessage.tool_calls) {
    const toolName = toolCall.function.name;
    const rawArgs = toolCall.function.arguments || "{}";

    let parsedArgs = {};

    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      parsedArgs = {};
    }

    parsedArgs = cleanupParsedArgs(parsedArgs);

    if (!parsedArgs.roomId) {
      parsedArgs.roomId = roomId;
    }

    if (!parsedArgs.range) {
      parsedArgs.range = range;
    }

    if (!parsedArgs.dashboardState) {
      parsedArgs.dashboardState = dashboardState;
    }

    if (
      toolName === "get_student_visual_explanation_context" &&
      selectedVisual
    ) {
      if (!parsedArgs.visualId && selectedVisual.id) {
        parsedArgs.visualId = selectedVisual.id;
      }

      if (!parsedArgs.visualTitle && (selectedVisual.title || selectedVisual.name)) {
        parsedArgs.visualTitle = selectedVisual.title || selectedVisual.name;
      }
    }

    const impl = TOOL_IMPL[toolName];
    if (!impl) continue;

    const result = await impl(parsedArgs);
    toolResults[toolName] = result;

    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(result)
    });
  }

  const navigationAllowed = userExplicitlyWantsNavigation(message);

  messages.push({
    role: "system",
    content: navigationAllowed
      ? "The user explicitly wants navigation if relevant. You may include ACTION lines if they genuinely help."
      : "The user did not explicitly ask for navigation. Do not include any ACTION lines. Just answer the question."
  });

  const finalResponse = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    temperature: 0.25,
    messages
  });

  return {
    reply:
      finalResponse.choices?.[0]?.message?.content ||
      "Sorry, I couldn’t generate a response just now.",
    context_used: toolResults
  };
}

module.exports = {
  generateStudentReply
};