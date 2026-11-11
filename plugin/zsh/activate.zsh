# Keep executable aliases such as bazel=aspect, without changing the user's files.
if (( $+aliases[bazel] )) && [[ ${aliases[bazel]} != *[^a-zA-Z0-9_./-]* ]]; then
  export TERN_BAZEL_BAZEL_EXEC=${aliases[bazel]}
  unalias bazel
fi
if (( ! $+functions[bazel] && ! $+aliases[bazel] )); then
  function bazel { node "$TERN_BAZEL_ROOT/dispatch.mjs" "${TERN_BAZEL_BAZEL_EXEC:-bazel}" "$@"; }
fi
if (( ! $+functions[bazelisk] && ! $+aliases[bazelisk] )); then
  function bazelisk { node "$TERN_BAZEL_ROOT/dispatch.mjs" bazelisk "$@"; }
fi
if (( ! $+functions[bb] && ! $+aliases[bb] )); then
  function bb { node "$TERN_BAZEL_ROOT/dispatch.mjs" bb "$@"; }
fi
