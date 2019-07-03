call plug#begin('~/.vim/plugs')

" General

Plug 'Shougo/deoplete.nvim', { 'do': ':UpdateRemotePlugins' }

" Go

Plug 'fatih/vim-go', { 'do': ':GoUpdateBinaries' }
Plug 'zchee/deoplete-go', { 'do': 'make' }
Plug 'sebdah/vim-delve'

call plug#end()

if has('nvim')
  " Enable deoplete on startup
  let g:deoplete#enable_at_startup = 1
endif