"""
Imagen 4 Ultra generator for the one generated asset this site ships.

`apps/web/src/app/opengraph-image.jpg` carries four measured figures. When
`pnpm eval` changes them the card is wrong, and a card that cannot be
regenerated is a number the repo cannot reproduce — which is the one thing this
project does not allow. So the generator lives here rather than in a scratchpad,
even though docs/public-launch-prompt.md put design tooling outside the repo:
that rule was about design *references*, and this is a build step for a
committed asset.

Regenerating the card, from the repo root:

    export VERTEX_API_KEY=...        # or leave GEMINI_API_KEY in .env
    python3 scripts/brand/imagen.py og-paper 16:9 "<the prompt below>"
    # then composite the real type over it, which is the half a model must not do:
    #   1. point scripts/brand/og-card.html at the generated plate
    #   2. render it at 1200x630 with a real browser, e.g.
    #      npx playwright screenshot --viewport-size=1200,630 \
    #        file://$PWD/scripts/brand/og-card.html /tmp/og.png
    #   3. sips -s format jpeg -s formatOptions 86 /tmp/og.png \
    #        --out apps/web/src/app/opengraph-image.jpg

The plate prompt that produced the shipped card:

    A sheet of aged manila ledger paper photographed flat from directly
    overhead under soft even north-facing daylight. Faint printed reddish-brown
    hairline rules running horizontally, one vertical column rule near the right
    edge. Visible laid paper fibre and grain, one soft crease, slightly darker
    along one edge. Warm pale cream, uncoated and matte. Completely blank: no
    writing, no text, no numbers, no letters, no objects, no hands, no shadows
    of objects.

The model generates material and never lettering. It renders type that is
almost right, and almost right on a wordmark is worse than no image; the browser
sets every glyph in the real Source Serif 4. A photographed *book* was also
generated and rejected — page curvature and a cast shadow break the Flat Rule in
apps/web/DESIGN.md, and the model set the word AMOUNTS into it.

Needs `pip install google-genai`. The key never touches a command line or
stdout. Generations are cached by filename, so re-running is free.

    python3 scripts/brand/imagen.py <name> <aspect> "<prompt>"
"""

import os
import sys
from pathlib import Path

from google import genai
from google.genai import types

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / ".brand-out"
OUT.mkdir(exist_ok=True)

PRIMARY = "imagen-4.0-ultra-generate-001"
FALLBACK = "imagen-4.0-generate-001"


def load_key() -> str:
    for name in ("VERTEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = os.environ.get(name)
        if value:
            return value
    env = REPO / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() in ("VERTEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
                return value.split("#")[0].strip().strip("'\"")
    raise SystemExit("no API key found in the environment or .env")


def client_for(key: str):
    # A Vertex AI Express key needs vertexai=True; a plain Gemini key does not.
    # Try Vertex first per the deployment this repo already uses, then fall back.
    return [
        genai.Client(vertexai=True, api_key=key),
        genai.Client(api_key=key),
    ]


def generate(name: str, prompt: str, aspect_ratio: str = "1:1") -> Path:
    dest = OUT / f"{name}.png"
    if dest.exists():
        print(f"cached {dest}")
        return dest

    key = load_key()
    last = None
    for client in client_for(key):
        for model in (PRIMARY, FALLBACK):
            try:
                result = client.models.generate_images(
                    model=model,
                    prompt=prompt,
                    config=types.GenerateImagesConfig(
                        number_of_images=1,
                        aspect_ratio=aspect_ratio,
                        safety_filter_level="BLOCK_LOW_AND_ABOVE",
                        person_generation="DONT_ALLOW",
                    ),
                )
            except Exception as exc:  # noqa: BLE001 - report and try the next path
                last = f"{model}: {type(exc).__name__}: {exc}"
                continue
            if not result.generated_images:
                last = f"{model}: no image returned"
                continue
            dest.write_bytes(result.generated_images[0].image.image_bytes)
            print(f"wrote {dest} via {model}")
            return dest
    raise SystemExit(f"generation failed. last error -> {last}")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise SystemExit('usage: imagen_gen.py <name> <aspect> "<prompt>"')
    generate(sys.argv[1], sys.argv[3], sys.argv[2])
