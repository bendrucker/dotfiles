#!/usr/bin/env bash

csr () {
  if [ $# -eq 0 ]; then
    echo "usage: csr <name>"
    exit 1
  fi

  cd "$HOME/Desktop"
  mkdir "certificate-$1"
  cd "$_"

  _create_private_key "$1"
  _create_csr "$1" "${@:2}"

  pbcopy < "$1"
  echo "Copied CSR for $1 to clipboard"
}

# self signed cert
ssc () {
  openssl req -x509 -days 90 -in "$1.csr" -key "$1.key" -out "$1.crt"
}

_create_private_key () {
  openssl genrsa -out "$1.key" 2048
}

_create_csr () {
  openssl req -new -sha256 -key "$1.key" -out "$1.csr" "${@:2}"
}