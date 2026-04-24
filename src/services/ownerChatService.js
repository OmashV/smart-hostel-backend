const groq = require("./groqClient");
const {
  getFloorOverview,
  getRoomsOverview,
  getTopWasteRoomsToday,
  getHighestWastedRoom,
  getRoomDetail,
  getWastePatternByWeekday,
  getActiveAlerts,
  getOverviewSnapshot,
  getPrioritySummary,
  getVisualExplanationContext
} = require("./ownerChatTools");

const TOOL_IMPL = {
  get_floor_overview: getFloorOverview,
  get_rooms_overview: getRoomsOverview,
  get_top_waste_rooms_today: getTopWasteRoomsToday,
  get_highest_wasted_room: getHighestWastedRoom,
  get_room_detail: getRoomDetail,
  get_waste_pattern_by_weekday: getWastePatternByWeekday,
  get_active_alerts: getActiveAlerts,
  get_overview_snapshot: getOverviewSnapshot,
  get_priority_summary: getPrioritySummary,
  get_visual_explanation_context: getVisualExplanationContext
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_floor_overview",
      description:
        "Get the latest floor-wise energy and waste comparison for the owner dashboard.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Optional date in YYYY-MM-DD format"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_rooms_overview",
      description:
        "Get the latest room-wise energy overview for all rooms or for one selected floor.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          },
          date: {
            type: "string",
            description: "Optional date in YYYY-MM-DD format"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_top_waste_rooms_today",
      description:
        "Get the top highest wasted-energy rooms for the latest available summary date, optionally filtered by floor.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          },
          limit: {
            type: "number",
            description: "How many rooms to return"
          },
          date: {
            type: "string",
            description: "Optional date in YYYY-MM-DD format"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_highest_wasted_room",
      description:
        "Get the single room with the highest wasted energy for the selected floor or all floors, using the latest available date for that scope.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          },
          date: {
            type: "string",
            description: "Optional date in YYYY-MM-DD format"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_room_detail",
      description:
        "Get detailed information for a room, including latest summary, recent alerts, anomalies, and forecast.",
      parameters: {
        type: "object",
        properties: {
          roomId: {
            type: "string",
            description: "Room id like A101 or A202"
          }
        },
        required: ["roomId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_waste_pattern_by_weekday",
      description:
        "Get weekday-based waste pattern analysis for a specific room, including which weekdays tend to be high waste, moderate waste, or efficient.",
      parameters: {
        type: "object",
        properties: {
          roomId: {
            type: "string",
            description: "Room id like A101 or A202"
          }
        },
        required: ["roomId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_active_alerts",
      description:
        "Get active alerts for all rooms, a selected floor, or one selected room.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          },
          roomId: {
            type: "string",
            description: 'Room id like "A101" or "all"'
          },
          limit: {
            type: "number",
            description: "Maximum number of alerts to return"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_overview_snapshot",
      description:
        "Get the latest overview snapshot for all rooms or one selected floor, used for chart explanation and overview questions.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_priority_summary",
      description:
        "Get backend-calculated room priorities for decision-oriented questions, such as what the owner should focus on first.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_visual_explanation_context",
      description:
        "Get the currently selected visual context for explanation. Use this when the user asks to explain the selected chart, KPI, calendar, card, or table.",
      parameters: {
        type: "object",
        properties: {
          visualId: {
            type: "string",
            description: "Optional visual id if known"
          },
          visualTitle: {
            type: "string",
            description: "Optional visual title if known"
          }
        }
      }
    }
  }
];

function systemPrompt() {
  return `
You are a friendly Smart Hostel dashboard assistant for the OWNER role.

You are a visual analytics assistant, not only a Q&A bot.

You must help with:
1. Answering natural language questions about dashboard data
2. Understanding the current dashboard context
3. Explaining the currently selected visual using the actual available data
4. Guiding the user on what to check next
5. Supporting decision-oriented questions using backend-generated analytics

Rules:
- Use tools whenever data is needed.
- Use the current dashboard context, including dashboard, selected floor, selected room, filters, and selected visual.
- When explaining the selected visual, call get_visual_explanation_context and rely on the current dashboard state.
- When explaining a selected visual, do not only say what the visual is.
- You must also explain:
  - what the available data shows
  - what stands out
  - any comparison or trend visible in the data
  - why it matters
- If the selected visual includes dataSummary or selectedItem, base the explanation on those values.
- For decision-oriented questions, rely on backend-generated priorities, alerts, anomalies, and risk indicators.
- Never invent values.
- Be friendly, clear, and slightly descriptive.
- Only include ACTION lines if the user explicitly wants navigation.
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

async function generateOwnerReply({ message, dashboardState }) {
  const floorId = dashboardState?.floorId || "all";
  const roomId = dashboardState?.roomId || "all";
  const selectedVisual = dashboardState?.selectedVisual || null;

  const messages = [
    {
      role: "system",
      content: systemPrompt()
    },
    {
      role: "user",
      content: `Current dashboard state:
floorId=${floorId}
roomId=${roomId}

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

    // Inject current dashboard context when the model omits it
    if (toolName === "get_rooms_overview" && !parsedArgs.floorId) {
      parsedArgs.floorId = floorId;
    }

    if (toolName === "get_top_waste_rooms_today" && !parsedArgs.floorId) {
      parsedArgs.floorId = floorId;
    }

    if (toolName === "get_highest_wasted_room" && !parsedArgs.floorId) {
      parsedArgs.floorId = floorId;
    }

    if (toolName === "get_room_detail" && !parsedArgs.roomId && roomId !== "all") {
      parsedArgs.roomId = roomId;
    }

    if (toolName === "get_waste_pattern_by_weekday" && !parsedArgs.roomId && roomId !== "all") {
      parsedArgs.roomId = roomId;
    }

    if (toolName === "get_active_alerts") {
      if (!parsedArgs.floorId) {
        parsedArgs.floorId = floorId;
      }
      if (!parsedArgs.roomId) {
        parsedArgs.roomId = roomId;
      }
    }

    if (toolName === "get_visual_explanation_context") {
      if (!parsedArgs.visualId && selectedVisual?.id) {
        parsedArgs.visualId = selectedVisual.id;
      }

      if (!parsedArgs.visualTitle && selectedVisual?.title) {
        parsedArgs.visualTitle = selectedVisual.title;
      }

      parsedArgs.dashboardState = dashboardState;
    }

    if (toolName === "get_priority_summary" && !parsedArgs.floorId) {
      parsedArgs.floorId = floorId;
    }

    if (toolName === "get_overview_snapshot" && !parsedArgs.floorId) {
      parsedArgs.floorId = floorId;
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
  generateOwnerReply
};
