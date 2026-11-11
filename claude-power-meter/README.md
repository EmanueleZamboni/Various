# Power meter for Claude Code

A Claude Code plugin that estimates how much electricity your session is
using on Anthropic's side, worked out from the tokens every model response
reports. It keeps a live figure under the prompt and prints a full account on
demand.

```
⚡ ≈12.4 Wh so far · ≈5 g CO₂ · ≈25 mL water · last turn ≈3.2 Wh (≈210 W)
```

Anthropic publishes no energy figures for Claude, so every number here is an
estimate. The model behind it is simple, written down below, calibrated on the
public measurements that exist, and every coefficient can be changed in
`/config`. Treat the central figure as good to within a factor of about three.

## What you get

- **A line above the prompt**: the watt-hours used, the water, and their share of a one-person home's month, with a **More** button that opens the panel. Where that band is not drawn (the phone), the same line is the status line. Previously: **a status line** under the prompt, updated after every model response:
  energy so far, and either the turn in progress or the last turn with its
  average power while it ran.
- **A panel** beside the chat with the energy, the damage and a Reset button. It opens on its own where there is room, and with `/power`.
- **`/power`**: energy so far with its plausible range, average watts while
  Claude works and over the whole session, the last turn, CO₂ at a grid
  intensity you set, everyday comparisons (phone charges, LED-bulb hours,
  microwave seconds, metres of electric driving, Google searches), and the
  token counts by model that the estimate rests on.
- **This month, local Claude Code chats only**: `/power` and the panel add up every Claude Code
  chat on this computer this calendar month (main conversations and their
  subagents), read from the transcripts Claude Code keeps, refreshed every 10
  minutes. Chats in the web, phone or cloud sessions run elsewhere and are
  not on this computer, so they are not counted.
- **`/power reset`**: start the count over, to measure one task.
- **Resumed sessions** (`claude --resume`, `--continue`) and a plugin turned
  on mid-session read the responses already in the transcript file, so the
  total covers the whole conversation, not just what happened after the plugin
  loaded. Subagents' turns are counted too.

## Install

At the prompt of a terminal session:

```
/plugin install power-meter --marketplace EmanueleZamboni/Various
```

From a shell: `claude plugin install power-meter --marketplace EmanueleZamboni/Various`.
In the desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with `EmanueleZamboni/Various`,
then **Add plugin**.

### Always up to date, no restart

Run it from a git checkout instead of installing it. The plugin then pulls
its own updates from GitHub when a session starts and every 6 hours, and
Claude Code reloads it on the spot.

1. Clone the repository on its `main` branch, for example into your home folder:
   `git clone -b main https://github.com/EmanueleZamboni/Various.git`
2. If you installed it from the marketplace, remove that copy:
   `claude plugin uninstall power-meter@various`
3. In `~/.claude/settings.json` add (with the real path to the clone):
   ```json
   "env": {
     "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/Various/claude-power-meter",
     "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
   }
   ```
   The first line loads the plugin from the clone; the second makes the
   desktop app watch it too (a terminal session always does).
4. Restart Claude once. From then on updates arrive by themselves.

The `auto_update` setting turns the self-update off.

To run it from a checkout while developing: `claude --plugin-dir ./claude-power-meter`.

The plugin is a hooks module ("mod"), an early-access part of Claude Code: it
needs a 2.1.3xx build or later with function hooks, and runs with no network
access of its own.

## How the estimate works

Each API response reports four token counts. The plugin weights them into
output-token equivalents and multiplies by a per-model rate:

```
Wh = rate[model family] / 1000
     × ( output
       + uncached input   × 0.2
       + cache writes     × 0.2
       + cache reads      × 0.002
       + output × context ÷ 200,000 )
```

| Model family | Wh per 1,000 output tokens (default) |
|---|---|
| Haiku | 0.3 |
| Sonnet (and any model the plugin cannot classify) | 1 |
| Opus | 2 |
| Fable / Mythos | 3 |

Why the weights look like this:

- **Output tokens are the expensive ones.** They are generated one at a time,
  which keeps the accelerators waiting on memory rather than computing, so a
  generated token costs several times what the same token costs to read.
  Thinking tokens are generated tokens and are counted here.
- **Uncached input and cache writes cost about a fifth.** The prompt is
  processed in parallel at high utilisation. Writing it to the prompt cache is
  that same pass plus a store. Anthropic prices output at five times input,
  which points the same way.
- **Long chats cost more per token.** Every generated token re-reads the
  conversation's memory (the KV cache), so its cost grows with the context
  length. The plugin counts each response's output tokens times its context,
  so a token costs double at 200,000 tokens of context and triple at 400,000.
  Measurements show the growth depends on the model's design: memory-hungry
  attention grows steeply, compressed designs grow about 1.4 times over long
  contexts ([energy scaling across context lengths](https://arxiv.org/abs/2608.25096),
  [phase-aware decode energy](https://arxiv.org/abs/2605.11999)); an
  Epoch-style estimate puts one token at 100,000 tokens of context at 36 GB of
  memory reads for a model like Mistral Large 2 ([inference economics](https://arxiv.org/abs/2506.04645)).
  200,000 is the middle choice; set `context_doubling_tokens` to 0 to drop it.
- **Cache reads cost about a fifth of a percent** for handling the cached
  prefix once per request; the bigger cost of a long context is the
  re-reading above.
- **Model families scale the rate.** Anthropic does not say how big its
  models are. The defaults keep the tiers in the order Anthropic prices them,
  with a smaller spread than the prices, because serving cost is not
  proportional to price.

The rates include the data-centre overhead that the public measurements
include (host CPUs, idle machines, cooling). They do not include training,
your own computer, or the network between you and the model.

### Where the numbers come from

- Google measured a median Gemini Apps text prompt at **0.24 Wh** in May
  2025, split into 0.14 Wh for the accelerators, 0.06 Wh for host CPU and
  memory, 0.02 Wh for idle machines and 0.02 Wh for data-centre overhead; the
  narrow, accelerators-only boundary gives 0.10 Wh. ([blog](https://cloud.google.com/blog/products/infrastructure/measuring-the-environmental-impact-of-ai-inference), [paper](https://arxiv.org/abs/2508.15734))
- OpenAI's Sam Altman put the average ChatGPT query at **0.34 Wh** in June
  2025, with no methodology. ([post](https://blog.samaltman.com/the-gentle-singularity))
- Jegham et al., *How Hungry is AI?* (2025), estimate a short GPT-4o query at
  about **0.42 Wh** from hardware throughput, and put Claude 3.7 Sonnet higher. ([paper](https://arxiv.org/abs/2505.09598))
- Epoch AI estimates a typical GPT-4o query at about **0.3 Wh**, and their
  per-token range for large models spans roughly 0.1 to 2 Wh per 1,000
  output tokens. ([article](https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use))
- Zeke Hausfather logged eight weeks of his own Claude Code use (1,138
  prompts) and, with three conversion methods, estimated **about 170 kWh**
  (70 to 330 kWh), or **about 150 Wh per prompt** (60 to 290 Wh), noting that a
  prompt is a poor unit because an agentic turn runs many model requests. ([post](https://www.theclimatebrink.com/p/the-real-energy-use-of-agentic-ai))

A median chat response is a few hundred generated tokens, so the Google and
OpenAI figures put a mainstream model at roughly 0.5 to 1.5 Wh per 1,000
output tokens, overhead included; that is the Sonnet default of 1. As a check
on the whole model: the session that wrote this plugin (56 responses on
Fable- and Opus-class models, contexts up to about 300,000 tokens) comes to
about 2.1 kWh under these defaults, roughly 130 Wh per prompt, inside
Hausfather's 60 to 290 Wh range for agentic coding.

### Reading the figures

- **Wh** (watt-hours) is energy: what you would be billed for. **W** (watts)
  is the rate: energy divided by time. A turn that uses 3 Wh in 55 seconds
  drew about 200 W while it ran, like a desktop PC under load.
- **While Claude works** divides the energy counted since the plugin loaded
  by the time the main loop spent in turns. **Whole session** divides it by
  the wall-clock time since then, idle minutes included. Responses read back
  from the transcript count toward the energy total but not toward these
  rates, because their timing is not known.
- **CO₂** uses 450 g/kWh by default: the physical (location-based) intensity
  of the US regions Claude runs in. Claude runs on AWS (its main partner),
  Google Cloud TPUs and Microsoft Azure ([Anthropic](https://www.anthropic.com/news/google-broadcom-partnership-compute)).
  Google lists its US regions at 98 to 432 g/kWh ([Google Cloud](https://cloud.google.com/sustainability/region-carbon)),
  and a Harvard-led study found US data centres draw power at about 545 g/kWh
  against a 370 g/kWh national average ([review](https://www.themoonlight.io/en/review/assessing-the-carbon-emissions-and-energy-consumption-of-us-hyperscale-data-centers)).
  The providers' market-based figures, after renewable purchases, are lower.
- **Damage** turns the energy into three harms. CO₂ is energy times the grid
  intensity. Water is 1.7 mL per Wh by default: cooling takes about 0.12 mL per
  Wh at AWS ([Trellis](https://trellis.net/article/behind-amazons-industry-leading-water-efficiency-score/))
  and about 1.1 at Google (0.26 mL per 0.24 Wh prompt), about 0.45 blended,
  and US power plants evaporate about 1.25 mL per Wh ([Lee et al. 2018](https://ideas.repec.org/a/eee/appene/v210y2018icp661-672.html)). Climate cost prices the CO₂ at the social cost of
  carbon, $190 per tonne by default, the US EPA's 2023 central estimate of
  future damage from one more tonne emitted.
- **Homes**: a one-person home uses about 135 kWh of electricity a month in
  Europe (1,640 kWh a year, a Dutch estimate: [Keuze](https://www.keuze.nl/en/energy/average-power-consumption))
  and about 550 kWh in the US (the average US home uses about 10,300 kWh a
  year for about 2.5 people; one person uses roughly 60% of that). Neither
  region publishes an official single-person figure, so both are estimates.
- **Comparisons** use a 15 Wh phone battery, a 10 W LED bulb, a 1 kW
  microwave, an electric car at 170 Wh per km, and Google's 2009 figure of
  0.3 Wh per search.

## Settings

Each row appears in `/config` under **power-meter**; a change reloads the
plugin and applies to everything counted so far.

| Setting | Default | Meaning |
|---|---|---|
| `wh_per_1k_output_haiku` | 0.3 | Wh per 1,000 output tokens, Haiku-class |
| `wh_per_1k_output_sonnet` | 1 | Wh per 1,000 output tokens, Sonnet-class and unknown models |
| `wh_per_1k_output_opus` | 2 | Wh per 1,000 output tokens, Opus-class |
| `wh_per_1k_output_fable` | 3 | Wh per 1,000 output tokens, Fable- or Mythos-class |
| `input_fraction` | 0.2 | One uncached input token, as a fraction of one output token |
| `cache_write_fraction` | 0.2 | One cache-written input token, as a fraction of one output token |
| `cache_read_fraction` | 0.002 | One cache-read input token, as a fraction of one output token |
| `context_doubling_tokens` | 200000 | Context length at which a generated token costs double; 0 turns it off |
| `grid_g_co2_per_kwh` | 450 | Grid carbon intensity for the CO₂ line |
| `water_ml_per_wh` | 1.7 | Water per Wh, cooling plus power generation |
| `social_cost_usd_per_tonne` | 190 | Climate damage per tonne of CO₂, in US dollars |
| `auto_update` | true | Pull updates from GitHub when running from a git checkout |
| `show_status_line` | true | Keep the live figure under the prompt |

## Limitations

- It is an estimate. The public data points span about an order of
  magnitude, and none of them is a measurement of Claude. The plausible range
  shown with the total is one third to three times the central figure.
- It counts the electricity of the model requests this session made: the main
  loop and its subagents, live; and the main conversation's earlier responses
  from the transcript. It does not count training, your machine, the network,
  or other sessions.
- A transcript over 4 MiB is summed with `grep`, so on a machine without
  `grep` on the path (Windows without Git Bash) a long resumed session starts
  counting from the moment the plugin loads, and `/power` says so.
- Average watts are averages over turn time or wall-clock time, not readings
  from any meter.

## Development

```
claude plugin validate ./claude-power-meter
claude plugin test ./claude-power-meter
```

Layout: `.claude-plugin/plugin.json` (manifest and settings),
`hooks/power-meter.tsx` (the hooks module and its panel), `hooks/estimate.ts` (the energy
model and its formatting, pure functions), `types/index.d.ts` (the `$.state`
contract), `tests/` (run by `claude plugin test`).
