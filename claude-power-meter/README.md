# Power meter for Claude Code

A Claude Code plugin that estimates how much electricity your session is
using on Anthropic's side, worked out from the tokens every model response
reports. It keeps a live figure under the prompt and prints a full account on
demand.

```
⚡ ≈12.4 Wh so far · last turn ≈3.2 Wh (≈210 W)
```

Anthropic publishes no energy figures for Claude, so every number here is an
estimate. The model behind it is simple, written down below, calibrated on the
public measurements that exist, and every coefficient can be changed in
`/config`. Treat the central figure as good to within a factor of about three.

## What you get

- **A status line** under the prompt, updated after every model response:
  energy so far, and either the turn in progress or the last turn with its
  average power while it ran.
- **`/power`**: energy so far with its plausible range, average watts while
  Claude works and over the whole session, the last turn, CO₂ at a grid
  intensity you set, everyday comparisons (phone charges, LED-bulb hours,
  microwave seconds, metres of electric driving, Google searches), and the
  token counts by model that the estimate rests on.
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
       + cache reads      × 0.005 )
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
- **Cache reads cost about half a percent.** A cached prefix is not
  recomputed; what remains is holding its key-value state and streaming it
  through the attention layers for every generated token. That is small per
  token but, in Claude Code, cache reads are over ninety percent of all
  tokens, so with this weight they still come to about a third of a typical
  request's energy. Published pricing puts a cache read at a hundredth to a
  two-hundredth of an output token; a back-of-envelope on key-value cache
  traffic for a 100,000-token context lands near one two-hundredth as well.
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
on the whole model: the session that wrote this plugin (a Fable-class model;
after three prompts, 14 responses, 127,000 output tokens, 349,000 cache
writes and 3.45 million cache reads) comes to about 640 Wh under these
defaults, roughly 210 Wh per prompt, inside Hausfather's range for agentic
coding.

### Reading the figures

- **Wh** (watt-hours) is energy: what you would be billed for. **W** (watts)
  is the rate: energy divided by time. A turn that uses 3 Wh in 55 seconds
  drew about 200 W while it ran, like a desktop PC under load.
- **While Claude works** divides the energy counted since the plugin loaded
  by the time the main loop spent in turns. **Whole session** divides it by
  the wall-clock time since then, idle minutes included. Responses read back
  from the transcript count toward the energy total but not toward these
  rates, because their timing is not known.
- **CO₂** uses the grid intensity you set, 400 g/kWh by default, roughly the
  US average; the EU average is lower. Where Anthropic's providers buy
  renewable power the market-based figure is lower still.
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
| `cache_read_fraction` | 0.005 | One cache-read input token, as a fraction of one output token |
| `grid_g_co2_per_kwh` | 400 | Grid carbon intensity for the CO₂ line |
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
`hooks/power-meter.ts` (the hooks module), `hooks/estimate.ts` (the energy
model and its formatting, pure functions), `types/index.d.ts` (the `$.state`
contract), `tests/` (run by `claude plugin test`).
