# Terminal

Shell and terminal emulator configuration.

## Ghostty

`ghostty.config` sets the font, titlebar, selection rendering, shell
integration, and the Hyper+A keybind below. `symlinks.conf` maps it to
`~/.config/ghostty/config`. `install.sh` covers what a symlink cannot: the yazi
flavors and the iTerm2 preferences folder.

Ghostty draws a selection by inverting foreground and background rather than
tinting, so a selection reads the same whether herdr is intercepting the mouse
or Ghostty is. Holding Option while dragging bypasses herdr entirely and gives
the native terminal selection, which is what to use when herdr's own selection
would span panes.

Hyper+A sends the byte herdr's prefix is bound to, so the prefix is reachable
without a chord that collides with readline.

## Fonts

Ghostty renders `MonaspiceNe NFM`, installed by `font-monaspice-nerd-font`. The
cask covers everything `glyphs.conf` declares, including the Codicon brand marks
for Claude, OpenAI, and Cursor.

### Client Coverage

herdr emits bytes. The attached *client* picks the font. One session can
be attached from Ghostty on the Mac and Rootshell on an iPad at the same time,
so a glyph cannot be varied per client. The usable set is the intersection of
every client's coverage. That is why the font goes onto every client, rather
than holding the glyphs back to whatever the thinnest one already has.

Rootshell and Moshi both import a TTF/OTF. Upstream publishes Monaspace only as
a 269 MB `.zip` or an 18 MB `.tar.xz`, and iOS unpacks neither, so the four
styles are staged in iCloud Drive where the Files app can hand a single `.otf`
to an app:

```sh
dest="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Downloads/MonaspiceNe-NFM-3.5.0"
mkdir -p "$dest"
curl -sL "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.0/Monaspace.tar.xz" |
  tar -xJ -C "$dest" \
    MonaspiceNeNerdFontMono-Regular.otf MonaspiceNeNerdFontMono-Bold.otf \
    MonaspiceNeNerdFontMono-Italic.otf MonaspiceNeNerdFontMono-BoldItalic.otf
```

A re-import only matters when a codepoint new to a release turns up in
`glyphs.conf`.

### `glyphs.conf`

`glyphs.conf` declares every private-use glyph this repo renders, with the Nerd
Fonts name it comes from. `glyph-scan` fails when a tracked file uses a glyph
that is not declared, and `glyph-scan --font` fails when the installed font is
missing one that is. CI runs the first. `bin/glyph-scan.integration.test.ts`
runs both, skipping the second where the cask was not installed.
