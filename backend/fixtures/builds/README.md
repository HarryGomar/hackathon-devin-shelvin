# Recorded builds (`AGENT=scripted`)

One folder per site host (`domain_of`: lower case, no `www.`). Each holds what a builder leaves for the backend's gate:
`sources/<SOURCE>.py`, `fixtures/<SOURCE>/` (capture.json + expected.json) and `report.json` (the builder's structured
output, scraper-kit/devin/output.schema.json). `AGENT=scripted` copies them into the build's workspace and the
backend gates them like any build, live by default (`GATE_LIVE=0` for the offline checks only).

| Host | Source | Recording |
|---|---|---|
| `officedepot.com.mx` | `officedepot_mx` (page-only, `kit.generic.page` JSON-LD) | Written by hand; live gate 24/24 on Takis Fuego Barcel 56 gr, MXN 22.00 |
