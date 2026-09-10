// Cloudflare Pages Function — POST /api/generate
// Calls the Claude API server-side so ANTHROPIC_API_KEY never reaches the browser.
//
// This uses raw fetch() against the Messages API instead of the Anthropic SDK:
// Pages Functions here run with no build step / no package.json, so there's
// nothing to `npm install`. If this project ever grows a build step, switching
// to the official SDK (`@anthropic-ai/sdk`) would be a reasonable upgrade.

const MODEL = "claude-opus-5";

const PHYSICAL_GUIDANCE = `This is a physical, shippable item. The description can reference size, dimensions, and materials if the notes mention them. Lean the suggested_attributes toward material, primary_color, and size-relevant fields.`;

const DIGITAL_GUIDANCE = `This is a digital download — nothing is shipped. The description should mention instant download / file delivery where relevant. Also note in your own awareness (not required in the JSON) that Etsy digital listings don't support variations and must be listed separately from any physical version of the same design.`;

const SYSTEM_PROMPT = `You are an expert Etsy SEO copywriter. You will be shown a product photo and optional free-text notes from the seller. Write Etsy-ready listing copy.

Follow current Etsy guidance:
- Title: hard cap of 140 characters. Favor a short, clear, buyer-readable title over old-style keyword-stuffing. Put the most important keyword first. Don't repeat keywords. Don't pad the title to 140 characters just because you can.
- Tags: up to 13 tags, each hard-capped at 20 characters including spaces. Tags may include letters, numbers, spaces, apostrophes, hyphens, and accented characters. Don't repeat words already in the title unless a tag is meaningfully different (e.g. a synonym or related search term).
- Description: open with concrete product facts and natural keyword usage in the first sentences. Do not copy the title verbatim. Do not write a keyword dump.

Return STRICT JSON only. No markdown code fences, no preamble, no trailing commentary — just the JSON object, matching exactly this shape:

{
  "title": "string, under 140 characters",
  "description": "string, buyer-facing, concrete product facts in the first sentences",
  "tags": ["array of up to 13 strings, each under 20 characters"],
  "suggested_category": "string, best-guess Etsy category path, e.g. 'Home & Living > Storage & Organization'",
  "suggested_attributes": {
    "material": "string or null",
    "primary_color": "string or null",
    "who_its_for": "string or null",
    "occasion": "string or null",
    "style": "string or null"
  }
}`;

export async function onRequestPost({ request, env }) {
  // NOTE: no per-user rate limiting yet — this endpoint is protected only by
  // Cloudflare Access. If usage/abuse becomes a concern, this is the place to
  // add throttling (e.g. Cloudflare Rate Limiting rules, or a KV-backed
  // per-IP/per-user counter checked at the top of this function).

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  const { image, notes, productType } = body;

  if (!image || typeof image !== "string" || !image.startsWith("data:")) {
    return jsonError("A product photo is required.", 400);
  }
  if (productType !== "physical" && productType !== "digital") {
    return jsonError("Product type must be 'physical' or 'digital'.", 400);
  }

  const match = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/s);
  if (!match) {
    return jsonError("Couldn't read that image. Please try a different file.", 400);
  }
  const [, mediaType, base64Data] = match;

  const guidance = productType === "digital" ? DIGITAL_GUIDANCE : PHYSICAL_GUIDANCE;
  const notesText = notes && notes.trim() ? notes.trim() : "(no additional notes provided)";

  const userContent = [
    {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64Data },
    },
    {
      type: "text",
      text: `${guidance}\n\nSeller's notes:\n${notesText}\n\nReturn the JSON object described in your instructions, and nothing else.`,
    },
  ];

  if (!env.ANTHROPIC_API_KEY) {
    return jsonError("Server is missing its Anthropic API key.", 500);
  }

  let anthropicResponse;
  try {
    anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
  } catch {
    return jsonError("Couldn't reach Claude. Please try again.", 502);
  }

  if (!anthropicResponse.ok) {
    const errText = await anthropicResponse.text().catch(() => "");
    console.error("Anthropic API error:", anthropicResponse.status, errText);
    return jsonError("Claude couldn't generate a listing right now. Please try again.", 502);
  }

  const anthropicData = await anthropicResponse.json();

  if (anthropicData.stop_reason === "refusal") {
    return jsonError("Claude declined to generate copy for this image. Try a different photo or notes.", 422);
  }

  const textBlock = (anthropicData.content || []).find((block) => block.type === "text");
  if (!textBlock) {
    return jsonError("Claude returned an unexpected response. Please try again.", 502);
  }

  let listing;
  try {
    listing = JSON.parse(textBlock.text);
  } catch {
    console.error("Failed to parse Claude JSON:", textBlock.text);
    return jsonError("Claude's response wasn't valid JSON. Please try again.", 502);
  }

  return new Response(JSON.stringify(listing), {
    headers: { "content-type": "application/json" },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
