_tern_bazel_startup=.zshrc
source "$TERN_BAZEL_ROOT/zsh/forward.zsh"
if [[ -o interactive ]]; then
  source "$TERN_BAZEL_ROOT/zsh/activate.zsh"
fi
