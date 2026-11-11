# tern-bazel

Bazel builds and tests as a native [Tern Surface Protocol](https://docs.stencil.so/tern/protocol/) dashboard. Uses the official TypeScript SDK. Works alongside BuildBuddy without proxying its event stream.

## Install as a Tern plugin

The installable package is `release/bazel`. It contains the dashboard and SDK bundled together; no npm install is needed on the destination machine. Node.js 22+ must be on the shell's PATH.

```sh
tern plugin install /path/to/bazel
```

Open a **new Tern tab**, then use your ordinary commands:

```sh
bazel build //...
bazel test //...
bb test //...
```

No `.bazelrc` edits, Bazel profiles, global shell configuration edits, or separate helper installation are required. The plugin supplies a startup integration for **zsh**, scoped to new Tern panes. Your existing startup files are sourced normally. A simple executable alias such as `bazel=aspect` retains its executable. Existing custom functions and complex aliases take precedence; those need explicit integration rather than being silently replaced. Other shells can use the standalone `tern-bazel` command.

BuildBuddy's existing configuration and authentication continue to apply. Piped/noninteractive calls pass directly to the original executable. `TERN_TSP=0 bazel test //...` bypasses the dashboard. Disabling/removing the plugin takes effect in new tabs; existing shells keep their functions until closed.

For development or rebuilding the distributable:

```sh
npm ci
npm run package:plugin
npm run install:plugin
```

The standalone command remains available:

```sh
tern-bazel --demo build  # successful build visualization
tern-bazel --demo        # test visualization with a failure
tern-bazel --bazel bb -- test //...
```

The demos submit no builds. The build demo exits 0; the test demo deliberately exits 3 after simulating a failed test. Their invocation links and metrics are illustrative.

## During a long build

The layout adapts to the pane's width **and height**, reserving room for BuildBuddy, colored log output, and the command prompt. A bounded details area scrolls independently. Wide panes show metric tiles and native donut/area charts; compact panes use inline metrics, a labeled execution bar, and throughput sparklines. Charts only appear when their data is available; an idle or unobserved action stream does not get an empty chart.

While running, the dashboard prioritizes current activity, observed action progress, and test outcomes when relevant. Successful completion replaces live throughput with reported execution/cache results. Native expandable sections expose additional cache metrics, action-type breakdowns, and phase timings where reported. Phase timings are independent and may overlap. These disclosures and links remain usable after the process exits.

**Failures switch to diagnostics.** Throughput, cache charts, and performance tiles disappear. The first compiler/test errors and their context remain visible even if later progress has pushed them out of the ordinary log tail. Failed test log links are directly clickable. The footer indicates that the shell is ready, with space reserved for the actual prompt below. Cancellation uses the same compact handoff.

BuildBuddy cloud invocation URLs are recognized automatically. Failure shortcuts open Logs/Targets; success shortcuts open Cache/Timing, plus Executions when remote execution was reported. Compact panes show only the most relevant shortcut. For a self-hosted BuildBuddy instance, set `TERN_BAZEL_BUILDBUDDY=1` to enable these server-specific tabs. Unknown BES results servers keep their original invocation link without assuming BuildBuddy routes. AC/CAS cache rates and transfer volume from BuildBuddy's server are available through Cache; the plugin does not invent these from local process counts or require API credentials.

The bottom log retains ANSI colors (including colors continued across lines); More expands the tail within the available height, Pause freezes it, and Full log opens the raw log file. Keys: **p** pause/resume, **l** expand/compact, **Ctrl+C** interrupt. **Tab** switches live test filters. The final view stays in scrollback and contracts when the window shrinks. Changing only a horizontal split after exit cannot recompute the old pane-height budget; scroll that retained summary if needed. BuildBuddy, full-log, and test-log buttons use Tern's native open action, so normal clicks work after exit.

When Bazel emits `buildMetrics.actionSummary` (usually at completion), a compact execution distribution shows remote cache hits, remote executions, local executions, and disk cache hits where present. The local action-cache hit rate is hits / (hits + misses). Remote-cache share is remote cache hits / all reported non-internal processes, including unclassified runners. It is explicitly **not** the remote cache lookup hit rate; BEP does not provide that denominator here. Retry/dynamic execution can make process counts differ from unique action counts. Missing metrics are hidden, never fabricated as live zeroes.

## BuildBuddy compatibility

The wrapper adds `--build_event_json_file=<private temporary path>` after the Bazel command. In native mode it also requests `--color=yes --curses=no` so piped output retains colors without terminal cursor redraws; explicit command-line options later in your invocation take precedence. Bazel writes that local stream **while continuing to publish BES events to BuildBuddy**. Existing `--bes_backend`, `--bes_results_url`, invocation IDs, credentials, remote-cache settings, environment, `.bazelrc`, and argument ordering otherwise pass through unchanged. No additional BES service is installed.

The BuildBuddy link comes from the actual `/invocation/...` URL in Bazel/BuildBuddy's stdout, stderr, or BEP progress output, including self-hosted domains. It is not guessed from a remote-cache hostname. If the invocation URL isn't emitted, the header waits rather than inventing a link.

An explicit `--build_event_json_file` is respected and consumed in place. User-owned event files are not deleted. A JSON event file configured only in an rc file is overridden by the wrapper's local JSON path; binary/text BEP outputs and BES publishing are unaffected. A special path such as `/dev/null` cannot provide dashboard data: remove that flag or use a regular local file.

## Logs, performance, and limits

Full raw stdout/stderr is saved to `build.log` in a private `tern-bazel-*` temporary directory. The Full log link opens it. Set `TERN_BAZEL_LOG=/absolute/path/build.log` to choose a destination; its parent directory must exist. Each invocation truncates that chosen log file. Logs persist until you or the OS remove them; the wrapper deletes only its own BEP file at completion.

The UI holds the last 200 log lines and displays a height-bounded tail (up to 40 lines expanded), refreshes at most four times a second, and keeps at most 50 live test rows available. A separate bounded diagnostic buffer preserves early failures. The event file is read incrementally, not loaded in full. All discovered test/target summaries stay in memory for accurate counts. Very large workspaces therefore use memory proportional to their target count. Full logs and the live BEP file use disk proportional to output volume.

Action counts come from Bazel's progress text; they may be absent when progress output is disabled, and their denominator may grow. They are labeled as observed action progress, not a promise of overall completion or an ETA. Structured target/test results come from BEP. The wrapper doesn't infer individual action start times or show invented running jobs.

The Bazel exit code remains authoritative, including failures that occur before BEP starts. SIGINT/SIGTERM/SIGHUP are forwarded to the child process group on macOS/Linux. Native builds capture output through pipes rather than a PTY. Bazel color is requested explicitly; individual compiler tools may still suppress their own color unless configured to emit it.

## Development

```sh
npm test
npm run check
npm run build
npm run demo
```

Tests cover BuildBuddy argument preservation, UTF-8/partial event records, deduplicated test summaries, log bounds, invocation links, growing event files, subprocess output/exit forwarding, and cancellation. A real local Bazel build, a real passing/failing Bazel test pair, and headless Tern screenshots were also used during development. Authenticated remote BuildBuddy publishing has not been exercised in this checkout.
