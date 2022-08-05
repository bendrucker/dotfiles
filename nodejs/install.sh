#!/usr/bin/env sh

if ! asdf plugin list --urls | grep github.com/asdf-vm/asdf-nodejs ; then
    asdf plugin add nodejs https://github.com/asdf-vm/asdf-nodejs.git
else
    asdf plugin update nodejs
fi
