const groq = require("./groqClient");
const {
  getFloorOverview,
  getRoomsOverview,
  getTopWasteRoomsToday,
  getHighestWastedRoom,
  getRoomDetail,
  getWastePatternByWeekday,
  getActiveAlerts
} = require("./ownerChatTools");

const TOOL_IMPL = {
  get_floor_overview: getFloorOverview,
  get_rooms_overview: getRoomsOverview,
  get_top_waste_rooms_today: getTopWasteRoomsToday,
  get_highest_wasted_room: getHighestWastedRoom,
  get_room_detail: getRoomDetail,
  get_waste_pattern_by_weekday: getWastePatternByWeekday,
  get_active_alerts: getActiveAlerts
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_floor_overview",
      description:
        "Get latest floor-wise energy and waste comparison for the owner dashboard.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Optional summary date in YYYY-MM-DD format"
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
        "Get latest room-wise overview for all rooms or for a selected floor.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          },
          date: {
            type: "string",
            description: "Optional summary date in YYYY-MM-DD format"
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
        "Find the highest wasted-energy rooms for the latest summary date, optionally filtered by floor.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          },
          limit: {
            type: "number",
            description: "Number of rooms to return"
          },
          date: {
            type: "string",
            description: "Optional summary date in YYYY-MM-DD format"
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
        "Get the single room with the highest wasted energy for the latest summary date, optionally within a selected floor.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          },
          date: {
            type: "string",
            description: "Optional summary date in YYYY-MM-DD format"
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
        "Get detailed history, alerts, anomalies, and forecast for one room.",
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
        "Get weekday-based waste pattern discovery for a specific room, including which weekdays usually have high waste, moderate waste, or efficient usage.",
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
        "Get active owner alerts, optionally filtered by floor or room, for dashboard monitoring and drill-down.",
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
  }
];

function systemPrompt() {
  return `
You are a Smart Hostel dashboard analytics assistant for the OWNER role.

You answer questions using dashboard tools, not guesses.

Rules:
- Always use tools when data is needed.
- Never invent values.
- Use the current dashboard state when helpful.
- For questions asking for analysis, comparison, trends, or explanation, answer directly without navigation actions.
- Only include ACTION lines if the user explicitly asks to open, switch, go to, or show a floor or room.
- Valid action lines are:
ACTION: switch_floor=A-Floor-1
ACTION: switch_room=A201
- Ignore null or missing IDs.
`;
}

async function generateOwnerReply({ message, dashboardState }) {
  const floorId = dashboardState?.floorId || "all";
  const roomId = dashboardState?.roomId || "all";

  const messages = [
    {
      role: "system",
      content: systemPrompt()
    },
    {
      role: "system",
      content:
        'When a tool result directly answers the question, answer from the tool result exactly and do not say "no data" unless the tool result has null or empty data.'
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
      reply: "I could not generate a response.",
      context_used: {}
    };
  }

  if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
    return {
      reply: assistantMessage.content || "I could not generate a response.",
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

    console.log("Tool requested:", toolName);
    console.log("Parsed args:", parsedArgs);

    const impl = TOOL_IMPL[toolName];
    if (!impl) continue;

    const result = await impl(parsedArgs);
    console.log("Tool result:", JSON.stringify(result, null, 2));
    toolResults[toolName] = result;

    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(result)
    });
  }

  const finalResponse = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    temperature: 0.2,
    messages
  });

  return {
    reply:
      finalResponse.choices?.[0]?.message?.content ||
      "I could not generate a response.",
    context_used: toolResults
  };
}

module.exports = {
  generateOwnerReply
};
