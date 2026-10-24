# PipelinePulse notes

A CI pipeline health and cost studio for the Syntax Summit hackathon (DevOps and AI/ML themes). Static single page app: vanilla HTML, CSS and JavaScript, zero dependencies, GitHub Pages deployable. Built by Aariv Patel.

## What was built

Open `index.html` and the studio runs entirely in the page. Pick one of two synthetic fixtures or paste any GitHub Actions style workflow into the textarea, then read five panels:

1. **Pipeline map.** The job graph drawn on a canvas, one column per topological wave, hairline dependency edges, the critical path in the signal green accent with a slow pulse traveling it while the page rests. Clicking a node or the job chips below (the keyboard and screen reader path) selects a job and opens its detail: needs, matrix combinations, steps, median and p90, queue estimate, billable minutes and failure rate.
2. **Duration math.** Per job median, p90, queue estimate, wall clock and share of the run. Queue time comes from a discrete slot simulation: waves run in topological order, each matrix combination is an independent unit, units schedule longest first onto an editable runner pool (default 20), each unit pays a stated bootstrap allowance. The critical path is the longest chain of job medians through the needs graph and equals the simulated wall clock when nobody queues.
3. **Cost model.** Billable minutes per job per matrix combination (whole minutes, rounded up, the way per job billing works) priced from an editable rate table preset to the public hosted runner list prices (Linux 0.008, Windows 0.016, macOS 0.08 dollars per minute). Runs per day and days per month are editable and drive the monthly projection, with a p90 variant as an upper bound. Cache hit rate, misses per run, median seconds saved on a hit and miss exposure per run are computed from the fixture history.
4. **Failure patterns.** A deterministic analyzer over the fixture run logs. Failure messages normalize into signatures (numbers, hashes and casing collapse), so one recurring error stays one cluster even across matrix combinations. Retry recoveries inside a run separate flaky clusters from hard ones and produce a per job flakiness score. Failed attempts rank as the most expensive failing jobs by burned billable minutes.
5. **Savings bench.** Five rules turn the same history into priced proposals: recover cache misses, split the slowest matrix combination (wall clock falls, runner spend rises slightly, both stated), skip jobs whose watched paths were untouched, fail fast matrices that keep spending after a sibling fails, and cap hung tails with a timeout. Every suggestion is labeled an estimate and carries its assumptions; the total is explicitly an upper bound because the rules overlap.

The YAML subset parser is hand written in `js/yaml.js`: block mappings and sequences (at a deeper or equal indent), mapping items in sequences, inline arrays with nesting, quoted strings, numbers, booleans, null, comments and document markers. It refuses rather than guesses: tabs in indentation, missing colons, duplicate keys, unclosed quotes or arrays, block scalars, flow mappings, anchors and aliases, and stray indentation all come back as `ParseError` with a 1-based line number and a recovery hint. Workflow semantics (unknown needs, cycles, missing runs-on or steps, matrix.include, non array matrix axes) are validated in `js/model.js` with the same error shape. Tolerated unknown keys surface as warnings, for example the fixture's deliberate `if:` on docs-deploy.

With no run history (a pasted workflow), durations fall back to a stated per step estimate, costs still compute, and the history driven panels show honest empty states.

## Tests

Run with Node 18 or newer, no installs:

```
node --test tests/
```

Exact results on this machine (Node v26.8.1): **73 tests, 73 passing, 0 failing, 0 skipped, about 48 milliseconds total** (budget: under 30 seconds). The suite makes **234 assertion calls** across five files, comfortably over the 45 assertion minimum:

- `tests/yaml.test.js`: 24 tests, 57 assertion calls. Parser coverage: structures, scalar types, quoting and escapes, inline and block arrays, both sequence indent styles, mapping items in sequences, comments, document markers, and thirteen distinct error classes across eleven rejection tests, all with line numbers.
- `tests/pipeline.test.js`: 19 tests, 60 assertion calls. Model validation (unknown needs, cycles, self needs, missing runs-on or steps, matrix.include), matrix expansion, waves, quantiles, unit statistics from the fixture, the fallback estimator, the slot simulation (no queue at pool 20, queue at pool 1, monotonicity in pool size, determinism) and the critical path.
- `tests/cost.test.js`: 9 tests, 37 assertion calls. Runner kind mapping, whole minute rounding, per combination pricing, sum invariants, p90 bounds, rate edits flowing through, monthly projection, and cache accounting.
- `tests/failures.test.js`: 12 tests, 49 assertion calls. Signature normalization (numbers, hashes, casing, empty input), clustering across combinations, retry recovery versus hard failures, flakiness bounds, expensive failing ranking with exact fixture minutes, failure rates counting runs not attempts, cancelled attempts, and empty histories.
- `tests/savings.test.js`: 9 tests, 31 assertion calls. Glob matching, every rule firing on the fixture, the estimate math checked against hand computed values, the critical path gating of the split rule, fail-fast gating, upper bound totals, and an empty history producing an empty bench.

All tests run offline in well under a second and touch no network.

## Honest caveats

- **All data is synthetic and written by hand.** The two fixture workflows and the 16 and 6 run histories are invented to exercise the analyzers deterministically. They are clearly labeled in the page, in the fixtures file, and in the panel copy.
- **The failure analyzer reads fixture attempt records, not raw GitHub log files.** A real integration would parse log text into the same message field; the clustering, flakiness and cost math already operate on that shape.
- **Duration statistics include failed attempts' minutes**, since failed attempts burn real runner time; this makes medians slightly pessimistic on jobs that fail early.
- **The queue model is a list scheduling simulation**, not GitHub's real queue. It is deterministic and explainable (longest first, earliest free slot, stated bootstrap) but real hosted runner queuing depends on plan concurrency, runner availability and job ordering that the model does not know.
- **Costs assume whole minute billing per job per combination** at the standard hosted runner rates preset in the UI. Real invoices depend on plan inclusions, per minute rounding changes, and any paid storage or artifacts, which the model does not cover. Every rate and cadence input is editable.
- **Savings numbers are estimates with stated assumptions, not measurements.** The cache rule treats saved seconds on hits as the price of a miss and assumes misses are fully avoidable; the path filter rule proposes watch patterns that are not in the workflow and counts only the job's own minutes (downstream savings uncounted); the split rule assumes two equal shards plus a stated overhead; the timeout rule assumes runs past the cap are hung and that a retry lands near the median. The bench total says in the page that the rules overlap and it is an upper bound.
- **No browser was opened during this build** (a hard constraint of the working setup), so visual verification was done by computed contrast ratios on the token palette (all text pairs pass WCAG AA, component boundaries pass 3:1), an id cross-check between the markup and the wiring, syntax checks on every script, and data path smokes of both fixtures, a custom paste and an error case. The canvas renderer is exercised by review and the shared math is tested, but no screenshot was captured.
- `strategy.matrix.include` and `.exclude`, reusable workflows, containers, services, outputs, and block scalars are outside the subset by design and produce clear parse errors or warnings rather than silent misreads.

## Five Devpost bullets

- A hand written YAML subset parser with line numbered, recovery oriented errors: tabs, duplicate keys, unclosed arrays, block scalars and matrix.include all refuse loudly instead of guessing, so editing the workflow in the textarea feels like a tool, not a demo.
- Real pipeline math, not vibes: topological waves, a longest path critical chain, and a deterministic slot simulation that turns an editable runner pool into visible queue time, with whole minute per combination billing on top.
- Failure analysis that clusters by normalized error signature across matrix combinations, separates flaky retry recoveries from hard failures, and ranks failing jobs by the billable minutes they burned.
- A savings bench where every suggestion carries its number and its assumptions in the same view, including one rule that honestly reports a cost increase (matrix splitting trades a little runner spend for faster feedback).
- Zero dependencies, zero network, zero build step: one HTML file and plain script files, 73 passing tests in about 48 milliseconds, deployable by dropping the folder on GitHub Pages.

## Layout of this folder

```
index.html        the studio, one page
tokens.css        locked design tokens (colors, type, spacing, motion)
styles.css        the whole visual system, terminal telemetry direction
js/yaml.js        YAML subset parser
js/model.js       workflow validation, needs graph, waves, matrix expansion
js/duration.js    quantiles, unit statistics, slot simulation, critical path
js/cost.js        rate table, billable minutes, monthly projection, cache stats
js/failures.js    signature normalization, clustering, flakiness, ranking
js/savings.js     the five priced rules and the bench
js/fixtures.js    the two synthetic workflows and run histories
js/graph.js       canvas pipeline map with the critical path pulse
js/app.js         DOM wiring, controls, rendering
tests/            five node:test files, 73 tests, 234 assertion calls
```
