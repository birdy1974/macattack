import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      haUrl?: string;
      haToken?: string;
      haEntityId?: string;
    };

    const { haUrl, haToken, haEntityId } = body;

    if (!haUrl || !haToken) {
      return NextResponse.json(
        { error: "Home Assistant URL and token are required" },
        { status: 400 }
      );
    }

    // Test connection to Home Assistant API
    const apiUrl = `${haUrl.replace(/\/$/, "")}/api/`;
    
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${haToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Home Assistant API returned ${response.status}: ${response.statusText}` },
        { status: 400 }
      );
    }

    const data = await response.json() as { message?: string };
    
    // If entity ID is provided, test setting its state
    if (haEntityId) {
      const stateUrl = `${haUrl.replace(/\/$/, "")}/api/states/${haEntityId}`;
      const stateResponse = await fetch(stateUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${haToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: "0",
          attributes: {
            unit_of_measurement: "MACs",
            friendly_name: "MacAttack Found MACs",
            icon: "mdi:access-point-network",
            source: "macattack_test",
          },
        }),
      });

      if (!stateResponse.ok) {
        return NextResponse.json(
          { 
            success: true, 
            message: `Connected to Home Assistant (${data.message}), but could not update entity ${haEntityId}. Make sure the entity_id format is correct (e.g., sensor.macattack_found).`,
            warning: true,
          }
        );
      }

      return NextResponse.json({
        success: true,
        message: `Connected to Home Assistant and successfully updated entity ${haEntityId}`,
      });
    }

    return NextResponse.json({
      success: true,
      message: `Connected to Home Assistant: ${data.message}`,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to connect to Home Assistant",
      },
      { status: 500 }
    );
  }
}
