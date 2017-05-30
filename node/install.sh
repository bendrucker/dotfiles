#!/usr/bin/env zsh

npm install --global $(cat "${0:a:h}/globals.txt" | tr '\n' ' ')