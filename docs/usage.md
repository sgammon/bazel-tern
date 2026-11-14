# tern-bazel

Bazel builds, tests, runs and queries as native [Tern Surface Protocol](https://docs.stencil.so/tern/protocol/) views. Uses the official TypeScript SDK. Works alongside BuildBuddy without proxying its event stream.

## Install as a Tern plugin

The installable package is `release/bazel`. It contains the dashboard and SDK bundled together; no npm install is needed on the destination machine. Node.js 22+ must be on the shell's PATH.

```sh
tern plugin install /path/to/bazel
```

Open a **new Tern tab**, then use your ordinary commands:

```sh
bazel build //...
bazel test //...
bazel run //app:server -- --port 8080
bazel query 'deps(//app:server)'
bb test //...
```

Other commands (`info`, `clean`, `aquery`, `mod`, …) run exactly as they would without the plugin.

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
tern-bazel --demo build  # successful build
tern-bazel --demo run    # build, then a program on the terminal
tern-bazel --demo query  # query results
tern-bazel --demo        # tests, with a failure
tern-bazel --bazel bb -- test //...
```

`tern-bazel --replay events.json test //...` plays a saved `--build_event_json_file` back through the page over a few seconds: a way to look at a real run again, or at how a large suite reads, without running it. The demos and replays run no Bazel commands. The build, run and query demos exit 0; the test demo deliberately exits 3 after simulating a failed test. Their invocation links and metrics are illustrative.

## During a long build

Every page reads the same way: a head row with the command, what it ran on, the elapsed time, the state and the links out; then up to four tiles; then the view. Color marks state only: a failed count is red, a finished build's numbers are not green.

The layout adapts to the pane's width **and height**, keeping the head row, the log window, and the command prompt in view. The area between them scrolls on its own when it has to. Wide panes show tiles and native donut/area charts; small panes use one line of metrics, a labeled execution bar, and a throughput sparkline. Charts only appear when their data is available; an idle or unobserved action stream does not get an empty chart.

While running, the page shows current activity, observed action progress, and a chart row that is live from the first results. For a build that is throughput (actions per second) and, until Bazel reports totals, **Running on**: the strategies named by its progress lines (`remote-cache`, `remote`, a sandbox, …). That is a sample of what was running, labeled as such, not a cache hit rate.

### Tests

A test run is a page of results, during the run and after it, whether or not everything passed. Only a build that broke (not tests that failed) is reduced to an error card.

- **Tiles:** tests finished of those discovered, pass rate, failed (the one red number), and how many results came from cache.
- **Results over time:** passed and failed as two lines, so a run that turns bad shows where.
- **Suite:** a grid of one hundred squares, each a hundredth of the suite: passed, failed, flaky, still to come.
- **Test cache:** where each result came from as it arrived: remote cache, local cache, or executed.
- **Areas:** with more than a dozen tests in more than one place, tests are grouped by area, worst first, with failed and passed counts and a pass bar. Areas are packages, or for a suite generated into one package (one target per case) the directories in the target names; the level is the first under what all tests share that gives a handful of groups. The selected area's tests are listed beside the table, failures first, with their durations and logs. **↑**/**↓** (or **k**/**j**) move the selection while the run is live; the summary left behind keeps the last one. Smaller suites list their tests directly, with a filter for failures.

Tests are counted as they report in, failed attempts at once, even while Bazel is still discovering more targets; the phase badge names the furthest stage reached rather than flipping back to Analyzing. Log buttons open logs Tern can reach: `file:` and `http(s):` addresses from the build events, otherwise the copy on this machine (the path in Bazel's `FAIL:` line, or `bazel-testlogs/<package>/<test>/test.log`). Remote blob addresses with no local copy are left to BuildBuddy's Logs tab. Beside the areas table, the selected area also shows the last lines of its first failing test's log when one is on disk.

Successful completion replaces the live row with reported results: execution mix, action types, and timings (analysis, execution, critical path, CPU time) where Bazel reports them. Phase timings are independent and may overlap. A small pane folds action types and timings into a section that opens with a click, including after the process has exited.

**A build that breaks switches to diagnostics.** Throughput, cache charts, and tiles give way to one error card: what failed, the exit status, and up to four problems read out of the output. Lines shaped like `file:line:col: error: message` (C/C++, stock `javac` and `kotlinc`, Go, `tsc`, and Bazel's own `BUILD` locations), and Elide's Kotlin and Java diagnostics (`error: kotlinc: message`, `In file: path:line:col`, then its source listing), become a severity badge, a link that opens the file at that line, the message, and the source around the line with it marked: the listing the tool printed (Elide), the file itself when it is readable from where Bazel was run, or otherwise the lines the compiler echoed under the message. What tools said about source comes first, Bazel's note of which target that broke last. Bazel's own output for those errors stays folded underneath, and is shown directly when nothing could be read out of it. The first errors are kept even if later progress has pushed them out of the log tail. Failed tests are listed with their log links, and the full log opens from the card's head. Cancellation uses the same card.

BuildBuddy cloud invocation URLs are recognized automatically and appear as one group of buttons in the head row. Failure shortcuts open Logs/Targets; success shortcuts open Cache/Timing, plus Executions when remote execution was reported. Small panes show the invocation and its most relevant tab. For a self-hosted BuildBuddy instance, set `TERN_BAZEL_BUILDBUDDY=1` to enable these server-specific tabs. Unknown BES results servers keep their original invocation link without assuming BuildBuddy routes. AC/CAS cache rates and transfer volume from BuildBuddy's server are available through Cache; the plugin does not invent these from local process counts or require API credentials.

**The build log stays out of the way until it is wanted.** It is one row: its newest line, beside Expand and Full log. Expand (**l**, or a click on the row) opens it in place of the tiles and the test list, keeping the chart row with throughput drawn as bars: whole lines, in Bazel's colors (including colors continued across lines), filling the height that is left. Open, it is a scroll area that follows new output until you scroll up; Follow (**p**) holds it still or lets it follow again, and Contract folds it back. In the summary left behind it is folded to its last line again, and a click still opens it, because the fold is Tern's and needs no running program. Full log opens the raw log file. **Ctrl+C** interrupts; **Tab** switches the live test filter. Keys are shown while the program can take them and are gone from the summary. The final view stays in scrollback and contracts when the window shrinks. BuildBuddy, full-log, and test-log buttons use Tern's native open action, so normal clicks work after exit.

When Bazel emits `buildMetrics.actionSummary` (usually at completion), the execution mix shows remote cache hits, remote executions, local executions, and disk cache hits where present. The **Action cache** tile is the local action-cache hit rate: hits / (hits + misses). The **Remote cache** tile is remote cache hits / all reported non-internal processes, including unclassified runners. It is explicitly **not** the remote cache lookup hit rate; BEP does not provide that denominator here. Retry/dynamic execution can make process counts differ from unique action counts. Missing metrics are hidden, never fabricated as live zeroes.

## `bazel run`

`run` builds with the page above, under its own name. When the build succeeds the page is replaced by one line (the target, the elapsed time, and what Bazel reports about actions, targets and the remote cache) and the program starts directly on the terminal: it reads your keystrokes, sees a real TTY on stdin, stdout and stderr, and its exit status is the command's. Ctrl+C goes to the program. If the build fails, the failure card is shown and nothing runs.

To do this the wrapper adds `--script_path=<private temporary path>`, so Bazel writes the launch script it would otherwise have executed, and then executes that script itself once the surface is closed. Arguments after `--`, `--run_under`, the runfiles directory and `BUILD_WORKSPACE_DIRECTORY`/`BUILD_WORKING_DIRECTORY` are what Bazel put in the script. A `--script_path` of your own, or `--norun`, is respected: the build is shown and nothing is launched. Outside Tern, with `--plain`, when piped, and on Windows, `run` is passed to Bazel untouched.

## `bazel query` and `cquery`

A query typed at the prompt shows its results as a table: target, kind, and for `cquery` the configuration, with tiles for targets, packages, rules and files and, in a wide pane, a breakdown by kind. Loading progress is shown while it runs and is not left behind. The table scrolls inside the pane; long labels are cut in the middle with the full label as the tooltip. **Open as text** opens the results as the lines the command would have printed.

When you give no `--output`, the wrapper asks for `--output=label_kind` so the table can say what each target is; the text results still hold plain labels. `--output=label`, `label_kind`, and for `query` `package`, are shown as given. Every other format (`build`, `graph`, `proto`, `json`, `files`, `starlark`, …), `--output_file`, NUL-separated output, `aquery`, and any query that is piped or redirected keep Bazel's own output, byte for byte. The table holds the first 1,000 results; the tiles count all of them and the text results hold all of them.

A query that fails shows Bazel's message in an error card. One that returns nothing says so. With `--keep_going`, partial results stay visible under a warning. The exit status is always Bazel's.

## BuildBuddy compatibility

The wrapper adds `--build_event_json_file=<private temporary path>` after your options (before any `--`). In native mode it also requests `--color=yes --curses=no` so piped output retains colors without terminal cursor redraws; explicit command-line options later in your invocation take precedence. Bazel writes that local stream **while continuing to publish BES events to BuildBuddy**. Existing `--bes_backend`, `--bes_results_url`, invocation IDs, credentials, remote-cache settings, environment, `.bazelrc`, and argument ordering otherwise pass through unchanged. No additional BES service is installed.

The BuildBuddy link comes from the actual `/invocation/...` URL in Bazel/BuildBuddy's stdout, stderr, or BEP progress output, including self-hosted domains. It is not guessed from a remote-cache hostname. If the invocation URL isn't emitted, the header waits rather than inventing a link.

An explicit `--build_event_json_file` on the command line is respected and consumed in place. User-owned event files are not deleted. A JSON event file configured in an rc file (directly or through a `--config`) is still written: the wrapper's flag goes last so its own file is the one Bazel writes, and when Bazel reports that another was asked for, the wrapper copies the finished stream there. Binary/text BEP outputs and BES publishing are unaffected. A special path such as `/dev/null` cannot provide dashboard data: remove that flag or use a regular local file.

## Logs, performance, and limits

Full raw stdout/stderr is saved to `build.log` in a private `tern-bazel-*` temporary directory. The Full log link opens it. Set `TERN_BAZEL_LOG=/absolute/path/build.log` to choose a destination; its parent directory must exist. Each invocation truncates that chosen log file. Logs persist until you or the OS remove them; the wrapper deletes only its own BEP file at completion.

The UI holds the last 200 to 300 log lines (trimmed a block at a time, so the log window is appended to rather than redrawn), shows a window of them sized to the pane, refreshes at most four times a second, and keeps at most 50 live test rows available. A separate bounded diagnostic buffer preserves early failures. The event file is read incrementally, not loaded in full. All discovered test/target summaries stay in memory for accurate counts. Very large workspaces therefore use memory proportional to their target count. Full logs and the live BEP file use disk proportional to output volume.

Action counts come from Bazel's progress text; they may be absent when progress output is disabled, and their denominator may grow. They are labeled as observed action progress, not a promise of overall completion or an ETA. Structured target/test results come from BEP. The wrapper doesn't infer individual action start times or show invented running jobs.

The Bazel exit code remains authoritative, including failures that occur before BEP starts. SIGINT/SIGTERM/SIGHUP are forwarded to the child process group on macOS/Linux. Native builds capture output through pipes rather than a PTY. Bazel color is requested explicitly; individual compiler tools may still suppress their own color unless configured to emit it.

## Development

```sh
npm test
npm run check
npm run build
npm run demo
```

Tests cover BuildBuddy argument preservation, UTF-8/partial event records, deduplicated test summaries, log bounds, invocation links, growing event files, subprocess output/exit forwarding, cancellation, run and query planning, query result parsing, and the shape of every page. Real local Bazel builds, runs (arguments, TTY, interactive input, exit status), queries and configured queries, a real passing/failing Bazel test pair, and headless Tern screenshots (`tern serve` with `tern ctl shot`) were also used during development. Authenticated remote BuildBuddy publishing has not been exercised in this checkout.
