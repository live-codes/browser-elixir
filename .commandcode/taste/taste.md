# Taste

## Workflow

- Prefers to begin a new capability as a minimal, standalone proof-of-concept (e.g. a single simple HTML page) that proves feasibility, before integrating it into the main project. Confidence: 0.6

## Tooling / Architecture

- Favors solutions that run entirely client-side in the browser with no server or backend required. Confidence: 0.5
- Prefers large binaries/assets to be loaded from a GitHub-mirroring CDN (e.g. jsDelivr) rather than committed into the repo, with a configurable `baseUrl` so a different mirror can be pointed at. Confidence: 0.8
