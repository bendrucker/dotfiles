#!/usr/bin/env sh

# http://www.thelinuxrain.com/articles/how-to-kill-blank-lines-elegantly
alias sqlformat="sqlformat - --reindent --reindent_aligned --keywords lower | awk NF"