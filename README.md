# bazel-tern

Native Bazel build and test dashboards for [Tern](https://stencil.so/tern). Use your usual `bazel`, `bazelisk`, or `bb` commands—no `.bazelrc` changes required.

[Watch the 20-second demo](https://github.com/sgammon/bazel-tern/blob/main/media/tern-bazel-demo.mp4) · [Download the plugin](https://github.com/sgammon/bazel-tern/releases/latest) · [Full guide](docs/usage.md)

- **While building:** live throughput, action progress, contextual test results, and colored logs.
- **On success:** execution/cache charts, action types, and phase timings when Bazel reports them.
- **On failure:** preserved error details and test logs, with BuildBuddy and the returned shell prompt in view.
- **BuildBuddy friendly:** existing BES, authentication, remote execution, and cache settings pass through. Detected invocations get contextual shortcuts.

The layout adapts to the pane. Small panes use compact metrics and sparklines; wider panes get richer native charts.

## Install

Requires **Tern**, **Node.js 22+ on PATH**, and **zsh** for automatic integration.

Download [`bazel-tern-plugin.tar.gz`](https://github.com/sgammon/bazel-tern/releases/latest/download/bazel-tern-plugin.tar.gz), then:

```sh
tar -xzf bazel-tern-plugin.tar.gz
tern plugin install ./bazel
```

Open a **new Tern tab** and build normally:

```sh
bazel build //...
bazel test //...
bb test //...
```

Aliases such as `b='clear && bazelisk'` work. Piped/noninteractive commands pass through unchanged. Use `TERN_TSP=0` to bypass the dashboard. The archive bundles the JavaScript runtime code and SDK; no npm install is needed.

For self-hosted BuildBuddy, `TERN_BAZEL_BUILDBUDDY=1` enables its extra tab shortcuts. See the [guide](docs/usage.md) for shell compatibility, metrics definitions, and limitations.

## Develop

```sh
npm ci
npm test
npm run check
npm run install:plugin
```

Preview without submitting a build:

```sh
npm run demo -- build  # successful build
npm run demo          # failed test and shell handoff
```

The simulated test demo intentionally exits with status 3. The standalone helper is `tern-bazel`; build it with `npm run build` and use `npm link` to put it on PATH.

Built with the official [Tern TypeScript SDK](https://github.com/stencil-hq/tern-sdk). [Third-party notices](THIRD_PARTY_NOTICES.md).
