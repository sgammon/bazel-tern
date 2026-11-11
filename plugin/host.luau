-- Shell startup is scoped to panes created while this plugin is enabled.
tern.on("spawn", function(spec)
    local name = string.match(spec.program, "([^/]+)$") or spec.program
    if name ~= "zsh" and name ~= "-zsh" then return nil end
    spec.env.TERN_BAZEL_ROOT = tern.plugin.dir
    spec.env.TERN_BAZEL_ORIGINAL_ZDOTDIR = spec.env.ZDOTDIR or tern.getenv("ZDOTDIR") or tern.getenv("HOME") or ""
    spec.env.ZDOTDIR = tern.plugin.dir .. "/zsh"
    return spec
end)
