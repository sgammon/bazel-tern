# Source the user's original startup file in its original ZDOTDIR context.
# Preserve changes to ZDOTDIR made by their startup files (including Tern's).
ZDOTDIR=${TERN_BAZEL_ORIGINAL_ZDOTDIR:-$HOME}
if [[ -r "$ZDOTDIR/$_tern_bazel_startup" && "$ZDOTDIR" != "$TERN_BAZEL_ROOT/zsh" ]]; then
  source "$ZDOTDIR/$_tern_bazel_startup"
fi
export TERN_BAZEL_ORIGINAL_ZDOTDIR=${ZDOTDIR:-$HOME}
export ZDOTDIR="$TERN_BAZEL_ROOT/zsh"
unset _tern_bazel_startup
