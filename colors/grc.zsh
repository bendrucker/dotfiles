# grc (generic colorizer) for unix tools
if (( $+commands[grc] )) && (( $+commands[brew] ))
then
  source `brew --prefix`/etc/grc.zsh
fi
