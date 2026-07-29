#!/bin/bash
# Nettoie les artefacts générés par les tests E2E (entry points + bundles)
rm -f "$(dirname "$0")"/.entry-*.ts "$(dirname "$0")"/.bundle-*.mjs
